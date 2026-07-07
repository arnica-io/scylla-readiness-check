/**
 * ScyllaDB readiness validator — runs as a Kubernetes `helm test` Job.
 *
 * PHASE 1  — wait (up to TIMEOUT_SECONDS) for ScyllaDB's Alternator
 *            (DynamoDB-compatible) API to answer ListTables.
 * PHASE 2a — if it never comes up: pull Kubernetes diagnostics (pod status,
 *            events, logs) via the in-cluster API and exit 1.
 * PHASE 2b — if it comes up: run functional DynamoDB tests at QUORUM
 *            consistency and print a PASS/FAIL summary, exit 0/1.
 *
 * This intentionally uses @aws-sdk/client-dynamodb (v3) — the same driver
 * Arnica's application uses — so the check reflects the real client path.
 */

import {
  BatchWriteItemCommand,
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  GetItemCommand,
  ListTablesCommand,
  PutItemCommand,
  QueryCommand,
  UpdateTimeToLiveCommand,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import { AppsV1Api, CoreV1Api, Exec, KubeConfig, V1Pod } from '@kubernetes/client-node';
import { Writable } from 'node:stream';

// ---------------------------------------------------------------------------
// Configuration (env vars provided by the Job, with safe defaults)
// ---------------------------------------------------------------------------

const SCYLLA_ENDPOINT = process.env.SCYLLA_ENDPOINT ?? 'http://scylladb:8000';
const TIMEOUT_SECONDS = parseInt(process.env.TIMEOUT_SECONDS ?? '1200', 10);
const SCYLLA_SELECTOR =
  process.env.SCYLLA_SELECTOR ?? 'app.kubernetes.io/name=scylladb';
const NAMESPACE = process.env.NAMESPACE ?? 'default';
// Alternator requires credentials to be present but accepts any value.
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? 'readiness';
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? 'readiness';
const AWS_DEFAULT_REGION = process.env.AWS_DEFAULT_REGION ?? 'us-east-1';

const POLL_INTERVAL_MS = 10_000;
const HEARTBEAT_EVERY_MS = 30_000;

// ---------------------------------------------------------------------------
// Output helpers — plain ASCII; this output is read from `helm test --logs`
// and pasted into email/Slack, so no colors or unicode decorations.
// ---------------------------------------------------------------------------

function banner(text: string): void {
  const line = '='.repeat(72);
  console.log(`\n${line}\n${text}\n${line}`);
}

function section(text: string): void {
  console.log(`\n---- ${text} ${'-'.repeat(Math.max(1, 66 - text.length))}`);
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    return `${err.name}: ${err.message}`;
  }
  if (err && typeof err === 'object') {
    // Kubernetes client / websocket errors are plain objects — surface the
    // useful fields instead of "[object Object]".
    const o = err as Record<string, unknown>;
    const msg = o.message ?? o.reason ?? o.statusMessage ?? o.body ?? o.code;
    if (msg !== undefined) return typeof msg === 'string' ? msg : JSON.stringify(msg);
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// PHASE 1 — wait for Alternator to answer
// ---------------------------------------------------------------------------

interface ReadinessResult {
  ready: boolean;
  alternatorReachable: boolean;
  lastError: unknown;
  elapsedSeconds: number;
  health: ClusterHealth;
}

// Wait until BOTH the Alternator API answers AND every ScyllaDB node the
// StatefulSet wants is Ready. Testing as soon as a single node answers would
// pass trivially (that node's keyspace is RF1 → "QUORUM" of one), giving false
// confidence — so we hold until the full cluster is up (or time out and fail).
async function waitForCluster(
  client: DynamoDBClient,
  kc: KubeConfig,
): Promise<ReadinessResult> {
  banner(
    `PHASE 1 — waiting up to ${TIMEOUT_SECONDS}s for ScyllaDB Alternator + all nodes Ready`,
  );

  const start = Date.now();
  let lastError: unknown = null;
  let lastHeartbeat = -HEARTBEAT_EVERY_MS;
  let alternatorReachable = false;
  let health: ClusterHealth = { desired: 0, ready: 0, quorum: 0, known: false };

  for (;;) {
    const elapsedMs = Date.now() - start;
    const elapsedSeconds = Math.floor(elapsedMs / 1000);

    if (elapsedSeconds >= TIMEOUT_SECONDS) {
      return { ready: false, alternatorReachable, lastError, elapsedSeconds, health };
    }

    let alternatorOk = false;
    try {
      await client.send(new ListTablesCommand({ Limit: 1 }));
      alternatorOk = true;
      alternatorReachable = true;
    } catch (err) {
      lastError = err;
    }

    health = await getClusterHealth(kc);

    // Ready when Alternator answers AND all desired nodes are Ready. If node
    // health can't be read (RBAC/API issue), fall back to Alternator-only so
    // we don't hang forever — the topology line will note it's unknown.
    const nodesReady =
      !health.known || (health.desired > 0 && health.ready >= health.desired);
    if (alternatorOk && nodesReady) {
      const detail = health.known
        ? `all ${health.desired} node(s) Ready`
        : 'node count unknown';
      console.log(
        `[PASS] alternator-reachable and ${detail} (after ${elapsedSeconds}s)`,
      );
      return { ready: true, alternatorReachable: true, lastError: null, elapsedSeconds, health };
    }

    if (elapsedMs - lastHeartbeat >= HEARTBEAT_EVERY_MS) {
      lastHeartbeat = elapsedMs;
      const remaining = TIMEOUT_SECONDS - elapsedSeconds;
      const altInfo = alternatorOk
        ? 'alternator OK'
        : `alternator not ready (${errorText(lastError)})`;
      const nodeInfo = health.known
        ? `nodes Ready ${health.ready}/${health.desired}`
        : 'node count unknown';
      console.log(
        `... waiting (elapsed ${elapsedSeconds}s, remaining ${remaining}s) — ${altInfo}; ${nodeInfo}`,
      );
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

// ---------------------------------------------------------------------------
// PHASE 2a — Kubernetes diagnostics on timeout
// ---------------------------------------------------------------------------

// NOTE for maintainers: this targets @kubernetes/client-node >= 1.0, whose
// API methods take a single options object and return the response object
// directly (e.g. `core.listNamespacedPod({ namespace })` returns V1PodList).
// If you pin < 1.0, switch to positional args and unwrap `.body`.

async function printPodStatuses(core: CoreV1Api): Promise<void> {
  section(`Pods in ${NAMESPACE} matching "${SCYLLA_SELECTOR}"`);
  try {
    const podList = await core.listNamespacedPod({
      namespace: NAMESPACE,
      labelSelector: SCYLLA_SELECTOR,
    });
    if (podList.items.length === 0) {
      console.log('(no pods matched the selector)');
      return;
    }
    for (const pod of podList.items) {
      const name = pod.metadata?.name ?? '<unnamed>';
      const phase = pod.status?.phase ?? '<unknown>';
      console.log(`pod: ${name}  phase: ${phase}`);
      for (const cs of pod.status?.containerStatuses ?? []) {
        console.log(
          `  container: ${cs.name}  ready: ${cs.ready}  restarts: ${cs.restartCount}`,
        );
        if (cs.state?.waiting) {
          console.log(
            `    waiting: ${cs.state.waiting.reason ?? ''} ${cs.state.waiting.message ?? ''}`,
          );
        }
        if (cs.state?.terminated) {
          console.log(
            `    terminated: ${cs.state.terminated.reason ?? ''} ${cs.state.terminated.message ?? ''}`,
          );
        }
      }
    }
  } catch (err) {
    console.log(`(failed to list pods: ${errorText(err)})`);
  }
}

async function printRecentEvents(core: CoreV1Api): Promise<void> {
  section(`Recent events in ${NAMESPACE} (last 50)`);
  try {
    const eventList = await core.listNamespacedEvent({ namespace: NAMESPACE });
    const events = [...eventList.items].sort((a, b) => {
      const ta = a.lastTimestamp ? new Date(a.lastTimestamp).getTime() : 0;
      const tb = b.lastTimestamp ? new Date(b.lastTimestamp).getTime() : 0;
      return ta - tb;
    });
    for (const ev of events.slice(-50)) {
      const ts = ev.lastTimestamp
        ? new Date(ev.lastTimestamp).toISOString()
        : '<no-timestamp>';
      console.log(
        `${ts} ${ev.type ?? ''} ${ev.reason ?? ''} ${ev.involvedObject?.name ?? ''}: ${ev.message ?? ''}`,
      );
    }
    if (events.length === 0) {
      console.log('(no events found)');
    }
  } catch (err) {
    console.log(`(failed to list events: ${errorText(err)})`);
  }
}

async function printPodLogs(core: CoreV1Api): Promise<void> {
  // Keep the whole pod object: ScyllaDB pods have multiple containers
  // (init-sysctl, scylladb, scylladb-jmx-proxy), and readNamespacedPodLog
  // requires an explicit container name when there is more than one.
  let pods: V1Pod[] = [];
  try {
    const podList = await core.listNamespacedPod({
      namespace: NAMESPACE,
      labelSelector: SCYLLA_SELECTOR,
    });
    pods = podList.items;
  } catch (err) {
    console.log(`(failed to list pods for logs: ${errorText(err)})`);
    return;
  }

  for (const pod of pods) {
    const name = pod.metadata?.name;
    if (!name) continue;
    // Every container in the pod, init containers first (that is where the
    // sysctl setup — a common failure point — runs).
    const containers = [
      ...(pod.spec?.initContainers ?? []),
      ...(pod.spec?.containers ?? []),
    ].map((c) => c.name);

    for (const container of containers) {
      section(`>>> logs: ${name} [${container}]`);
      try {
        const logs = await core.readNamespacedPodLog({
          name,
          namespace: NAMESPACE,
          container,
          tailLines: 200,
        });
        console.log(logs || '(empty log)');
      } catch (err) {
        console.log(`(failed to read logs: ${errorText(err)})`);
      }
      // Previous instance too — useful for CrashLoopBackOff.
      try {
        const prevLogs = await core.readNamespacedPodLog({
          name,
          namespace: NAMESPACE,
          container,
          tailLines: 200,
          previous: true,
        });
        if (prevLogs) {
          console.log(`>>> previous-instance logs: ${name} [${container}]`);
          console.log(prevLogs);
        }
      } catch {
        // No previous instance — expected for containers that never restarted.
      }
    }
  }
}

// Run a command in a pod container and collect its combined stdout/stderr.
// Resolves with whatever was captured (never rejects) so diagnostics are
// best-effort. Bounded by a timeout so a stuck exec cannot hang the run.
function execInPod(
  kc: KubeConfig,
  pod: string,
  container: string,
  command: string[],
): Promise<string> {
  return new Promise((resolve) => {
    let out = '';
    const sink = new Writable({
      write(chunk, _enc, cb) {
        out += chunk.toString();
        cb();
      },
    });
    let settled = false;
    const done = (): void => {
      if (!settled) {
        settled = true;
        resolve(out.trim() || '(no output)');
      }
    };
    const timer = setTimeout(() => {
      out += '\n(exec timed out)';
      done();
    }, 15000);
    try {
      new Exec(kc)
        .exec(NAMESPACE, pod, container, command, sink, sink, null, false)
        .then((ws) => {
          ws.on('close', () => {
            clearTimeout(timer);
            done();
          });
          ws.on('error', () => {
            clearTimeout(timer);
            done();
          });
        })
        .catch((err: unknown) => {
          clearTimeout(timer);
          out += `\n(exec failed: ${errorText(err)})`;
          done();
        });
    } catch (err) {
      clearTimeout(timer);
      out += `\n(exec failed: ${errorText(err)})`;
      done();
    }
  });
}

// ScyllaDB (via the Bitnami image) writes boot progress and errors to a log
// file, not stdout. On failure, exec into each ScyllaDB pod and print that
// file — it contains the actual reason boot stalled (seastar/memory/schema).
async function printScyllaBootLogs(
  kc: KubeConfig,
  core: CoreV1Api,
): Promise<void> {
  let pods: V1Pod[] = [];
  try {
    const podList = await core.listNamespacedPod({
      namespace: NAMESPACE,
      labelSelector: SCYLLA_SELECTOR,
    });
    pods = podList.items;
  } catch (err) {
    console.log(`(failed to list pods for boot logs: ${errorText(err)})`);
    return;
  }

  const bootLog = '/opt/bitnami/scylladb/logs/scylladb_first_boot.log';
  for (const pod of pods) {
    const name = pod.metadata?.name;
    if (!name) continue;
    section(`>>> ScyllaDB boot log: ${name} (${bootLog})`);
    const output = await execInPod(kc, name, 'scylladb', [
      'sh',
      '-c',
      `tail -n 200 ${bootLog} 2>/dev/null || echo "(boot log not found — ScyllaDB may not have reached first boot)"`,
    ]);
    console.log(output);
  }
}

async function runDiagnosticsAndFail(
  kc: KubeConfig,
  r: ReadinessResult,
): Promise<never> {
  const { alternatorReachable, health } = r;
  // Two distinct failure modes, reported plainly:
  if (!alternatorReachable) {
    banner(`SCYLLA ALTERNATOR DID NOT ANSWER IN ${TIMEOUT_SECONDS}s — DIAGNOSTICS`);
    console.log(`Last Alternator error: ${errorText(r.lastError)}`);
  } else {
    banner(`SCYLLA CLUSTER DID NOT REACH FULL READINESS IN ${TIMEOUT_SECONDS}s — DIAGNOSTICS`);
    if (health.known) {
      console.log(
        `Only ${health.ready}/${health.desired} ScyllaDB node(s) became Ready. ` +
          `A full ${health.desired}-node cluster is required to verify QUORUM.`,
      );
    }
  }

  try {
    const core = kc.makeApiClient(CoreV1Api);
    await reportClusterHealth(kc);
    await printPodStatuses(core);
    await printRecentEvents(core);
    await printPodLogs(core);
    // ScyllaDB writes its boot progress/errors to a file, not stdout, so the
    // container logs above rarely show WHY it failed. Exec in and read it.
    await printScyllaBootLogs(kc, core);
  } catch (err) {
    console.log(`(failed to gather Kubernetes diagnostics: ${errorText(err)})`);
  }

  const why = alternatorReachable
    ? `only ${health.ready}/${health.desired} nodes Ready`
    : 'ScyllaDB Alternator never answered';
  banner(
    `RESULT: FAIL — ${why}. Send this entire output (or the collect-diagnostics.sh bundle) to your Arnica contact.`,
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// PHASE 2b — functional DynamoDB tests at QUORUM
// ---------------------------------------------------------------------------

async function runFunctionalTests(
  client: DynamoDBClient,
  kc: KubeConfig,
): Promise<never> {
  banner('PHASE 2 — functional DynamoDB (Alternator) tests at QUORUM');

  // Surface cluster topology/health first — a degraded cluster (Ready < quorum)
  // is why the QUORUM tests below may fail, so report it up front.
  const health = await reportClusterHealth(kc);

  const tableName = `readiness_check_${Date.now()}`;
  console.log(`Using test table: ${tableName}`);

  let pass = 0;
  let total = 0;
  const failed: string[] = [];
  let tableDeleted = false;

  async function check(name: string, fn: () => Promise<void>): Promise<void> {
    total++;
    try {
      await fn();
      pass++;
      console.log(`[PASS] ${name}`);
    } catch (err) {
      failed.push(name);
      console.log(`[FAIL] ${name}`);
      console.log(`       ${errorText(err)}`);
    }
  }

  try {
    await check('createTable', async () => {
      await client.send(
        new CreateTableCommand({
          TableName: tableName,
          KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
          AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
          BillingMode: 'PAY_PER_REQUEST',
        }),
      );
    });

    await check('waitTableActive', async () => {
      await waitUntilTableExists(
        { client, maxWaitTime: 120 },
        { TableName: tableName },
      );
    });

    await check('putItem', async () => {
      await client.send(
        new PutItemCommand({
          TableName: tableName,
          Item: {
            id: { S: 'item1' },
            payload: { S: 'hello-from-arnica' },
          },
        }),
      );
    });

    // ConsistentRead: true maps to a QUORUM (CL=LOCAL_QUORUM) read on a
    // multi-node ScyllaDB cluster. Combined with Alternator's
    // write-isolation=always (which makes writes LWT), this exercises the
    // quorum read/write path we want to prove works.
    await check('getItemConsistent', async () => {
      const res = await client.send(
        new GetItemCommand({
          TableName: tableName,
          Key: { id: { S: 'item1' } },
          ConsistentRead: true,
        }),
      );
      const payload = res.Item?.payload?.S;
      if (payload !== 'hello-from-arnica') {
        throw new Error(
          `consistent read returned unexpected payload: ${JSON.stringify(payload)}`,
        );
      }
    });

    await check('queryConsistent', async () => {
      const res = await client.send(
        new QueryCommand({
          TableName: tableName,
          ConsistentRead: true,
          KeyConditionExpression: 'id = :v',
          ExpressionAttributeValues: { ':v': { S: 'item1' } },
        }),
      );
      if ((res.Count ?? 0) < 1 || (res.Items?.length ?? 0) < 1) {
        throw new Error(`consistent query returned no items (Count=${res.Count})`);
      }
    });

    await check('batchWriteItem', async () => {
      await client.send(
        new BatchWriteItemCommand({
          RequestItems: {
            [tableName]: ['batch1', 'batch2', 'batch3'].map((id) => ({
              PutRequest: {
                Item: { id: { S: id }, payload: { S: `payload-${id}` } },
              },
            })),
          },
        }),
      );
    });

    // TTL support often reveals Alternator feature gaps on older Scylla versions.
    await check('updateTimeToLive', async () => {
      await client.send(
        new UpdateTimeToLiveCommand({
          TableName: tableName,
          TimeToLiveSpecification: {
            Enabled: true,
            AttributeName: 'ttl',
          },
        }),
      );
    });

    await check('deleteTable', async () => {
      await client.send(new DeleteTableCommand({ TableName: tableName }));
      tableDeleted = true;
    });
  } finally {
    if (!tableDeleted) {
      // Best-effort cleanup if the deleteTable step never ran or failed.
      try {
        await client.send(new DeleteTableCommand({ TableName: tableName }));
      } catch {
        // Ignore — the table may never have been created.
      }
    }
  }

  banner(`== ScyllaDB Compat: ${pass}/${total} PASS ==`);

  if (pass < total) {
    section('ERROR DIGEST');
    for (const name of failed) {
      console.log(`- ${name}`);
    }
    if (health.known && health.desired > 0 && health.ready < health.quorum) {
      console.log(
        `\nLikely cause: only ${health.ready}/${health.desired} ScyllaDB nodes ` +
          `are Ready (QUORUM needs ${health.quorum}). Bring the missing ` +
          `node(s) up — see the diagnostics above — then re-run.`,
      );
    }
    console.log(
      '\nRESULT: FAIL — cluster did not pass the ScyllaDB compatibility checks. Send this entire output to your Arnica contact.',
    );
    process.exit(1);
  }

  console.log("\nRESULT: PASS — cluster can run Arnica's ScyllaDB workload.");
  console.log(`Topology: ${topologyLine(health)}.`);
  process.exit(0);
}

// Honest one-line topology summary based on desired-vs-ready nodes.
function topologyLine(h: ClusterHealth): string {
  if (!h.known || h.desired === 0) return 'node count unknown';
  if (h.ready < h.desired) {
    return `DEGRADED — ${h.ready}/${h.desired} nodes Ready (quorum ${h.quorum})`;
  }
  if (h.desired >= 3) {
    return `${h.ready}/${h.desired} nodes Ready — QUORUM verified (tolerates ${h.desired - h.quorum} node loss)`;
  }
  if (h.desired === 2) return `2/2 nodes Ready — quorum active, no fault tolerance`;
  return `single-node (RF1) — QUORUM not exercised`;
}

interface ClusterHealth {
  desired: number; // ScyllaDB nodes the StatefulSet wants
  ready: number; // nodes actually Ready
  quorum: number; // nodes required for a QUORUM operation
  known: boolean; // false if the StatefulSet could not be read
}

// Read desired-vs-ready ScyllaDB nodes from the StatefulSet. A cluster with
// fewer Ready nodes than desired is DEGRADED — and if Ready < quorum, every
// QUORUM read/write will fail. This is a common on-prem finding, so we report
// it explicitly and, when degraded, dump why the missing nodes are down.
// Quiet read of desired-vs-ready ScyllaDB nodes from the StatefulSet.
async function getClusterHealth(kc: KubeConfig): Promise<ClusterHealth> {
  const apps = kc.makeApiClient(AppsV1Api);
  let desired = 0;
  let ready = 0;
  try {
    const list = await apps.listNamespacedStatefulSet({
      namespace: NAMESPACE,
      labelSelector: SCYLLA_SELECTOR,
    });
    for (const sts of list.items) {
      desired += sts.spec?.replicas ?? 0;
      ready += sts.status?.readyReplicas ?? 0;
    }
  } catch {
    return { desired: 0, ready: 0, quorum: 0, known: false };
  }
  const quorum = desired > 0 ? Math.floor(desired / 2) + 1 : 0;
  return { desired, ready, quorum, known: true };
}

async function reportClusterHealth(kc: KubeConfig): Promise<ClusterHealth> {
  const core = kc.makeApiClient(CoreV1Api);
  section('ScyllaDB cluster health');
  const health = await getClusterHealth(kc);
  const { desired, ready, quorum, known } = health;
  if (!known) {
    console.log('(could not read ScyllaDB StatefulSet)');
    return health;
  }
  console.log(`ScyllaDB nodes Ready: ${ready}/${desired}   (QUORUM needs ${quorum})`);

  if (desired > 0 && ready < desired) {
    const down = desired - ready;
    if (ready < quorum) {
      console.log(
        `WARNING: ${down} of ${desired} ScyllaDB node(s) are NOT Ready. ` +
          `Only ${ready} up — below QUORUM (${quorum}). QUORUM reads/writes ` +
          `WILL FAIL until at least ${quorum} nodes are Ready.`,
      );
    } else {
      console.log(
        `WARNING: ${down} of ${desired} ScyllaDB node(s) are NOT Ready. ` +
          `Quorum (${quorum}) is still met, but the cluster is degraded and ` +
          `has no fault tolerance.`,
      );
    }
    // Show why the missing nodes are down.
    await printPodStatuses(core);
    await printScyllaBootLogs(kc, core);
  }

  return health;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  banner('ScyllaDB readiness validator');
  console.log(`endpoint:  ${SCYLLA_ENDPOINT}`);
  console.log(`timeout:   ${TIMEOUT_SECONDS}s`);
  console.log(`namespace: ${NAMESPACE}`);
  console.log(`selector:  ${SCYLLA_SELECTOR}`);
  console.log(`region:    ${AWS_DEFAULT_REGION}`);

  const client = new DynamoDBClient({
    endpoint: SCYLLA_ENDPOINT,
    region: AWS_DEFAULT_REGION,
    credentials: {
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_ACCESS_KEY,
    },
  });

  const kc = new KubeConfig();
  try {
    kc.loadFromCluster(); // in-cluster ServiceAccount token (RBAC granted by the chart)
  } catch (err) {
    console.log(`(could not load in-cluster Kubernetes config: ${errorText(err)})`);
  }

  try {
    const readiness = await waitForCluster(client, kc);
    if (!readiness.ready) {
      await runDiagnosticsAndFail(kc, readiness);
    }
    await runFunctionalTests(client, kc);
  } finally {
    client.destroy();
  }
}

main().catch((err: unknown) => {
  console.error(`Unexpected error: ${errorText(err)}`);
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
