# Arnica ScyllaDB Readiness Check

## What is this?

This is a small, self-contained Helm chart that answers one question: **can your Kubernetes cluster run Arnica's ScyllaDB workload?**

When you install it, the chart deploys a **3-node ScyllaDB cluster** into a namespace of your choice (three nodes give replication factor 3, so the check exercises real **QUORUM** reads/writes — not a single-node shortcut). Running `helm test` then executes a validator that checks two things:

1. **ScyllaDB comes up** — all nodes start, form a cluster, and become healthy on your cluster's storage and compute.
2. **The Alternator API works** — ScyllaDB's DynamoDB-compatible API responds correctly, at QUORUM consistency, to the operations Arnica uses: create table, put item, get item (consistent read), query (consistent read), batch write, TTL, and delete. The validator uses the same `@aws-sdk/client-dynamodb` driver Arnica's app uses.

At the end you get a clear **PASS/FAIL summary** in your terminal. You copy that output and send it to your Arnica contact — that's it. Nothing is sent anywhere automatically.

## Prerequisites

- `kubectl` access to your cluster with permission to create a namespace (or use an existing one)
- **Helm 3.8 or newer** (needed for OCI registry support)
- Your cluster can pull images from:
  - `ghcr.io` (the chart's validator image)
  - `docker.io` (the `bitnamilegacy/scylladb` database image)
- A **StorageClass backed by block storage** (e.g. local SSD, EBS, Ceph RBD, vSphere volumes). **NFS is not supported** — ScyllaDB requires block storage.

> The ScyllaDB (Bitnami) subchart is **vendored inside this chart**, so no Bitnami or Helm-repository access is needed at install time — your cluster only needs to pull container images from `ghcr.io` and `docker.io`.

## Quick start

Run these three steps. The whole check typically completes in a few minutes.

**1. Install the chart:**

```bash
helm install rc oci://ghcr.io/arnica-io/scylla-readiness-check -n scylla-readiness --create-namespace
```

**2. Run the readiness test** (this is where the results appear — the `--logs` flag prints the full report to your terminal). The `--timeout` must be at least as long as the validator's wait (`validator.timeoutSeconds`, default 2400s / 40m), or `helm test` aborts after its own 5-minute default:

```bash
helm test rc -n scylla-readiness --logs --timeout 45m
```

> **First boot is slow.** ScyllaDB nodes start one at a time and each can take ~6-8 minutes, so a fresh 3-node cluster often needs ~18-24 minutes to be fully Ready — this is normal. Watch `kubectl get pods -n scylla-readiness` until all `scylladb-*` pods are Ready before (or while) running the test.

**3. Clean up when you're done:**

```bash
helm uninstall rc -n scylla-readiness && kubectl delete namespace scylla-readiness
```

> If your cluster's default StorageClass is NFS-backed or you want to test a specific one, add
> `--set scylladb.persistence.storageClass=<name>` to the install command.

## Interpreting the results

- **PASS** — your cluster started ScyllaDB and every Alternator API operation succeeded. Your cluster is ready to run Arnica's on-prem workload.
- **FAIL** — one or more checks did not succeed. The output lists exactly which step failed and why (for example, a storage or networking issue).
- **Startup diagnostics packet** — if ScyllaDB never becomes ready within the timeout (20 minutes by default), the validator prints a diagnostics packet instead: pod status, recent Kubernetes events, and container logs. This is usually enough for Arnica to pinpoint the problem without any further access to your cluster.

**In every case: copy the full terminal output and send it to your Arnica contact.** The output never leaves your cluster on its own — sharing it is always a manual step you take.

## Configuration

All settings are optional. Override them with `--set key=value` on the install command.

| Value | Default | Description |
|---|---|---|
| `validator.timeoutSeconds` | `1200` | How long (in seconds) the validator waits for ScyllaDB to become ready before emitting the diagnostics packet. |
| `scylladb.persistence.storageClass` | cluster default | StorageClass used for the ScyllaDB data volume. Must be block storage — NFS is unsupported. |
| `scylladb.persistence.size` | chart default | Size of the persistent volume requested for ScyllaDB. |
| `scylladb.resourcesPreset` | chart default | CPU/memory sizing preset for the ScyllaDB pod. |
| `scylladb.replicaCount` | `3` | Number of ScyllaDB nodes. 3 gives RF3/QUORUM (matches prod). Set to 1 for a lightweight non-quorum check. |

Example — longer timeout and an explicit storage class:

```bash
helm install rc oci://ghcr.io/arnica-io/scylla-readiness-check \
  -n scylla-readiness --create-namespace \
  --set validator.timeoutSeconds=1800 \
  --set scylladb.persistence.storageClass=fast-ssd
```

## If something goes wrong — send diagnostics

If the check fails or ScyllaDB keeps crashing, the `helm test --logs` output
already includes a diagnostics packet (pod status, events, ScyllaDB boot logs).
For a complete bundle to send back to Arnica, run:

```bash
curl -fsSL https://raw.githubusercontent.com/arnica-io/scylla-readiness-check/main/test/collect-diagnostics.sh \
  | bash -s -- -n scylla-readiness -r rc
```

This writes `scylla-readiness-diagnostics-*.tgz` — Kubernetes objects, events,
and ScyllaDB logs only (no application data). Review it if cluster names are
sensitive, then send it to your Arnica contact.

## Cleanup / offboarding

```bash
helm uninstall rc -n scylla-readiness
kubectl delete namespace scylla-readiness
```

Deleting the namespace removes the ScyllaDB StatefulSet **and its PersistentVolumeClaims**. Nothing is left behind on your cluster.

## Privacy

- The validator only writes **synthetic data** (generated table names and test items) to the temporary ScyllaDB instance it deploys. No customer or business data is ever read or written.
- The output contains only synthetic table names and API-level facts (which operations passed or failed, plus startup diagnostics if needed).
- There is **no phone-home**: nothing is transmitted to Arnica or anywhere else automatically. Results reach Arnica only when you copy and send them yourself.
