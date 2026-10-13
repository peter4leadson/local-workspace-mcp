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
SECRET_FILE="$HOME/Library/Application Support/tunnel-client/secrets/control-plane-api-key"
PROFILE_FILE="$HOME/.config/tunnel-client/$ALIAS.yaml"
GIT_WORKSPACE_HINT="agent-tools"
EXPECTED_TOOLS=23
REQUIRED_MEDIA="fs_image fs_pdf_page fs_office_text"

fail=0
ok()   { echo "PASS $1"; }
bad()  { echo "FAIL $1"; fail=1; }
note() { echo "---- $1"; }

note "launchd agent"
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  ok "agent $LABEL registered"
  state="$(launchctl print "$DOMAIN/$LABEL" | sed -n 's/^[[:space:]]*state = //p' | head -1)"
  lastrc="$(launchctl print "$DOMAIN/$LABEL" | sed -n 's/^[[:space:]]*last exit code = //p' | head -1)"
  echo "     state=${state:-unknown} last_exit=${lastrc:-?}"
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

note "runtime process cardinality"
n_daemons="$(pgrep -fl "tunnel-client run --profile-dir $HOME/.config/tunnel-client --profile $ALIAS( |\$)" 2>/dev/null | wc -l | tr -d ' ')"
[ "$n_daemons" = "1" ] && ok "exactly one tunnel-client run process" \
  || bad "expected 1 tunnel-client run process, found $n_daemons"

note "credential posture"
if [ -f "$SECRET_FILE" ]; then
  perms="$(stat -f %Lp "$SECRET_FILE")"
  [ "$perms" = "600" ] && ok "secret file mode 600" || bad "secret file mode $perms (want 600)"
else
  bad "secret file missing: $SECRET_FILE"
fi
grep -q "\"api_key\": \"file:" "$PROFILE_FILE" 2>/dev/null \
  && ok "profile api_key is a file: ref" \
  || bad "profile api_key is not a file: ref (env: refs leak via process env)"
n_leak="$(pgrep -fl "^$TUNNEL_CLIENT run" | grep -c "sk-" || true)"
[ "$n_leak" = "0" ] && ok "no API key in daemon argv" \
  || bad "API key material visible in daemon argv ($n_leak process lines)"

note "workspace-mcp doctor"
if "$WORKSPACE_MCP" doctor >/dev/null 2>&1; then
  ok "workspace-mcp doctor all green"
else
  bad "workspace-mcp doctor reported failures"
fi

note "MCP stdio probe (tools/catalog + calls)"
/usr/bin/python3 - "$WORKSPACE_MCP" "$EXPECTED_TOOLS" "$GIT_WORKSPACE_HINT" $REQUIRED_MEDIA <<'PY'
import json, subprocess, sys

mcp, expected, hint = sys.argv[1], int(sys.argv[2]), sys.argv[3]
media = sys.argv[4:]
proc = subprocess.Popen(
    [mcp, "serve", "--stdio"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE,
    stderr=subprocess.DEVNULL, text=True,
)

def send(msg):
    proc.stdin.write(json.dumps(msg) + "\n")
    proc.stdin.flush()

def next_response(rid):
    # The server emits notifications interleaved with responses (e.g.
    # notifications/tools/list_changed); only a message with a matching
    # id is the response to this request.
    while True:
        line = proc.stdout.readline()
        if not line:
            return None
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        if msg.get("id") == rid:
            return msg

def call(rid, method, params):
    send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
    return next_response(rid)

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
    res = (r or {}).get("result", {})
    workspaces = (res.get("structuredContent") or {}).get("workspaces") or []
    ids = [w.get("id") for w in workspaces if w.get("id")]
    report(bool(ids), f"workspace_roots → {len(ids)} roots")

    # Prefer the hint workspace (this repo — guaranteed git), else the
    # first root on which git_status succeeds.
    ws = None
    ordered = ([hint] if hint in ids else []) + [i for i in ids if i != hint]
    r = call(4, "tools/call", {"name": "fs_list", "arguments": {"workspace": ordered[0] if ordered else "", "limit": 5}})
    okp = bool((r or {}).get("result")) and "error" not in (r or {})
    report(okp, f"fs_list(workspace={ordered[0]!r})" if ordered else "fs_list — no workspace")

    for cand in ordered:
        r = call(5, "tools/call", {"name": "git_status", "arguments": {"workspace": cand}})
        res = (r or {}).get("result", {})
        if res and not res.get("isError"):
            ws = cand
            break
    report(ws is not None, f"git_status(workspace={ws!r})" if ws else "git_status — no git workspace answered")
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
