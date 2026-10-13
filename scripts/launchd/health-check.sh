#!/bin/bash
# health-check.sh — one-shot verification of the full Local Workspace MCP
# connection chain:
#
#   launchd agent → tunnel-client managed runtime → health endpoints →
#   workspace-mcp stdio server → tool catalog + real tool calls
#
# Exit 0 = every check passed. Exit 1 = at least one failed (each line says
# PASS/FAIL so the first failure is obvious). Read-only: no state changes.

set -u
export PATH="/Users/petercbennett/.asdf/shims:/Users/petercbennett/.local/bin:/Users/petercbennett/Library/pnpm:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

LABEL="io.github.peter4leadson.local-workspace-mcp.tunnel"
ALIAS="local-workspace"
DOMAIN="gui/$(id -u)"
TUNNEL_CLIENT="/Users/petercbennett/.local/bin/tunnel-client"
WORKSPACE_MCP="/Users/petercbennett/.local/bin/workspace-mcp"
JQ="/usr/bin/jq"
EXPECTED_TOOLS=23
REQUIRED_MEDIA="fs_image fs_pdf_page fs_office_text"

fail=0
ok()   { echo "PASS $1"; }
bad()  { echo "FAIL $1"; fail=1; }
note() { echo "---- $1"; }

note "launchd agent"
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  ok "agent $LABEL registered"
  state="$(launchctl print "$DOMAIN/$LABEL" | grep -E '^\s*state =' | awk '{print $3}')"
  echo "     state=${state:-unknown}"
else
  bad "agent $LABEL not registered — run scripts/launchd/install.sh"
fi

note "tunnel-client managed runtime (alias=$ALIAS)"
st="$("$TUNNEL_CLIENT" runtimes status "$ALIAS" --json 2>/dev/null)"
if printf '%s' "$st" | "$JQ" -e . >/dev/null 2>&1; then
  for f in process_running healthy ready; do
    v="$(printf '%s' "$st" | "$JQ" -r ".$f // false")"
    [ "$v" = "true" ] && ok "runtimes status: $f=true" || bad "runtimes status: $f=$v"
  done
  tid="$(printf '%s' "$st" | "$JQ" -r '.tunnel_id // "?"')"
  hurl="$(printf '%s' "$st" | "$JQ" -r '.health_url // ""')"
  echo "     tunnel_id=$tid  health_url=$hurl"
else
  bad "runtimes status returned no JSON"
fi

note "workspace-mcp doctor"
if "$WORKSPACE_MCP" doctor >/dev/null 2>&1; then
  ok "workspace-mcp doctor all green"
else
  bad "workspace-mcp doctor reported failures"
fi

note "MCP stdio probe (tools/catalog + calls)"
/usr/bin/python3 - "$WORKSPACE_MCP" "$EXPECTED_TOOLS" $REQUIRED_MEDIA <<'PY'
import json, os, subprocess, sys

mcp, expected, media = sys.argv[1], int(sys.argv[2]), sys.argv[3:]
proc = subprocess.Popen(
    [mcp, "serve", "--stdio"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE,
    stderr=subprocess.DEVNULL, text=True,
)

def send(msg):
    proc.stdin.write(json.dumps(msg) + "\n")
    proc.stdin.flush()

def next_message():
    while True:
        line = proc.stdout.readline()
        if not line:
            return None
        line = line.strip()
        if not line:
            continue
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            continue

def call(rid, method, params):
    send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
    # Skip interleaved notifications; answer only the matching response id.
    while True:
        msg = next_message()
        if msg is None or msg.get("id") == rid:
            return msg

failed = False
def report(okp, label):
    global failed
    print(("PASS" if okp else "FAIL") + " " + label)
    if not okp:
        failed = True

try:
    r = call(1, "initialize", {
        "protocolVersion": "2025-06-18",
        "capabilities": {},
        "clientInfo": {"name": "launchd-health-check", "version": "0"},
    })
    info = (r or {}).get("result", {}).get("serverInfo", {})
    report(bool(info.get("name")), f"initialize → {info.get('name')} {info.get('version')}")

    send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    r = call(2, "tools/list", {})
    tools = [t["name"] for t in (r or {}).get("result", {}).get("tools", [])]
    report(len(tools) == expected, f"tools/list → {len(tools)} tools (expected {expected})")
    missing = [m for m in media if m not in tools]
    report(not missing, "media tools advertised: " + ", ".join(media) + ("" if not missing else f" (missing {missing})"))

    r = call(3, "tools/call", {"name": "workspace_roots", "arguments": {}})
    text = "".join(c.get("text", "") for c in (r or {}).get("result", {}).get("content", []))
    roots = []
    try:
        data = json.loads(text) if text.strip().startswith(("{", "[")) else {}
        roots = data.get("workspaces") or data.get("roots") or []
    except json.JSONDecodeError:
        pass
    report(bool(roots) or "workspace" in text, f"workspace_roots → {len(roots)} roots")

    def ws_id(w):
        return w.get("id") or w.get("name") or w.get("workspace")

    ids = [ws_id(w) for w in roots if ws_id(w)]
    # Workspace ids deliberately do not expose absolute paths; try likely git
    # roots first, then every advertised id, until git_status succeeds.
    preferred = [i for i in ("onramp", "golden-chassis", "agent-tools", "leadson-platform") if i in ids]
    candidates = preferred + [i for i in ids if i not in preferred]

    if ids:
        r = call(4, "tools/call", {"name": "fs_list", "arguments": {"workspace": ids[0], "path": ".", "limit": 5}})
        res = (r or {}).get("result", {})
        okp = bool(res) and not res.get("isError") and "error" not in (r or {})
        report(okp, f"fs_list(workspace={ids[0]!r})")

        git_ok, git_ws, git_err = False, None, ""
        for i, cand in enumerate(candidates[:8]):
            r = call(5 + i, "tools/call", {"name": "git_status", "arguments": {"workspace": cand}})
            res = (r or {}).get("result", {})
            if res and not res.get("isError") and "error" not in (r or {}):
                git_ok, git_ws = True, cand
                break
            git_err = "".join(c.get("text", "") for c in res.get("content", []))[:120]
        report(git_ok, f"git_status(workspace={git_ws!r})" if git_ok else f"git_status — all candidates failed ({git_err})")
    else:
        report(False, "no workspace root available for fs_list/git_status")
finally:
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()

sys.exit(1 if failed else 0)
PY
[ $? -ne 0 ] && fail=1

echo ""
if [ $fail -eq 0 ]; then
  echo "health-check: ALL GREEN"
else
  echo "health-check: FAILURES PRESENT"
fi
exit $fail
