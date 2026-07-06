#!/usr/bin/env bash
#
# ScyllaDB Alternator readiness + compatibility validator.
#
# Runs as a `helm test` Job. Flow:
#   PHASE 1  - wait (up to TIMEOUT_SECONDS) for the Alternator API to answer.
#   PHASE 2a - if it never comes up: dump Kubernetes diagnostics and exit 1.
#   PHASE 2b - if it comes up: run functional DynamoDB API tests against a
#              synthetic table and print a PASS/FAIL summary.
#
# NOTE: no `set -e` on purpose — we must control exit codes and always print
# the final summary even when individual steps fail.
set -uo pipefail

# ---------------------------------------------------------------------------
# Configuration (all provided by the Helm test Job spec)
# ---------------------------------------------------------------------------
SCYLLA_ENDPOINT="${SCYLLA_ENDPOINT:-http://scylladb:8000}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-1200}"
SCYLLA_SELECTOR="${SCYLLA_SELECTOR:-app.kubernetes.io/name=scylladb}"
NAMESPACE="${NAMESPACE:-default}"

# Alternator requires AWS-style credentials to be present but accepts any
# value. Provide harmless defaults in case the Job spec omits them.
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-readiness}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-readiness}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}"
# Never let the CLI page output inside a Job.
export AWS_PAGER=""

POLL_INTERVAL=10          # seconds between readiness probes
HEARTBEAT_EVERY=30        # seconds between heartbeat log lines

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------
# Colors are only enabled when stdout is a TTY, so `helm test --logs` output
# stays clean ASCII. The [PASS]/[FAIL] text markers are always present, so
# the output reads fine when pasted into email/Slack.
if [ -t 1 ]; then
  GREEN=$'\033[32m'
  RED=$'\033[31m'
  YELLOW=$'\033[33m'
  RESET=$'\033[0m'
else
  GREEN=""
  RED=""
  YELLOW=""
  RESET=""
fi

banner() {
  echo ""
  echo "============================================================"
  echo "== $*"
  echo "============================================================"
}

section() {
  echo ""
  echo "------------------------------------------------------------"
  echo "-- $*"
  echo "------------------------------------------------------------"
}

# ---------------------------------------------------------------------------
# Tool sanity checks (defensive: fail loudly, not cryptically)
# ---------------------------------------------------------------------------
MISSING_TOOLS=0
for tool in aws kubectl date mktemp; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "${RED}[FAIL]${RESET} required tool not found in image: $tool"
    MISSING_TOOLS=1
  fi
done
if [ "$MISSING_TOOLS" -ne 0 ]; then
  echo "RESULT: FAIL — validator image is missing required tools (see above)."
  exit 1
fi

# ---------------------------------------------------------------------------
# aws dynamodb wrapper — every call targets the Alternator endpoint
# ---------------------------------------------------------------------------
adyn() {
  aws dynamodb "$@" --endpoint-url "$SCYLLA_ENDPOINT" --no-cli-pager 2>&1
}

# ---------------------------------------------------------------------------
# PHASE 1 — wait for Alternator to become ready
# ---------------------------------------------------------------------------
banner "PHASE 1: waiting for ScyllaDB Alternator at ${SCYLLA_ENDPOINT} (timeout: ${TIMEOUT_SECONDS}s)"

START_TS=$(date +%s)
READY=0
LAST_HEARTBEAT=0
LAST_PROBE_OUTPUT=""

while true; do
  NOW=$(date +%s)
  ELAPSED=$(( NOW - START_TS ))
  REMAINING=$(( TIMEOUT_SECONDS - ELAPSED ))

  if [ "$ELAPSED" -ge "$TIMEOUT_SECONDS" ]; then
    break
  fi

  # Probe: any successful list-tables means the Alternator API is serving.
  if LAST_PROBE_OUTPUT=$(adyn list-tables); then
    READY=1
    break
  fi

  # Heartbeat roughly every HEARTBEAT_EVERY seconds so the log shows life.
  if [ $(( ELAPSED - LAST_HEARTBEAT )) -ge "$HEARTBEAT_EVERY" ] || [ "$ELAPSED" -eq 0 ]; then
    echo "${YELLOW}[WAIT]${RESET} Alternator not ready yet — elapsed ${ELAPSED}s, remaining ${REMAINING}s"
    LAST_HEARTBEAT=$ELAPSED
  fi

  sleep "$POLL_INTERVAL"
