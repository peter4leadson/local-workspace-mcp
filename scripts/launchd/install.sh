#!/bin/bash
# install.sh — install/refresh the per-user LaunchAgent that keeps the
# local-workspace tunnel-client runtime alive across login, app restarts,
# process death, network interruptions, and sleep/wake.
#
# Idempotent: re-running replaces the plist byte-for-byte, reloads the agent,
# and reconciles the runtime. It creates no duplicate agents, processes,
# tunnels, or listeners. Reuses the existing `local-workspace` alias and its
# tunnel ID; it never creates tunnels.
#
# Usage: scripts/launchd/install.sh

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
TUNNEL_CLIENT="/Users/petercbennett/.local/bin/tunnel-client"
WORKSPACE_MCP="/Users/petercbennett/.local/bin/workspace-mcp"
KEYCHAIN_SERVICE="tunnel-client-control-plane"
KEYCHAIN_ACCOUNT="petercbennett"
INTERVAL_S=60

fail() { echo "install: ERROR: $*" >&2; exit 1; }

# --- preflight -------------------------------------------------------------
[ -x "$RECONCILE" ] || fail "reconcile script missing: $RECONCILE"
[ -x "$TUNNEL_CLIENT" ] || fail "tunnel-client missing: $TUNNEL_CLIENT"
[ -x "$WORKSPACE_MCP" ] || fail "workspace-mcp missing: $WORKSPACE_MCP"
[ -x /usr/bin/jq ] || fail "/usr/bin/jq missing (needed by reconcile)"
[ -f "$HOME/.config/tunnel-client/$ALIAS.yaml" ] \
  || fail "tunnel profile missing: ~/.config/tunnel-client/$ALIAS.yaml"

"$TUNNEL_CLIENT" runtimes list --json 2>/dev/null \
  | /usr/bin/jq -e --arg a "$ALIAS" '.aliases[] | select(.alias == $a)' >/dev/null \
  || fail "alias '$ALIAS' not registered — create it once via tunnel-client runtimes create"

security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" -w >/dev/null 2>&1 \
  || fail "CONTROL_PLANE_API_KEY not in keychain (service=$KEYCHAIN_SERVICE account=$KEYCHAIN_ACCOUNT)"

TUNNEL_ID="$("$TUNNEL_CLIENT" runtimes list --json | /usr/bin/jq -r --arg a "$ALIAS" '.aliases[] | select(.alias == $a) | .tunnel_id')"

mkdir -p "$PLIST_DIR" "$LOG_DIR" "$STATE_DIR"

# --- plist (no secrets — the key never leaves the keychain-to-env path) ------
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
		<string>/Users/petercbennett/.asdf/shims:/Users/petercbennett/.local/bin:/Users/petercbennett/Library/pnpm:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
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
launchctl enable "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST" \
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
running="$(printf '%s' "$st" | /usr/bin/jq -r '.process_running // false' 2>/dev/null)"
healthy="$(printf '%s' "$st" | /usr/bin/jq -r '.healthy // false' 2>/dev/null)"
ready="$(printf '%s' "$st" | /usr/bin/jq -r '.ready // false' 2>/dev/null)"
echo "install: post-load state — process_running=$running healthy=$healthy ready=$ready"
if [ "$running" = "true" ] && [ "$healthy" = "true" ] && [ "$ready" = "true" ]; then
  echo "install: OK — managed runtime is up"
else
  echo "install: runtime not yet ready; reconcile will retry every ${INTERVAL_S}s (see log)"
fi
