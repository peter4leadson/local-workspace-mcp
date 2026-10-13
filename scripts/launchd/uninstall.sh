#!/bin/bash
# uninstall.sh — remove the LaunchAgent persistence installed by install.sh.
#
# Default: remove persistence only. The currently running tunnel-client
# managed runtime is left untouched (rollback to the previous manual state).
# Pass --stop-runtime to also stop the managed runtime.
#
# Does NOT remove: the tunnel alias/profile, the remote tunnel, keychain
# credentials, logs, or the workspace-mcp server.

set -euo pipefail

LABEL="io.github.peter4leadson.local-workspace-mcp.tunnel"
ALIAS="local-workspace"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
TUNNEL_CLIENT="$HOME/.local/bin/tunnel-client"

stop_runtime=0
[ "${1:-}" = "--stop-runtime" ] && stop_runtime=1

if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$LABEL"
  echo "uninstall: agent $LABEL booted out"
else
  echo "uninstall: agent $LABEL not loaded"
fi

if [ -f "$PLIST" ]; then
  rm -f "$PLIST"
  echo "uninstall: removed $PLIST"
else
  echo "uninstall: no plist at $PLIST"
fi

if [ "$stop_runtime" -eq 1 ]; then
  "$TUNNEL_CLIENT" runtimes stop "$ALIAS" >/dev/null 2>&1 || true
  echo "uninstall: managed runtime for alias '$ALIAS' stopped"
else
  echo "uninstall: managed runtime left running (use --stop-runtime to stop it)"
fi

echo "uninstall: done — alias, tunnel, keychain item, secret file, and logs are untouched"
echo "uninstall: to also remove the runtime-key file: rm '$HOME/Library/Application Support/tunnel-client/secrets/control-plane-api-key'"
