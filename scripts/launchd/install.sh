#!/bin/bash
# install.sh — install/refresh the per-user LaunchAgent that keeps the
# local-workspace tunnel-client runtime alive across login, app restarts,
# process death, network interruptions, and sleep/wake.
#
# Idempotent: re-running replaces the plist byte-for-byte, reloads the agent,
# re-asserts the profile `file:` API-key reference, and reconciles the
# runtime. It creates no duplicate agents, processes, tunnels, or listeners.
# Reuses the existing `local-workspace` alias and its tunnel ID; it never
# creates tunnels.
#
# Secret model: the runtime API key lives in the macOS keychain (service
# `tunnel-client-control-plane`). install.sh materializes it once into a
# 0600 file under Application Support and the tunnel profile references it
# via `file:` — so launchd needs no keychain ACL prompt, no secret is ever
# placed in the plist, agent environment, or logs, and `runtimes connect`
# keeps the `file:` ref instead of reverting to `env:`.
#
# Usage: scripts/launchd/install.sh [--refresh-secret]

set -euo pipefail

LABEL="io.github.peter4leadson.local-workspace-mcp.tunnel"
ALIAS="local-workspace"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RECONCILE="$REPO_ROOT/scripts/launchd/reconcile.sh"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST="$PLIST_DIR/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/local-workspace-mcp"
STATE_DIR="$HOME/Library/Application Support/local-workspace-mcp"
DOMAIN="gui/$(id -u)"
TUNNEL_CLIENT="$HOME/.local/bin/tunnel-client"
WORKSPACE_MCP="$HOME/.local/bin/workspace-mcp"
KEYCHAIN_SERVICE="tunnel-client-control-plane"
KEYCHAIN_ACCOUNT="${USER}"
SECRET_DIR="$HOME/Library/Application Support/tunnel-client/secrets"
SECRET_FILE="$SECRET_DIR/control-plane-api-key"
API_KEY_REF="file:$SECRET_FILE"
PROFILE_FILE="$HOME/.config/tunnel-client/$ALIAS.yaml"
INTERVAL_S=60

fail() { echo "install: ERROR: $*" >&2; exit 1; }

# --- preflight -------------------------------------------------------------
[ -x "$RECONCILE" ] || fail "reconcile script missing: $RECONCILE"
[ -x "$TUNNEL_CLIENT" ] || fail "tunnel-client missing: $TUNNEL_CLIENT"
[ -x "$WORKSPACE_MCP" ] || fail "workspace-mcp missing: $WORKSPACE_MCP"
command -v jq >/dev/null 2>&1 || fail "jq not on PATH (needed by reconcile)"
[ -f "$PROFILE_FILE" ] \
  || fail "tunnel profile missing: ~/.config/tunnel-client/$ALIAS.yaml"

"$TUNNEL_CLIENT" runtimes list --json 2>/dev/null \
  | jq -e --arg a "$ALIAS" '.aliases[] | select(.alias == $a)' >/dev/null \
  || fail "alias '$ALIAS' not registered — create it once via tunnel-client runtimes create"

# --- secret file (keychain → 0600 file → profile `file:` ref) ---------------
if [ "${1:-}" = "--refresh-secret" ] || [ ! -s "$SECRET_FILE" ]; then
  security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" -w >/dev/null 2>&1 \
    || fail "CONTROL_PLANE_API_KEY not in keychain (service=$KEYCHAIN_SERVICE account=$KEYCHAIN_ACCOUNT)"
  mkdir -p "$SECRET_DIR"
  chmod 700 "$SECRET_DIR"
  umask 077
  security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" -w > "$SECRET_FILE" \
    || fail "could not write $SECRET_FILE"
  chmod 600 "$SECRET_FILE"
  echo "install: secret materialized from keychain → $SECRET_FILE (0600)"
else
  [ -r "$SECRET_FILE" ] || fail "secret file unreadable: $SECRET_FILE"
  echo "install: secret file present (0600) — use --refresh-secret after key rotation"
fi

# Assert the profile carries the `file:` ref. `runtimes connect` rewrites
# the profile on every connect, so reconcile.sh re-asserts the ref via
# --runtime-api-key; this line covers manual `tunnel-client run` starts.
/usr/bin/python3 - "$PROFILE_FILE" "$API_KEY_REF" <<'PY' || fail "could not pin api_key file: ref in profile"
import re, sys
path, ref = sys.argv[1], sys.argv[2]
src = open(path).read()
new, n = re.subn(r'"api_key":\s*"[^"]*"', '"api_key": "%s"' % ref, src, count=1)
if n != 1:
    sys.exit(1)
if new != src:
    open(path, "w").write(new)
    print("install: profile api_key pinned to file: ref")
else:
    print("install: profile api_key already file: ref")
PY

TUNNEL_ID="$("$TUNNEL_CLIENT" runtimes list --json | jq -r --arg a "$ALIAS" '.aliases[] | select(.alias == $a) | .tunnel_id')"

mkdir -p "$PLIST_DIR" "$LOG_DIR" "$STATE_DIR"

# --- plist (no secrets — the key is a file: ref, never an env value) --------
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/bash</string>
		<string>$RECONCILE</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>$HOME/.asdf/shims:$HOME/.local/bin:$HOME/Library/pnpm:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>StartInterval</key>
	<integer>$INTERVAL_S</integer>
	<key>ProcessType</key>
	<string>Background</string>
	<key>StandardOutPath</key>
	<string>$LOG_DIR/reconcile.log</string>
	<key>StandardErrorPath</key>
	<string>$LOG_DIR/reconcile.error.log</string>
</dict>
</plist>
EOF
chmod 644 "$PLIST"

# --- (re)load ---------------------------------------------------------------
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null \
  || { launchctl enable "$DOMAIN/$LABEL" 2>/dev/null || true
       launchctl bootstrap "$DOMAIN" "$PLIST"; } \
  || fail "launchctl bootstrap failed for $LABEL"

# --- verify ------------------------------------------------------------------
sleep 2
launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 \
  || fail "agent not registered after bootstrap"

echo "install: agent bootstrapped — RunAtLoad pass in flight"
echo "  label:        $LABEL"
echo "  plist:        $PLIST"
echo "  alias:        $ALIAS (tunnel_id $TUNNEL_ID)"
echo "  interval:     ${INTERVAL_S}s"
echo "  reconcile:    $RECONCILE"
echo "  logs:         $LOG_DIR/reconcile{,.error}.log"
echo ""

# Give the RunAtLoad pass a head start, then report the reconciled state.
sleep 12
st="$("$TUNNEL_CLIENT" runtimes status "$ALIAS" --json 2>/dev/null || true)"
running="$(printf '%s' "$st" | jq -r '.process_running // false' 2>/dev/null)"
healthy="$(printf '%s' "$st" | jq -r '.healthy // false' 2>/dev/null)"
ready="$(printf '%s' "$st" | jq -r '.ready // false' 2>/dev/null)"
echo "install: post-load state — process_running=$running healthy=$healthy ready=$ready"
if [ "$running" = "true" ] && [ "$healthy" = "true" ] && [ "$ready" = "true" ]; then
  echo "install: OK — managed runtime is up"
else
  echo "install: runtime not yet ready; reconcile will retry every ${INTERVAL_S}s (see log)"
fi
