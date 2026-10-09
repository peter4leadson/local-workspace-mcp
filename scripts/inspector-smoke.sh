#!/bin/sh
# Reproducible MCP Inspector smoke suite for local-workspace-mcp.
# Uses --cli mode; asserts expected outcomes for happy-path and adversarial calls.
# Usage: scripts/inspector-smoke.sh [workspace_id_for_git_tests]  (default: onramp)
set -u
cd "$(dirname "$0")/.."
WS="${1:-onramp}"
INSP="npx -y @modelcontextprotocol/inspector@2.9.0 --cli node dist/cli.js serve --stdio"
PASS=0; FAIL=0

call() { # name args...
  _name="$1"; shift
  $INSP --method tools/call --tool-name "$_name" "$@" 2>/dev/null
}

check() { # desc haystack needle
  case "$2" in
    *"$3"*) PASS=$((PASS+1)); echo "PASS  $1";;
    *) FAIL=$((FAIL+1)); echo "FAIL  $1"; echo "      got: $(echo "$2" | head -3)";;
  esac
}

check_not() { # desc haystack needle
  case "$2" in
    *"$3"*) FAIL=$((FAIL+1)); echo "FAIL  $1 (must not contain $3)"; echo "      got: $(echo "$2" | head -3)";;
    *) PASS=$((PASS+1)); echo "PASS  $1";;
  esac
}

echo "== discovery =="
TLIST=$($INSP --method tools/list 2>/dev/null)
check "14 tools advertised" "$(echo "$TLIST" | grep -c '"name"')" "14"
check "annotations present" "$TLIST" "readOnlyHint"

echo "== happy path =="
ROOTS=$(call workspace_roots)
check "workspace_roots lists $WS" "$ROOTS" "\"$WS\""
check "no absolute host path leaked" "$(echo "$ROOTS" | grep -cF "$HOME")" "0"

LIST=$(call fs_list --tool-arg workspace="$WS")
check "fs_list returns entries" "$LIST" '"entries"'

STATUS=$(call git_status --tool-arg workspace="$WS")
check "git_status returns branch/head" "$STATUS" '"head"'

TASKS=$(call task_list --tool-arg workspace="$WS")
check "task_list returns configured tasks" "$TASKS" '"taskId"'

echo "== adversarial =="
DENIED=$(call fs_read --tool-arg workspace="$WS" --tool-arg path=".git/config")
check ".git/config denied" "$DENIED" "ACCESS_DENIED"
check_not "no git internals leaked" "$DENIED" "url ="

DENIED2=$(call fs_read --tool-arg workspace="$WS" --tool-arg path=".env")
case "$DENIED2" in
  *ACCESS_DENIED*|*NOT_FOUND*) PASS=$((PASS+1)); echo "PASS  .env denied or absent";;
  *) FAIL=$((FAIL+1)); echo "FAIL  .env denied or absent"; echo "      got: $(echo "$DENIED2" | head -3)";;
esac

TRAV=$(call fs_read --tool-arg workspace="$WS" --tool-arg path="../../../../etc/passwd")
check "traversal rejected" "$TRAV" "OUTSIDE_ROOT"
check_not "no /etc/passwd content" "$TRAV" "root:x:0"

TRAV2=$(call fs_read --tool-arg workspace="$WS" --tool-arg path="deep/../../../../../etc/passwd")
check "nested traversal rejected" "$TRAV2" "OUTSIDE_ROOT"

UNKN=$(call fs_read --tool-arg workspace="nonexistent-ws" --tool-arg path="x")
check "unknown workspace rejected" "$UNKN" "UNKNOWN_WORKSPACE"

BADREF=$(call git_log --tool-arg workspace="$WS" --tool-arg ref="--all")
check "ref option injection rejected" "$BADREF" "INVALID_ARGUMENT"

BADREF2=$(call git_show --tool-arg workspace="$WS" --tool-arg spec='HEAD; echo pwned')
check "ref metachar rejected" "$BADREF2" "INVALID_ARGUMENT"

BADTASK=$(call task_run --tool-arg workspace="$WS" --tool-arg taskId="not-a-real-task")
check "unlisted task rejected" "$BADTASK" "TASK_DENIED"

echo
echo "smoke: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
