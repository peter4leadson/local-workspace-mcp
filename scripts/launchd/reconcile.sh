#!/bin/bash
# reconcile.sh — deterministic health reconciliation for the local-workspace
# tunnel-client managed runtime.
#
# Invoked by the per-user LaunchAgent
# io.github.peter4leadson.local-workspace-mcp.tunnel (RunAtLoad + StartInterval).
# Safe to run by hand at any time: it never starts a second runtime while one
# is already alive.
#
# Exit contract:
#   0 = runtime is, or was brought to, process_running + healthy + ready
#   1 = reconciliation failed (detail on stdout; launchd captures it to the log)
#
# Secrets: the runtime API key is referenced from the tunnel profile as a
# `file:` ref (0600, under Application Support). No secret is read, exported,
# logged, or placed on any command line by this script. Re-asserting the
# `file:` ref on every connect also keeps the profile from drifting back to
# an `env:` ref when `runtimes connect` regenerates it.

set -u

# Minimal, explicit PATH. The managed runtime spawns `workspace-mcp`, whose
# launcher is a `#!/usr/bin/env node` script, so node, git, rg, and task
# executables must be resolvable here. install.sh bakes the caller-resolved
# tool dirs into the plist's EnvironmentVariables PATH; appending the
# inherited PATH keeps those resolved dirs (and manual-run PATHs) reachable
# without putting arbitrary dirs ahead of the pinned defaults.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

ALIAS="local-workspace"
TUNNEL_CLIENT="$(command -v tunnel-client 2>/dev/null || echo "$HOME/.local/bin/tunnel-client")"
MCP_COMMAND="$(command -v workspace-mcp 2>/dev/null || echo "$HOME/.local/bin/workspace-mcp") serve --stdio"
PROFILE="local-workspace"
PROFILE_DIR="$HOME/.config/tunnel-client"
ADMIN_PROFILE="default"
SECRET_FILE="$HOME/Library/Application Support/tunnel-client/secrets/control-plane-api-key"
API_KEY_REF="file:$SECRET_FILE"
JQ="$(command -v jq)"

# Fail fast with a legible error: without jq every status read below would
# degrade to "no JSON" and the failure mode would be unreadable in the log.
if [ -z "$JQ" ]; then
  printf '%s [reconcile] ERROR: jq not on PATH — cannot parse runtimes status\n' \
    "$(date '+%Y-%m-%dT%H:%M:%S%z')" >&2
  exit 1
fi

STATE_DIR="$HOME/Library/Application Support/local-workspace-mcp"
STATE_FILE="$STATE_DIR/reconcile.state"
LOCK_DIR="$STATE_DIR/reconcile.lock"

# Consecutive unhealthy-but-alive checks tolerated before a controlled
# restart. At the 60 s StartInterval this is ~4 minutes — long enough for
# tunnel-client's own backoff to ride out transient network/platform
# outages, short enough to recover a wedged process. Override via
# LOCAL_WORKSPACE_MAX_TRANSIENT_CHECKS (tests use a smaller value).
MAX_TRANSIENT_CHECKS="${LOCAL_WORKSPACE_MAX_TRANSIENT_CHECKS:-4}"
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

# Single-instance guard: launchd does not overlap runs of one job, but a
# manual invocation can race the agent. mkdir is atomic; a stale lock older
# than one reconcile window is taken over.
acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT
    return 0
  fi
  local mtime now
  mtime="$(stat -f %m "$LOCK_DIR" 2>/dev/null || true)"
  # Indeterminate age (stat failed) is not stale — do not take over a lock
  # we cannot prove old; that path could split-brain two live reconciles.
  [ -z "$mtime" ] && return 1
  now="$(date +%s)"
  if [ $((now - mtime)) -gt 180 ]; then
    rmdir "$LOCK_DIR" 2>/dev/null || true
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT
      log "took over stale reconcile lock"
      return 0
    fi
  fi
  return 1
}

