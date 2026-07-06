#!/usr/bin/env bash
#
# run-scenarios.sh — validate the readiness-check chart on a real cluster.
#
# Installs a set of scenarios (one healthy, several broken), runs `helm test`
# on each, and asserts the outcome matches expectation:
#   - the healthy scenario must PASS  (helm test exit 0)
#   - the broken scenarios must FAIL  (helm test non-zero + diagnostics packet)
# Each scenario runs in its own namespace and is torn down afterwards.
#
# Exit code: 0 only if every scenario's actual result matched its expectation.
#
# Env overrides:
#   CHART            chart ref to install            (default ".")
#   VALIDATOR_IMAGE  override validator.image        (default: chart's value)
#   PASS_TIMEOUT     readiness wait for happy path   (default 900s)
#   FAIL_TIMEOUT     readiness wait for broken cases (default 180s)
#   KEEP             if set, skip teardown (for debugging)
#
# Requires: helm 3.8+, kubectl pointed at the target cluster.
set -uo pipefail

CHART="${CHART:-.}"
PASS_TIMEOUT="${PASS_TIMEOUT:-900}"
FAIL_TIMEOUT="${FAIL_TIMEOUT:-180}"
VALIDATOR_IMAGE="${VALIDATOR_IMAGE:-}"
KEEP="${KEEP:-}"

# Optional image override applied to every install.
IMG_SET=()
if [ -n "$VALIDATOR_IMAGE" ]; then
  IMG_SET=(--set "validator.image=${VALIDATOR_IMAGE}")
fi

RESULTS=()   # "name|expected|actual|verdict"
OVERALL=0

banner() { echo; echo "############################################################"; echo "## $*"; echo "############################################################"; }

teardown() {
  local rel="$1" ns="$2"
  if [ -n "$KEEP" ]; then
    echo "KEEP set — leaving namespace ${ns} in place"
    return
  fi
  helm uninstall "$rel" -n "$ns" >/dev/null 2>&1 || true
  kubectl delete namespace "$ns" --ignore-not-found --wait=true >/dev/null 2>&1 || true
}

# run_scenario <id> <human name> <pass|fail> <timeout> [extra helm --set args...]
run_scenario() {
  local id="$1" name="$2" expect="$3" timeout="$4"; shift 4
  local extra=("$@")
  local rel="rc-${id}" ns="scylla-rc-${id}"

  banner "Scenario ${id}: ${name}  (expect: ${expect})"

  # Clean any leftover from a previous run.
  teardown "$rel" "$ns"

  echo ">> helm install ${rel} (ns=${ns}, timeout=${timeout}s)"
  if ! helm install "$rel" "$CHART" -n "$ns" --create-namespace \
        --set "validator.timeoutSeconds=${timeout}" \
        "${IMG_SET[@]}" "${extra[@]}"; then
    echo "!! helm install failed"
    RESULTS+=("${name}|${expect}|install-error|FAIL")
    OVERALL=1
    teardown "$rel" "$ns"
    return
  fi

  echo ">> helm test ${rel}"
  helm test "$rel" -n "$ns" --logs
  local code=$?
  echo ">> helm test exit code: ${code}"

  local actual verdict
  if [ "$code" -eq 0 ]; then actual="pass"; else actual="fail"; fi
  if [ "$actual" = "$expect" ]; then verdict="OK"; else verdict="MISMATCH"; OVERALL=1; fi

  RESULTS+=("${name}|${expect}|${actual}|${verdict}")
  teardown "$rel" "$ns"
}

# --- Scenarios ------------------------------------------------------------

# 1. Healthy install — must PASS.
run_scenario 1 "happy path (3-node QUORUM)" pass "$PASS_TIMEOUT"

# 2. StorageClass that does not exist — PVCs never bind — must FAIL.
run_scenario 2 "missing StorageClass" fail "$FAIL_TIMEOUT" \
  --set "scylladb.persistence.storageClass=nonexistent-sc-xyz"

# 3. Impossible CPU request — pods unschedulable — must FAIL.
run_scenario 3 "insufficient resources" fail "$FAIL_TIMEOUT" \
  --set "scylladb.resourcesPreset=none" \
  --set "scylladb.resources.requests.cpu=1000"

# --- Summary --------------------------------------------------------------

banner "RESULTS"
printf '%-34s %-8s %-8s %s\n' "SCENARIO" "EXPECT" "ACTUAL" "VERDICT"
printf '%-34s %-8s %-8s %s\n' "--------" "------" "------" "-------"
for row in "${RESULTS[@]}"; do
  IFS='|' read -r name expect actual verdict <<<"$row"
  printf '%-34s %-8s %-8s %s\n' "$name" "$expect" "$actual" "$verdict"
done

echo
if [ "$OVERALL" -eq 0 ]; then
  echo "ALL SCENARIOS MATCHED EXPECTATIONS — safe to publish."
else
  echo "ONE OR MORE SCENARIOS DID NOT MATCH — investigate before publishing."
fi
exit "$OVERALL"