done

# ---------------------------------------------------------------------------
# PHASE 2a — timeout: dump Kubernetes diagnostics and fail
# ---------------------------------------------------------------------------
if [ "$READY" -ne 1 ]; then
  banner "SCYLLA DID NOT BECOME READY IN ${TIMEOUT_SECONDS}s — DIAGNOSTICS"
  echo "Last probe error from 'aws dynamodb list-tables':"
  echo "${LAST_PROBE_OUTPUT}"

  section "kubectl get pods,sts -l ${SCYLLA_SELECTOR} -o wide (namespace: ${NAMESPACE})"
  kubectl get pods,sts -n "$NAMESPACE" -l "$SCYLLA_SELECTOR" -o wide 2>&1 || true

  section "kubectl describe pod -l ${SCYLLA_SELECTOR}"
  kubectl describe pod -n "$NAMESPACE" -l "$SCYLLA_SELECTOR" 2>&1 || true

  section "Last 50 events in namespace ${NAMESPACE} (sorted by lastTimestamp)"
  kubectl get events -n "$NAMESPACE" --sort-by=.lastTimestamp 2>&1 | tail -n 50 || true

  section "ScyllaDB pod logs (last 200 lines, all containers)"
  PODS=$(kubectl get pods -n "$NAMESPACE" -l "$SCYLLA_SELECTOR" -o name 2>/dev/null || true)
  if [ -z "$PODS" ]; then
    echo "(no pods matched selector '${SCYLLA_SELECTOR}' in namespace '${NAMESPACE}')"
  else
    for pod in $PODS; do
      echo ""
      echo ">>> logs: ${pod}"
      kubectl logs -n "$NAMESPACE" "$pod" --tail=200 --all-containers=true 2>&1 || true
      echo ""
      echo ">>> previous logs (if the pod restarted): ${pod}"
      kubectl logs -n "$NAMESPACE" "$pod" --tail=200 --all-containers=true --previous 2>&1 || true
    done
  fi

  echo ""
  echo "${RED}RESULT: FAIL — ScyllaDB did not start. Send this entire output to your Arnica contact.${RESET}"
  exit 1
fi

# ---------------------------------------------------------------------------
# PHASE 2b — functional Alternator tests
# ---------------------------------------------------------------------------
ELAPSED=$(( $(date +%s) - START_TS ))
banner "ScyllaDB is up (after ${ELAPSED}s) — running functional Alternator tests"

# Synthetic, unique table name. No real customer data is ever read or written.
TABLE_NAME="readiness_check_${RANDOM}"
echo "Using synthetic test table: ${TABLE_NAME}"

PASS_COUNT=0
TOTAL_COUNT=0
FAILED_STEPS=""
CLEANUP_DONE=0

# check "<name>" <command...>
# Runs the command, captures its output, prints [PASS]/[FAIL] and updates
# the counters. Failed steps also print the captured error for diagnosis.
check() {
  local name="$1"
  shift
  TOTAL_COUNT=$(( TOTAL_COUNT + 1 ))
  local output
  if output=$("$@" 2>&1); then
    PASS_COUNT=$(( PASS_COUNT + 1 ))
    echo "${GREEN}[PASS]${RESET} ${name}"
    return 0
  else
    echo "${RED}[FAIL]${RESET} ${name}"
    echo "       error output:"
    # Indent the captured output for readability.
    echo "$output" | sed 's/^/       | /'
    FAILED_STEPS="${FAILED_STEPS}  - ${name}\n"
    return 1
  fi
}