runtime_ready() {
  local st="$1"
  [ "$(field "$st" '.process_running')" = "true" ] \
    && [ "$(field "$st" '.healthy')" = "true" ] \
    && [ "$(field "$st" '.ready')" = "true" ]
}

daemon_pids() {
  pgrep -f "tunnel-client run --profile-dir $PROFILE_DIR --profile $PROFILE( |$)" 2>/dev/null || true
}

# Stop the managed runtime, then guarantee no `tunnel-client run` for this
# profile survives: a suspended or wedged daemon can outlive `runtimes stop`
# and would keep the runtime lock, making the next `connect` fail. Resume
# (SIGCONT unblocks a stopped process so SIGKILL can land), then SIGKILL.
stop_runtime() {
  local pids pid waited
  "$TUNNEL_CLIENT" runtimes stop "$ALIAS" >/dev/null 2>&1
  sleep "$STOP_SETTLE_S"
  pids="$(daemon_pids)"
  [ -z "$pids" ] && return 0
  log "runtime process(es) survived runtimes stop ($pids) — force-killing"
  for pid in $pids; do kill -CONT "$pid" 2>/dev/null || true; done
  for pid in $pids; do kill -9 "$pid" 2>/dev/null || true; done
  waited=0
  while [ $waited -lt 10 ]; do
    [ -z "$(daemon_pids)" ] && return 0
    sleep 1; waited=$((waited + 1))
  done
  log "ERROR: tunnel-client run processes still alive after SIGKILL"
  return 1
}

# Validate everything a connect attempt needs BEFORE stopping a live
# daemon: a missing key file or alias record must fail the pass cleanly,
# never turn a limping runtime into a dead one.
TUNNEL_ID=""
preflight_connect() {
  [ -r "$SECRET_FILE" ] || {
    log "ERROR: runtime API key file missing/unreadable: $SECRET_FILE (run scripts/launchd/install.sh)"
    return 1
  }
  # Resolve the existing tunnel ID from the local alias record and attach to
  # it explicitly. Connecting with --tunnel-id requires no admin CRUD
  # (OPENAI_ADMIN_KEY is intentionally absent from this machine's runtime
  # path) and can never create a replacement tunnel.
  TUNNEL_ID="$("$TUNNEL_CLIENT" runtimes list --json 2>/dev/null \
    | "$JQ" -r --arg a "$ALIAS" '.aliases[] | select(.alias == $a) | .tunnel_id // empty')"
  if [ -z "$TUNNEL_ID" ]; then
    log "ERROR: could not resolve tunnel_id for alias=$ALIAS"
    return 1
  fi
}

connect_runtime() {
  local rc waited st tunnel_id="$TUNNEL_ID"

  log "connect: starting managed runtime (alias=$ALIAS tunnel_id=$tunnel_id)"
  "$TUNNEL_CLIENT" runtimes connect \
    --alias "$ALIAS" \
    --admin-profile "$ADMIN_PROFILE" \
    --profile "$PROFILE" \
    --profile-dir "$PROFILE_DIR" \
    --mcp-command "$MCP_COMMAND" \
    --tunnel-id "$tunnel_id" \
    --runtime-api-key "$API_KEY_REF" >/dev/null 2>&1
  rc=$?
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
  acquire_lock || return 0

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
    preflight_connect || return 1
    # If the old daemon cannot be reaped, do not connect: a surviving
    # process can hold or later re-acquire the runtime lock, and the
    # "never a second runtime on the same tunnel ID" invariant must be
    # enforced here, not merely hoped for inside connect.
    stop_runtime || return 1
    if connect_runtime; then write_counter 0; return 0; fi
    return 1
  fi

  # No live process: clean any stale daemon holding the lock, then start.
  log "no running runtime — starting managed runtime"
  preflight_connect || return 1
  stop_runtime || return 1
  if connect_runtime; then write_counter 0; return 0; fi
  return 1
}

main "$@"
