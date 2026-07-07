#!/usr/bin/env bash
#
# collect-diagnostics.sh — package everything Arnica needs to debug a failed or
# crashing ScyllaDB readiness check into a single .tgz the customer sends back.
#
# Usage:
#   bash collect-diagnostics.sh [-n NAMESPACE] [-r RELEASE]
# Defaults: NAMESPACE=scylla-readiness, RELEASE=rc
#
# Collects ONLY infrastructure diagnostics (Kubernetes objects, events, and
# ScyllaDB's own logs). It does NOT read application/customer data. Review the
# archive before sending if your cluster names are sensitive.
set -uo pipefail

NAMESPACE="scylla-readiness"
RELEASE="rc"
while getopts "n:r:h" opt; do
  case "$opt" in
    n) NAMESPACE="$OPTARG" ;;
    r) RELEASE="$OPTARG" ;;
    h) echo "usage: $0 [-n namespace] [-r release]"; exit 0 ;;
    *) echo "usage: $0 [-n namespace] [-r release]"; exit 1 ;;
  esac
done

command -v kubectl >/dev/null || { echo "kubectl not found"; exit 1; }

STAMP="$(date -u +%Y%m%d-%H%M%SZ)"
OUT="scylla-readiness-diagnostics-${NAMESPACE}-${STAMP}"
DIR="$(mktemp -d)/${OUT}"
mkdir -p "$DIR"
SCYLLA_SELECTOR="app.kubernetes.io/name=scylladb"

log() { echo ">> $*"; }
run() { # run <outfile> <cmd...>  — capture stdout+stderr, never abort
  local f="$1"; shift
  { echo "\$ $*"; "$@"; } >"${DIR}/${f}" 2>&1 || true
}

log "collecting into ${OUT}/ (namespace=${NAMESPACE}, release=${RELEASE})"

# --- cluster / environment ------------------------------------------------
run 00-kubectl-version.txt      kubectl version
run 01-nodes-wide.txt           kubectl get nodes -o wide
run 02-nodes-describe.txt       kubectl describe nodes
run 03-storageclasses.txt       kubectl get storageclass -o wide

# --- namespaced workloads -------------------------------------------------
run 10-get-all-wide.txt         kubectl get pods,sts,svc,pvc,endpoints -n "$NAMESPACE" -o wide
run 11-events.txt               kubectl get events -n "$NAMESPACE" --sort-by=.lastTimestamp
run 12-pods.yaml                kubectl get pods -n "$NAMESPACE" -o yaml
run 13-sts.yaml                 kubectl get sts -n "$NAMESPACE" -o yaml
run 14-pvc.yaml                 kubectl get pvc -n "$NAMESPACE" -o yaml
run 15-describe-scylla.txt      kubectl describe pod -n "$NAMESPACE" -l "$SCYLLA_SELECTOR"

# --- helm release ---------------------------------------------------------
if command -v helm >/dev/null; then
  run 20-helm-status.txt        helm status "$RELEASE" -n "$NAMESPACE"
  run 21-helm-values.txt        helm get values "$RELEASE" -n "$NAMESPACE" -a
fi

# --- per-ScyllaDB-pod logs (stdout + previous + on-disk scylla logs) ------
PODS="$(kubectl get pods -n "$NAMESPACE" -l "$SCYLLA_SELECTOR" -o name 2>/dev/null)"
i=0
for pod in $PODS; do
  name="${pod#pod/}"
  run "30-logs-${name}.txt"          kubectl logs -n "$NAMESPACE" "$pod" --all-containers=true --tail=500
  run "31-logs-prev-${name}.txt"     kubectl logs -n "$NAMESPACE" "$pod" --all-containers=true --previous --tail=500
  # ScyllaDB writes boot/runtime logs to files, not stdout — grab them via exec.
  run "32-bootlog-${name}.txt"       kubectl exec -n "$NAMESPACE" "$pod" -c scylladb -- \
      sh -c 'tail -n 500 /opt/bitnami/scylladb/logs/scylladb_first_boot.log 2>/dev/null; echo "---- logs dir ----"; ls -la /opt/bitnami/scylladb/logs 2>/dev/null'
  i=$((i+1))
done
[ "$i" -eq 0 ] && echo "(no ScyllaDB pods matched ${SCYLLA_SELECTOR})" > "${DIR}/30-no-scylla-pods.txt"

# --- validator (helm test) pod logs, if present ---------------------------
run 40-validator-logs.txt       kubectl logs -n "$NAMESPACE" "${RELEASE}-scylla-readiness-check-validator" --tail=500

# --- archive --------------------------------------------------------------
TGZ="${OUT}.tgz"
tar -czf "$TGZ" -C "$(dirname "$DIR")" "$OUT" 2>/dev/null
rm -rf "$(dirname "$DIR")"

echo
echo "Diagnostics bundle written: ${TGZ}"
echo "It contains Kubernetes objects, events, and ScyllaDB logs only — no"
echo "application data. Please review it if cluster names are sensitive, then"
echo "send it to your Arnica contact."