# Cleanup: always attempt to delete the test table, even on early exit.
cleanup_table() {
  if [ "$CLEANUP_DONE" -eq 1 ]; then
    return 0
  fi
  CLEANUP_DONE=1
  adyn delete-table --table-name "$TABLE_NAME" >/dev/null 2>&1 || true
}
trap cleanup_table EXIT

# getItem helper: fetch item1 and assert the expected attribute value came back.
get_item_and_assert() {
  local out
  out=$(adyn get-item \
    --table-name "$TABLE_NAME" \
    --key '{"id": {"S": "item1"}}') || { echo "$out"; return 1; }
  if echo "$out" | grep -q "hello-from-arnica"; then
    return 0
  fi
  echo "get-item returned no matching item. Output was:"
  echo "$out"
  return 1
}

# query helper: KeyConditionExpression on id = item1, assert a result row.
query_and_assert() {
  local out
  out=$(adyn query \
    --table-name "$TABLE_NAME" \
    --key-condition-expression "id = :v" \
    --expression-attribute-values '{":v": {"S": "item1"}}') || { echo "$out"; return 1; }
  if echo "$out" | grep -q '"item1"'; then
    return 0
  fi
  echo "query returned no matching items. Output was:"
  echo "$out"
  return 1
}

# batchWriteItem helper: put 3 items in a single call.
batch_write_items() {
  adyn batch-write-item --request-items "{
    \"${TABLE_NAME}\": [
      {\"PutRequest\": {\"Item\": {\"id\": {\"S\": \"batch1\"}, \"payload\": {\"S\": \"b1\"}}}},
      {\"PutRequest\": {\"Item\": {\"id\": {\"S\": \"batch2\"}, \"payload\": {\"S\": \"b2\"}}}},
      {\"PutRequest\": {\"Item\": {\"id\": {\"S\": \"batch3\"}, \"payload\": {\"S\": \"b3\"}}}}
    ]
  }"
}

echo ""

# 1. createTable — partition key `id` (S), on-demand billing.
check "createTable" adyn create-table \
  --table-name "$TABLE_NAME" \
  --attribute-definitions AttributeName=id,AttributeType=S \
  --key-schema AttributeName=id,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST

# 2. wait for the table to become ACTIVE.
check "waitTableActive" adyn wait table-exists --table-name "$TABLE_NAME"

# 3. putItem — a synthetic item.
check "putItem" adyn put-item \
  --table-name "$TABLE_NAME" \
  --item '{"id": {"S": "item1"}, "payload": {"S": "hello-from-arnica"}}'

# 4. getItem — read it back and assert the attribute round-tripped.
check "getItem" get_item_and_assert

# 5. query — KeyConditionExpression on the partition key.
check "query" query_and_assert

# 6. batchWriteItem — multiple puts in one call.
check "batchWriteItem" batch_write_items

# 7. updateTimeToLive — often reveals Alternator feature gaps; its own step.
check "updateTimeToLive" adyn update-time-to-live \
  --table-name "$TABLE_NAME" \
  --time-to-live-specification "Enabled=true,AttributeName=ttl"

# 8. deleteTable — cleanup as an explicit, scored step.
if check "deleteTable" adyn delete-table --table-name "$TABLE_NAME"; then
  CLEANUP_DONE=1   # explicit delete succeeded; trap becomes a no-op
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
banner "== ScyllaDB Compat: ${PASS_COUNT}/${TOTAL_COUNT} PASS =="

if [ "$PASS_COUNT" -lt "$TOTAL_COUNT" ]; then
  echo ""
  echo "ERROR DIGEST — failed steps:"
  # shellcheck disable=SC2059  # FAILED_STEPS intentionally contains \n
  printf "${FAILED_STEPS}"
  echo ""
  echo "${RED}RESULT: FAIL — one or more Alternator compatibility checks failed.${RESET}"
  echo "Send this entire output to your Arnica contact."
  exit 1
fi

echo ""
echo "${GREEN}RESULT: PASS — cluster can run Arnica's ScyllaDB workload.${RESET}"
exit 0
