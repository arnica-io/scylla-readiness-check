# Test plan — validating the readiness-check on an on-prem cluster

Goal: before publishing, prove the chart + validator do the right thing in
both directions — **PASS** on a healthy cluster, and **FAIL with useful
diagnostics** when the cluster can't run ScyllaDB. Run these on Arnica's
on-prem dev cluster (same context as
`infrastructure/.../kube-arnica-stack/values-on-prem-local-testing.yaml`).

Two guaranteed cases (happy + storage-fail) plus edge cases are automated by
`test/run-scenarios.sh`. The rest are manual because they need cluster-level
setup (PSA labels, killing nodes, arch-specific nodes).

## Prerequisites

- `kubectl` pointed at the on-prem cluster, with rights to create/delete
  namespaces.
- `helm` 3.8+.
- The validator image must be pullable. Either publish it first (tag
  `v0.1.0`) **or** build+load it into the cluster and install with
  `--set validator.image=<your-ref>`.
- Run from the repo root (chart at `.`).

## How outcomes are read

- `helm test` exit code **0** = validator printed `RESULT: PASS`.
- exit code **non-zero** = either the functional checks failed, or ScyllaDB
  never became ready and the validator dumped a diagnostics packet
  (pods/events/logs). Always inspect with `--logs`.

## Scenario matrix

| # | Scenario | How induced | Expected `helm test` | What it proves |
|---|----------|-------------|----------------------|----------------|
| 1 | **Happy path** | default install, good block SC | **exit 0** — `RESULT: PASS ... QUORUM verified` | 3 nodes form a cluster; Alternator serves QUORUM reads/writes; all 8 ops pass |
| 2 | **Missing/invalid StorageClass** | `--set scylladb.persistence.storageClass=nonexistent-sc-xyz` | **exit 1** — timeout → diagnostics; events show PVC unbound / no provisioner | storage misconfig is caught and explained, not hung silently |
| 3 | **Insufficient resources** | `--set scylladb.resourcesPreset=none --set scylladb.resources.requests.cpu=1000` | **exit 1** — timeout → diagnostics; events show `Insufficient cpu` / Pending | undersized/oversubscribed clusters are caught with a clear reason |
| 4 | **Restricted PodSecurity** | label ns `pod-security.kubernetes.io/enforce=restricted` before install | **exit 1** — pods rejected/failing; diagnostics show PSA violation on the privileged sysctl init | a common on-prem hardening that blocks ScyllaDB is surfaced |
| 5 | **Quorum tolerance** | after scenario 1 is up: kill 1 of 3 pods, re-test; then kill 2, re-test | 1 down → **exit 0** (2/3 = quorum holds); 2 down → **exit 1** (consistent reads fail) | the QUORUM path is real, not cosmetic — RF3 tolerates 1 loss, not 2 |
| 6 | **Architecture mismatch** | `--set scylladb.nodeSelector.kubernetes\.io/arch=arm64` on a cluster whose image is amd64-only | **exit 1** — ImagePull/exec-format errors in diagnostics | unsupported node arch is caught |

## Automated scenarios (1, 2, 3)

```bash
# from repo root; optionally override the image if not yet published:
#   VALIDATOR_IMAGE=ghcr.io/arnica-io/scylla-readiness-validator:0.1.0 \
bash test/run-scenarios.sh
```

The script installs each scenario in its own namespace, runs `helm test
--logs`, compares the exit code to the expected result, tears everything
down (including PVCs, by deleting the namespace), and prints a final
pass/fail matrix. It exits non-zero if any scenario's actual outcome differs
from expected.

Tune timeouts with env vars: `PASS_TIMEOUT` (default 900s, allows the 3-node
bootstrap) and `FAIL_TIMEOUT` (default 180s, keeps the negative cases quick).

## Manual scenarios

### 4 — Restricted PodSecurity Admission

```bash
NS=scylla-rc-psa
kubectl create namespace "$NS"
kubectl label namespace "$NS" \
  pod-security.kubernetes.io/enforce=restricted --overwrite
helm install rc . -n "$NS" --set validator.timeoutSeconds=180
helm test rc -n "$NS" --logs        # expect exit 1 + PSA violation in the packet
# cleanup
helm uninstall rc -n "$NS"; kubectl delete namespace "$NS"
```

### 5 — Quorum tolerance (do this after a healthy install)

```bash
NS=scylla-rc-quorum
helm install rc . -n "$NS" --create-namespace --set validator.timeoutSeconds=900
helm test rc -n "$NS" --logs        # baseline: expect PASS

# lose ONE node — RF3 quorum (2/3) still holds -> expect PASS
kubectl delete pod scylladb-2 -n "$NS"
helm test rc -n "$NS" --logs        # expect exit 0 (PASS)

# lose TWO nodes — quorum lost -> consistent reads fail -> expect FAIL
kubectl delete pod scylladb-1 scylladb-2 -n "$NS"
helm test rc -n "$NS" --logs        # expect exit 1; getItem/query steps FAIL

# cleanup
helm uninstall rc -n "$NS"; kubectl delete namespace "$NS"
```

Note: after deleting pods the StatefulSet recreates them; run the follow-up
`helm test` quickly (or scale the StatefulSet down) to observe the
degraded-quorum behaviour before the pods rejoin.

### 6 — Architecture mismatch (only if the cluster has arm64 nodes)

```bash
NS=scylla-rc-arch
helm install rc . -n "$NS" --create-namespace \
  --set validator.timeoutSeconds=180 \
  --set-string scylladb.nodeSelector."kubernetes\.io/arch"=arm64
helm test rc -n "$NS" --logs        # expect exit 1; diagnostics show pull/exec-format errors
helm uninstall rc -n "$NS"; kubectl delete namespace "$NS"
```

## After testing

Confirm: scenario 1 PASSes, scenarios 2–4 (and 6 if applicable) FAIL with a
diagnostics packet that names the real cause, and scenario 5 shows PASS at
1-node loss / FAIL at 2-node loss. Then it's safe to publish.
