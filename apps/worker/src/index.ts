import { Worker } from "bullmq";
import IORedis from "ioredis";
import { config } from "./config";
import { pool } from "./db";
import {
  processMediaJob,
  cleanupOriginalMedia,
  cleanupDeletedMediaObjects,
  markStaleFeatures,
  recoverStuckMedia,
  recoverUnenqueuedMedia,
  markMediaEnqueued,
  abandonExhaustedStuckMedia,
  markUnreferencedMediaDeleted
} from "./media-job";
import { dispatchOutbox, recoverStuckOutbox } from "./outbox";
import { purgeDeletedAccounts } from "./account-job";
import { enqueueMediaProcessing, closeMediaQueue } from "./queue";

const redisOptions = { maxRetriesPerRequest: null } as const;
const mediaWorkerConnection = new IORedis(config.REDIS_URL, redisOptions);
const outboxWorkerConnection = new IORedis(config.REDIS_URL, redisOptions);

for (const [name, connection] of [
  ["media worker", mediaWorkerConnection],
  ["outbox worker", outboxWorkerConnection]
] as const) {
  connection.on("error", (error) => console.error({ error, connection: name }, "Redis connection error"));
}

const mediaWorker = new Worker("media", async (job) => {
  if (job.name !== "process") return;
  const mediaId = String(job.data.mediaId);
  const outcome = await processMediaJob(mediaId);
  if (!outcome.terminal) {
    // Transient failure with attempts remaining: schedule one delayed retry with
    // exponential backoff (10s, 20s, 40s, ... capped at 5 minutes). If the queue
    // is unavailable the row stays "processing" and the watchdog recovers it.
    const delay = Math.min(5 * 60_000, 10_000 * 2 ** (outcome.attempts - 1));
    try {
      await enqueueMediaProcessing(mediaId, `media-retry-${mediaId}-${outcome.attempts}-${Date.now()}`, delay);
      await job.log(`transient ${outcome.code}; retry ${outcome.attempts} scheduled in ${delay}ms`);
    } catch (error) {
      console.error({ mediaId, error }, "failed to schedule media retry; watchdog will recover");
    }
  }
}, {
  connection: mediaWorkerConnection,
  concurrency: 2,
  lockDuration: 120_000,
  maxStalledCount: 1
});

const outboxWorker = new Worker("outbox", async (job) => {
  if (job.name !== "dispatch") return;
  await dispatchOutbox(job.data?.eventId ? String(job.data.eventId) : undefined);
}, { connection: outboxWorkerConnection, concurrency: 2 });

mediaWorker.on("failed", (job, error) => {
  // Terminal media states (ready/manual_review/failed) resolve the job; only
  // retried transient errors and genuine crashes reach this handler.
  console.error({ jobId: job?.id, attempts: job?.attemptsMade, error }, "media job attempt failed");
});
outboxWorker.on("failed", (job, error) => console.error({ jobId: job?.id, error }, "outbox job failed"));

let maintenanceRunning = false;

async function rescheduleRecovered(
  items: Awaited<ReturnType<typeof recoverStuckMedia>>,
  pendingRecovery = false
): Promise<void> {
  for (const item of items) {
    try {
      await enqueueMediaProcessing(item.id, `media-recover-${item.id}-${Date.now()}`);
      if (pendingRecovery) await markMediaEnqueued(item.id);
    } catch (error) {
      // Redis/queue is down. The row stays "processing" and a later tick
      // (within the attempt budget) retries the enqueue.
      console.error({ mediaId: item.id, error }, "failed to re-enqueue recovered media");
    }
  }
}

async function maintenanceTick() {
  if (maintenanceRunning) return;
  maintenanceRunning = true;
  try {
    await recoverStuckOutbox();
    await dispatchOutbox();

    // Fast path for rows the API never enqueued (Redis was briefly down).
    await rescheduleRecovered(await recoverUnenqueuedMedia(), true);

    // Finalize rows that exhausted every attempt before rescheduling the rest.
    await abandonExhaustedStuckMedia();
    await rescheduleRecovered(await recoverStuckMedia());

    await cleanupOriginalMedia();
    await markUnreferencedMediaDeleted();
    await cleanupDeletedMediaObjects();
    await markStaleFeatures();
    await purgeDeletedAccounts();
  } catch (error) {
    console.error({ error }, "maintenance tick failed");
  } finally {
    maintenanceRunning = false;
  }
}

await maintenanceTick();
const maintenanceTimer = setInterval(() => void maintenanceTick(), 60_000);
maintenanceTimer.unref();

async function shutdown(signal: string) {
  console.log(`worker shutting down: ${signal}`);
  clearInterval(maintenanceTimer);
  await Promise.all([mediaWorker.close(), outboxWorker.close(), closeMediaQueue()]);
  for (const connection of [mediaWorkerConnection, outboxWorkerConnection]) {
    if (connection.status !== "end") connection.disconnect();
  }
  await pool.end();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
