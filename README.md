# Arnica ScyllaDB Readiness Check

## What is this?

This is a small, self-contained Helm chart that answers one question: **can your Kubernetes cluster run Arnica's ScyllaDB workload?**

When you install it, the chart deploys a single-node ScyllaDB instance into a namespace of your choice. Running `helm test` then executes a validator that checks two things:

1. **ScyllaDB comes up** — the database starts and becomes healthy on your cluster's storage and compute.
2. **The Alternator API works** — ScyllaDB's DynamoDB-compatible API responds correctly to the operations Arnica uses: create table, put item, get item, query, batch write, TTL, and delete.

At the end you get a clear **PASS/FAIL summary** in your terminal. You copy that output and send it to your Arnica contact — that's it. Nothing is sent anywhere automatically.

## Prerequisites

- `kubectl` access to your cluster with permission to create a namespace (or use an existing one)
- **Helm 3.8 or newer** (needed for OCI registry support)
- Your cluster can pull images from:
  - `ghcr.io` (the chart's validator image)
  - `docker.io` (the `bitnamilegacy/scylladb` database image)
- A **StorageClass backed by block storage** (e.g. local SSD, EBS, Ceph RBD, vSphere volumes). **NFS is not supported** — ScyllaDB requires block storage.

## Quick start

Run these three steps. The whole check typically completes in a few minutes.

**1. Install the chart:**

```bash
helm install rc oci://ghcr.io/arnica-io/scylla-readiness-check -n scylla-readiness --create-namespace
```

**2. Run the readiness test** (this is where the results appear — the `--logs` flag prints the full report to your terminal):

```bash
helm test rc -n scylla-readiness --logs
```

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
| `scylladb.replicaCount` | `1` | Number of ScyllaDB nodes. One node is enough for the readiness check. |

Example — longer timeout and an explicit storage class:

```bash
helm install rc oci://ghcr.io/arnica-io/scylla-readiness-check \
  -n scylla-readiness --create-namespace \
  --set validator.timeoutSeconds=1800 \
  --set scylladb.persistence.storageClass=fast-ssd
```

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

---

## Maintainers (Arnica)

Releases are automated by the tag-triggered GitHub Actions workflow (`.github/workflows/release.yaml`): pushing a `vX.Y.Z` tag builds and pushes the validator image and the chart. The steps below are the manual equivalent.

**Build and push the validator image:**

```bash
docker build -t ghcr.io/arnica-io/scylla-readiness-validator:X.Y.Z -f validator/Dockerfile .
docker push ghcr.io/arnica-io/scylla-readiness-validator:X.Y.Z
```

**Package and push the chart (OCI):**

```bash
helm package .
helm push scylla-readiness-check-X.Y.Z.tgz oci://ghcr.io/arnica-io
```

**Notes:**

- The `scylladb` subchart is **vendored in `charts/`**, so no Bitnami repository access is needed at install time — prospects only need to reach `ghcr.io` and `docker.io`.
- To cut a release, bump the version and push a tag: `git tag vX.Y.Z && git push origin vX.Y.Z`. The release workflow handles the image build (multi-arch), chart packaging, and pushes to `ghcr.io/arnica-io`.
