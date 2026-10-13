#!/bin/bash
# reconcile.sh — deterministic health reconciliation for the local-workspace
# tunnel-client managed runtime.
#
# Invoked by the per-user LaunchAgent
# io.github.peter4leadson.local-workspace-mcp.tunnel (RunAtLoad + StartInterval)
# and by install.sh for an immediate first pass. Safe to run by hand at any
# time: it never starts a second runtime while one is already alive.
#
# Exit contract:
#   0 = runtime is, or was brought to, process_running + healthy + ready
#   1 = reconciliation failed (detail on stdout; launchd captures it to the log)

set -u

# Minimal, explicit PATH. The managed runtime spawns `workspace-mcp`, whose
# launcher is a `#!/usr/bin/env node` script, so node (asdf shims), git, rg,
# and task executables (pnpm) must be resolvable here.
export PATH="/Users/petercbennett/.asdf/shims:/Users/petercbennett/.local/bin:/Users/petercbennett/Library/pnpm:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

ALIAS="local-workspace"
TUNNEL_CLIENT="/Users/petercbennett/.local/bin/tunnel-client"
MCP_COMMAND="/Users/petercbennett/.local/bin/workspace-mcp serve --stdio"
PROFILE="local-workspace"
PROFILE_DIR="/Users/petercbennett/.config/tunnel-client"
ADMIN_PROFILE="default"
KEYCHAIN_SERVICE="tunnel-client-control-plane"
KEYCHAIN_ACCOUNT="petercbennett"
JQ="/usr/bin/jq"

STATE_DIR="$HOME/Library/Application Support/local-workspace-mcp"
STATE_FILE="$STATE_DIR/reconcile.state"

# Consecutive unhealthy-but-alive checks tolerated before a controlled
# restart. At the 60 s StartInterval this is ~4 minutes — long enough for
# tunnel-client's own backoff to ride out transient network/platform
# outages, short enough to recover a wedged process.
MAX_TRANSIENT_CHECKS=4
READY_WAIT_S=60
STOP_SETTLE_S=2

mkdir -p "$STATE_DIR"

log() { printf '%s [reconcile] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }

field() { printf '%s' "$1" | "$JQ" -r "$2 // false" 2>/dev/null; }

read_counter() {
  local n
  n="$(cat "$STATE_FILE" 2>/dev/null)"
  case "$n" in (*[!0-9]*|'') echo 0 ;; (*) echo "$n" ;; esac
}
write_counter() { printf '%s' "$1" > "$STATE_FILE"; }

runtime_ready() {
  local st="$1"
  [ "$(field "$st" '.process_running')" = "true" ] \
    && [ "$(field "$st" '.healthy')" = "true" ] \
    && [ "$(field "$st" '.ready')" = "true" ]
}

connect_runtime() {
  local key rc waited st tunnel_id

  # Resolve the existing tunnel ID from the local alias record and attach to
  # it explicitly. Connecting with --tunnel-id requires no admin CRUD
  # (OPENAI_ADMIN_KEY is intentionally absent from this machine's runtime
  # path) and can never create a replacement tunnel.
  tunnel_id="$("$TUNNEL_CLIENT" runtimes list --json 2>/dev/null \
    | "$JQ" -r --arg a "$ALIAS" '.aliases[] | select(.alias == $a) | .tunnel_id // empty')"
  if [ -z "$tunnel_id" ]; then
    log "ERROR: could not resolve tunnel_id for alias=$ALIAS"
    return 1
  fi

  if ! key="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" -w 2>/dev/null)"; then
    log "ERROR: CONTROL_PLANE_API_KEY not retrievable from keychain (service=$KEYCHAIN_SERVICE account=$KEYCHAIN_ACCOUNT)"
    return 1
  fi
  export CONTROL_PLANE_API_KEY="$key"
  unset key

  log "connect: starting managed runtime (alias=$ALIAS tunnel_id=$tunnel_id)"
  "$TUNNEL_CLIENT" runtimes connect \
    --alias "$ALIAS" \
    --admin-profile "$ADMIN_PROFILE" \
    --profile "$PROFILE" \
    --profile-dir "$PROFILE_DIR" \
    --mcp-command "$MCP_COMMAND" \
    --tunnel-id "$tunnel_id" >/dev/null 2>&1
  rc=$?
  unset CONTROL_PLANE_API_KEY
  if [ $rc -ne 0 ]; then
    log "ERROR: runtimes connect exited $rc"
    return 1
  fi

  waited=0
  while [ $waited -lt $READY_WAIT_S ]; do
    sleep 5; waited=$((waited + 5))
    st="$("$TUNNEL_CLIENT" runtimes status "$ALIAS" --json 2>/dev/null)"
    if runtime_ready "$st"; then
      log "connect: runtime ready after ${waited}s"
      return 0
    fi
  done
  log "ERROR: runtime did not reach ready within ${READY_WAIT_S}s"
  return 1
}

main() {
  local st
  st="$("$TUNNEL_CLIENT" runtimes status "$ALIAS" --json 2>/dev/null)"
  if ! printf '%s' "$st" | "$JQ" -e . >/dev/null 2>&1; then
    log "ERROR: runtimes status produced no JSON; leaving state untouched"
    return 1
  fi

  if runtime_ready "$st"; then
    [ "$(read_counter)" != "0" ] && write_counter 0
    return 0
  fi

  if [ "$(field "$st" '.process_running')" = "true" ]; then
    # Alive but not healthy/ready. Distinguish transient outages (self-healing
    # backoff inside tunnel-client) from a genuinely wedged runtime: only a
    # persistent failure earns a restart, and the restart always stops the old
    # instance first — never a second process on the same tunnel ID.
    local n=$(( $(read_counter) + 1 ))
    write_counter "$n"
    if [ "$n" -lt "$MAX_TRANSIENT_CHECKS" ]; then
      log "runtime alive but not healthy/ready (${n}/${MAX_TRANSIENT_CHECKS}) — treating as transient"
      return 0
    fi
    log "runtime unhealthy for $n consecutive checks — controlled restart"
    "$TUNNEL_CLIENT" runtimes stop "$ALIAS" >/dev/null 2>&1
    sleep "$STOP_SETTLE_S"
    if connect_runtime; then write_counter 0; return 0; fi
    return 1
  fi

  # No live process: restart immediately.
  log "no running runtime — starting managed runtime"
  if connect_runtime; then write_counter 0; return 0; fi
  return 1
}

main "$@"
