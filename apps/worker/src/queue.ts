import { Queue } from "bullmq";
import IORedis from "ioredis";
import { config } from "./config";

const redisOptions = { maxRetriesPerRequest: null } as const;

export const queueConnection = new IORedis(config.REDIS_URL, redisOptions);
queueConnection.on("error", (error) => console.error({ error }, "media queue Redis connection error"));

export const mediaQueue = new Queue("media", { connection: queueConnection });

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`Redis queue operation timed out after ${timeoutMs}ms`)), timeoutMs).unref();
    })
  ]);
}

/**
 * Enqueues a single pipeline run. Retries are not expressed through BullMQ
 * attempts: the database `processing_attempts` counter is the single source of
 * truth and the worker watchdog (recoverStuckMedia) re-enqueues transient
 * failures or crashed jobs. `delayMs` schedules an exponential-backoff retry.
 */
export async function enqueueMediaProcessing(mediaId: string, jobId: string, delayMs = 0): Promise<void> {
  await withTimeout(
    mediaQueue.add("process", { mediaId }, {
      jobId,
      delay: delayMs,
      removeOnComplete: 1000,
      removeOnFail: 1000
    }),
    3_000
  );
}

export async function closeMediaQueue(): Promise<void> {
  await mediaQueue.close();
  if (queueConnection.status !== "end") queueConnection.disconnect();
}
