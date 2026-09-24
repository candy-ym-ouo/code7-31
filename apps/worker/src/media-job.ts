import type { PrivacyRegion } from "@map/shared/contracts";
import { config } from "./config";
import { pool } from "./db";
import { copyToPublic, deleteObject, objectExists, readQuarantineObject, writeQuarantineObject } from "./storage";
import { scanForMalware } from "./clamav";
import { processPrivacyImage, type DetectorOutcome } from "./privacy";
import { classifyClamavError, classifyMediaError, MediaProcessingError } from "./errors";
import { notifyMediaOwner, notifyModerators, recordWorkerAudit } from "./notifications";

export type MediaJobOutcome =
  | { terminal: true; status: "ready" | "manual_review" | "failed" | "skipped" }
  | { terminal: false; status: "processing"; code: string; attempts: number };

type MediaRow = {
  id: string;
  owner_id: string;
  privacy_status: string;
  quarantine_object_key: string;
  privacy_report: { manualRegions?: PrivacyRegion[] } | null;
  processing_attempts: number;
};

async function deletePublicCopies(mediaId: string): Promise<void> {
  await Promise.allSettled([
    deleteObject(config.S3_PUBLIC_BUCKET, `media/${mediaId}.webp`),
    deleteObject(config.S3_PUBLIC_BUCKET, `media/${mediaId}.thumb.webp`)
  ]);
}

/**
 * Run the full privacy pipeline once.
 *
 * Recovery contract:
 * - Success with detector      -> "ready" (auto published).
 * - Success without/with degraded detector -> "manual_review" (human gate).
 * - Transient failure          -> left in "processing"; the worker re-enqueues a
 *                                 delayed retry and the watchdog recovers
 *                                 crashed runs, up to MEDIA_MAX_ATTEMPTS.
 * - Exhausted retries          -> "manual_review" when a processed image exists,
 *                                 otherwise "failed" with an owner alert.
 * - Permanent failure (malware, bad file) -> "failed" immediately, owner alerted.
 *
 * The function returns the outcome rather than throwing for terminal states so
 * the queue worker does not log misleading retry failures for human-gated or
 * permanently rejected assets.
 */
export async function processMediaJob(mediaId: string): Promise<MediaJobOutcome> {
  // Claim an attempt atomically. Stale jobs recovered by the watchdog increment
  // the same counter, so the retry budget is shared across queue retries and
  // crash recovery.
  const claimed = await pool.query<MediaRow>(
    `UPDATE media_assets
     SET processing_attempts = processing_attempts + 1,
         privacy_status = 'scanning',
         updated_at = now()
     WHERE id = $1 AND deleted_at IS NULL
       AND privacy_status IN ('processing', 'failed')
     RETURNING id, owner_id, privacy_status, quarantine_object_key, privacy_report, processing_attempts`,
    [mediaId]
  );
  const media = claimed.rows[0];
  if (!media) {
    const current = await pool.query<{ privacy_status: string }>(
      "SELECT privacy_status FROM media_assets WHERE id = $1 AND deleted_at IS NULL",
      [mediaId]
    );
    if (!current.rows[0]) throw new MediaProcessingError("MEDIA_RECORD_MISSING", "permanent", "Media record not found");
    console.log(`skip media ${mediaId}: status=${current.rows[0].privacy_status}`);
    return { terminal: true, status: "skipped" };
  }

  const attempt = media.processing_attempts;
  const finalAttempt = attempt >= config.MEDIA_MAX_ATTEMPTS;
  const manualRegions = media.privacy_report?.manualRegions ?? [];
  const processedKey = `processed/${mediaId}.webp`;
  const thumbnailKey = `processed/${mediaId}.thumb.webp`;

  let source: Buffer;
  try {
    source = await readQuarantineObject(media.quarantine_object_key);
  } catch (error) {
    const classified = classifyMediaError(error);
    // A missing/forbidden source object is deterministic (the upload vanished or
    // the key is wrong); anything else (connection blip, throttling) is retried.
    const notFound = /NotFound|NoSuchKey|Forbidden|not\s*found|404|403/i.test(classified.message);
    if (notFound) {
      return finalizeFailure(mediaId, {
        ownerId: media.owner_id,
        code: "SOURCE_OBJECT_MISSING",
        message: classified.message,
        attempts: attempt,
        reason: "Quarantined source object is unreadable"
      });
    }
    return handleTransient(mediaId, {
      ownerId: media.owner_id,
      code: classified.code,
      message: classified.message,
      attempt,
      finalAttempt
    });
  }

  try {
    try {
      await scanForMalware(source);
    } catch (error) {
      throw classifyClamavError(error);
    }

    await pool.query("UPDATE media_assets SET privacy_status = 'processing', updated_at = now() WHERE id = $1", [mediaId]);
    const processed = await processPrivacyImage(source, manualRegions);

    // A detector outage never auto-publishes: degrade to the human gate.
    const detectorHealthy = processed.detector.status === "ok";
    const detectorConfigured = Boolean(config.PRIVACY_DETECTOR_URL);
    const autoPublish = detectorConfigured && detectorHealthy;
    const detector: DetectorOutcome = detectorConfigured
      ? processed.detector
      : { status: "degraded", reason: "unavailable", error: "Privacy detector is not configured", attempts: 0 };

    await writeQuarantineObject(processedKey, processed.image, "image/webp");
    await writeQuarantineObject(thumbnailKey, processed.thumbnail, "image/webp");

    const report = {
      manualRegions: processed.manualRegions,
      detectorRegions: processed.detectorRegions,
      detector: detector.status,
      detectorReason: detector.status === "degraded" ? detector.reason : undefined,
      detectorError: detector.status === "degraded" ? detector.error : undefined,
      detectorAttempts: detector.status === "degraded" ? detector.attempts : undefined,
      detectorConfigured,
      originalMetadataRemoved: true,
      serverReencoded: true,
      processingAttempts: attempt,
      width: processed.width,
      height: processed.height,
      sha256: processed.sha256,
      perceptualHash: processed.perceptualHash,
      completedAt: new Date().toISOString()
    };

    await pool.query(
      `UPDATE media_assets
       SET privacy_status = $2,
           processed_object_key = $3,
           thumbnail_object_key = $4,
           public_object_key = NULL,
           public_thumbnail_object_key = NULL,
           width = $5,
           height = $6,
           sha256 = $7,
           perceptual_hash = $8,
           privacy_report = $9::jsonb,
           failure_code = NULL,
           processed_at = now(),
           delete_after = now() + ($10::text || ' hours')::interval,
           updated_at = now()
       WHERE id = $1`,
      [
        mediaId,
        autoPublish ? "ready" : "manual_review",
        processedKey,
        thumbnailKey,
        processed.width,
        processed.height,
        processed.sha256,
        processed.perceptualHash,
        JSON.stringify(report),
        String(config.ORIGINAL_RETENTION_HOURS)
      ]
    );

    if (!autoPublish) {
      const degraded = detector.status === "degraded" && detectorConfigured;
      await recordWorkerAudit({
        actorId: media.owner_id,
        action: degraded ? "media.privacy_degraded_to_manual_review" : "media.manual_review_requested",
        resourceId: mediaId,
        metadata: {
          detector: detector.status,
          detectorReason: detector.status === "degraded" ? detector.reason : undefined,
          detectorError: detector.status === "degraded" ? detector.error.slice(0, 300) : undefined,
          attempts: attempt
        }
      });
      await notifyMediaOwner(media.owner_id, {
        type: "media_manual_review",
        title: "照片已进入人工隐私复核",
        body: degraded
          ? "自动隐私检测器暂时不可用，已按你框选的区域完成服务端模糊，并转入人工复核；确认通过后才会公开展示。"
          : "照片已完成服务端隐私处理，等待审核员确认后才会公开展示。",
        link: "/me/contributions"
      });
      if (degraded) {
        await notifyModerators({
          type: "media_detector_degraded",
          title: "隐私检测器降级，媒体转入人工复核",
          body: `检测器未能返回结果（${detector.status === "degraded" ? detector.reason : "unknown"}），相关媒体仅按人工框选模糊，请优先复核。`
        });
      }
      console.log(`media ${mediaId} processed to manual_review (detector=${detector.status})`);
      return { terminal: true, status: "manual_review" };
    }

    // Detector healthy: publish the derived images to the public bucket.
    await publishProcessed(mediaId, processedKey, thumbnailKey);

    await recordWorkerAudit({
      actorId: media.owner_id,
      action: "media.processed_auto_published",
      resourceId: mediaId,
      metadata: { attempts: attempt, detectorRegions: processed.detectorRegions.length }
    });
    console.log(`media ${mediaId} processed as ready`);
    return { terminal: true, status: "ready" };
  } catch (error) {
    const classified = error instanceof MediaProcessingError
      ? { kind: error.kind, code: error.code, message: error.message }
      : classifyMediaError(error);

    if (classified.kind === "detector") {
      // Defensive: detectRegions normally degrades instead of throwing. If a
      // detector error still surfaces, never fail the media on its account.
      await degradeProcessingFailure(mediaId, media.owner_id, attempt, manualRegions, {
        code: classified.code,
        message: classified.message
      });
      return { terminal: true, status: "manual_review" };
    }

    if (classified.kind === "permanent") {
      return finalizeFailure(mediaId, {
        ownerId: media.owner_id,
        code: classified.code,
        message: classified.message,
        attempts: attempt
      });
    }

    return handleTransient(mediaId, {
      ownerId: media.owner_id,
      code: classified.code,
      message: classified.message,
      attempt,
      finalAttempt
    });
  }
}

async function publishProcessed(mediaId: string, processedKey: string, thumbnailKey: string): Promise<void> {
  const publicKey = `media/${mediaId}.webp`;
  const publicThumbnailKey = `media/${mediaId}.thumb.webp`;
  try {
    await copyToPublic(processedKey, publicKey);
    await copyToPublic(thumbnailKey, publicThumbnailKey);
    await pool.query(
      `UPDATE media_assets
       SET public_object_key = $2, public_thumbnail_object_key = $3, updated_at = now()
       WHERE id = $1`,
      [mediaId, publicKey, publicThumbnailKey]
    );
  } catch (error) {
    // Public copy failed; remove partial objects and surface as transient so the
    // asset is retried instead of being marked ready without a public object.
    await deletePublicCopies(mediaId);
    throw new MediaProcessingError(
      "PUBLIC_COPY_FAILED",
      "transient",
      `Failed to publish processed media: ${error instanceof Error ? error.message : "storage error"}`,
      error
    );
  }
}

async function handleTransient(
  mediaId: string,
  input: { ownerId: string; code: string; message: string; attempt: number; finalAttempt: boolean }
): Promise<MediaJobOutcome> {
  if (!input.finalAttempt) {
    await pool.query(
      `UPDATE media_assets
       SET privacy_status = 'processing', failure_code = $2, updated_at = now()
       WHERE id = $1`,
      [mediaId, `${input.code} (attempt ${input.attempt}/${config.MEDIA_MAX_ATTEMPTS})`.slice(0, 500)]
    );
    console.warn({ mediaId, code: input.code, attempt: input.attempt }, "transient media processing failure; retry scheduled");
    // The caller re-enqueues with backoff; the watchdog also recovers this row
    // if the process dies before the retry runs.
    return { terminal: false, status: "processing", code: input.code, attempts: input.attempt };
  }

  // Attempt budget exhausted. If a processed image exists from an earlier
  // pipeline stage we route to a human; otherwise this is a terminal failure.
  const existing = await pool.query<{ processed_object_key: string | null }>(
    "SELECT processed_object_key FROM media_assets WHERE id = $1",
    [mediaId]
  );
  if (existing.rows[0]?.processed_object_key) {
    await degradeProcessingFailure(mediaId, input.ownerId, input.attempt, undefined, {
      code: input.code,
      message: input.message
    });
    return { terminal: true, status: "manual_review" };
  }

  return finalizeFailure(mediaId, {
    ownerId: input.ownerId,
    code: input.code,
    message: input.message,
    attempts: input.attempt
  });
}

/**
 * Terminal fallback when automated processing cannot finish: keep the asset out
 * of the public bucket and put it in front of a human reviewer instead of
 * failing it outright.
 */
async function degradeProcessingFailure(
  mediaId: string,
  ownerId: string,
  attempt: number,
  manualRegions: PrivacyRegion[] | undefined,
  failure: { code: string; message: string }
): Promise<void> {
  await pool.query(
    `UPDATE media_assets
     SET privacy_status = 'manual_review',
         privacy_report = COALESCE(privacy_report, '{}'::jsonb) || $2::jsonb,
         failure_code = NULL,
         updated_at = now()
     WHERE id = $1`,
    [mediaId, JSON.stringify({
      detector: "degraded",
      detectorReason: "pipeline_failure",
      detectorError: failure.message.slice(0, 500),
      degradationCode: failure.code,
      processingAttempts: attempt,
      ...(manualRegions ? { manualRegions } : {}),
      degradedAt: new Date().toISOString()
    })]
  );
  await deletePublicCopies(mediaId);
  await recordWorkerAudit({
    actorId: ownerId,
    action: "media.privacy_degraded_to_manual_review",
    resourceId: mediaId,
    metadata: { code: failure.code, attempts: attempt, message: failure.message.slice(0, 300) }
  });
  await notifyMediaOwner(ownerId, {
    type: "media_manual_review",
    title: "照片已转入人工隐私复核",
    body: "自动处理暂时未完成，照片已转入人工复核；确认通过后才会公开展示。",
    link: "/me/contributions"
  });
  await notifyModerators({
    type: "media_detector_degraded",
    title: "媒体处理降级，转入人工复核",
    body: `媒体 ${mediaId} 在 ${attempt} 次尝试后转入人工复核（${failure.code}）。`
  });
}

async function finalizeFailure(
  mediaId: string,
  input: { ownerId: string; code: string; message: string; attempts: number; reason?: string }
): Promise<MediaJobOutcome> {
  await pool.query(
    `UPDATE media_assets
     SET privacy_status = 'failed', failure_code = $2,
         delete_after = now() + interval '7 days', updated_at = now()
     WHERE id = $1`,
    [mediaId, input.message.slice(0, 500)]
  );
  await deletePublicCopies(mediaId);
  await recordWorkerAudit({
    actorId: input.ownerId,
    action: "media.processing_failed",
    resourceId: mediaId,
    metadata: { code: input.code, attempts: input.attempts, reason: input.reason ?? null }
  });
  await notifyMediaOwner(input.ownerId, {
    type: "media_processing_failed",
    title: "照片处理未成功",
    body: input.code === "MALWARE_DETECTED"
      ? "你上传的照片未通过安全扫描，已被拦截且不会公开展示。"
      : "照片在服务端处理时失败，可以在投稿页重试上传；如多次失败请联系管理员。",
    link: "/me/contributions"
  });
  console.error({ mediaId, code: input.code, attempts: input.attempts }, "media processing terminally failed");
  return { terminal: true, status: "failed" };
}

export async function cleanupOriginalMedia(): Promise<void> {
  const abandoned = await pool.query<{ id: string; quarantine_object_key: string }>(
    `SELECT id, quarantine_object_key FROM media_assets
     WHERE privacy_status = 'quarantined'
       AND created_at < now() - interval '24 hours'
       AND deleted_at IS NULL
     LIMIT 50`
  );
  for (const row of abandoned.rows) {
    try {
      if (await objectExists(config.S3_QUARANTINE_BUCKET, row.quarantine_object_key)) {
        await deleteObject(config.S3_QUARANTINE_BUCKET, row.quarantine_object_key);
      }
      await pool.query(
        `UPDATE media_assets
         SET privacy_status = 'deleted', deleted_at = now(), updated_at = now()
         WHERE id = $1`,
        [row.id]
      );
    } catch (error) {
      console.error({ mediaId: row.id, error }, "failed to clean abandoned upload");
    }
  }

  const result = await pool.query<{ id: string; quarantine_object_key: string }>(
    `SELECT id, quarantine_object_key FROM media_assets
     WHERE delete_after IS NOT NULL AND delete_after <= now()
       AND quarantine_object_key IS NOT NULL
       AND privacy_status IN ('ready', 'manual_review', 'rejected', 'failed', 'deleted')
     LIMIT 50`
  );
  for (const row of result.rows) {
    try {
      if (await objectExists(config.S3_QUARANTINE_BUCKET, row.quarantine_object_key)) {
        await deleteObject(config.S3_QUARANTINE_BUCKET, row.quarantine_object_key);
      }
      await pool.query("UPDATE media_assets SET delete_after = NULL, updated_at = now() WHERE id = $1", [row.id]);
    } catch (error) {
      console.error({ mediaId: row.id, error }, "failed to clean original media");
    }
  }
}

export async function markStaleFeatures(): Promise<void> {
  await pool.query(
    `UPDATE map_features
     SET needs_review_at = COALESCE(needs_review_at, now()), updated_at = now()
     WHERE status = 'published' AND freshness_expires_at <= now() AND needs_review_at IS NULL`
  );
}

export type RecoveredStuckMedia = {
  id: string;
  attempts: number;
};

/**
 * Watchdog for jobs that died mid-flight (worker crash, OOM, hard timeout).
 *
 * Stuck scanning/processing rows past MEDIA_STUCK_MINUTES get another attempt by
 * resetting to "processing". Once a row has already burned MEDIA_MAX_ATTEMPTS it
 * is not rescheduled; abandonExhaustedStuckMedia finalizes those.
 */
export async function recoverStuckMedia(): Promise<RecoveredStuckMedia[]> {
  const result = await pool.query<RecoveredStuckMedia>(
    `UPDATE media_assets
     SET privacy_status = 'processing',
         failure_code = 'Recovered after worker timeout (attempt ' || (processing_attempts + 1) || ')',
         updated_at = now()
     WHERE privacy_status IN ('scanning', 'processing')
       AND updated_at < now() - ($1::text || ' minutes')::interval
       AND deleted_at IS NULL
       AND processing_attempts < $2
     RETURNING id, processing_attempts AS attempts`,
    [String(config.MEDIA_STUCK_MINUTES), config.MEDIA_MAX_ATTEMPTS]
  );
  return result.rows;
}

/**
 * Rows the API could not enqueue (Redis was down) carry
 * QUEUE_UNAVAILABLE_PENDING_RECOVERY and have no BullMQ job at all. Re-enqueue
 * these promptly so a queue blip costs seconds of delay rather than the full
 * stuck-job timeout. The marker is cleared only after enqueue succeeds; rows we
 * cannot enqueue keep the marker (and their old timestamp) so both the fast path
 * and the watchdog keep trying within the attempt budget.
 */
export async function recoverUnenqueuedMedia(): Promise<RecoveredStuckMedia[]> {
  const result = await pool.query<RecoveredStuckMedia>(
    `SELECT id, processing_attempts AS attempts
     FROM media_assets
     WHERE privacy_status = 'processing'
       AND failure_code = 'QUEUE_UNAVAILABLE_PENDING_RECOVERY'
       AND deleted_at IS NULL
       AND processing_attempts < $1
     LIMIT 50`,
    [config.MEDIA_MAX_ATTEMPTS]
  );
  return result.rows;
}

/** Clears the queue-unavailable marker once the recovery enqueue succeeded. */
export async function markMediaEnqueued(mediaId: string): Promise<void> {
  await pool.query(
    `UPDATE media_assets
     SET failure_code = NULL, updated_at = now()
     WHERE id = $1 AND failure_code = 'QUEUE_UNAVAILABLE_PENDING_RECOVERY'`,
    [mediaId]
  );
}

/**
 * Rows that remained stuck even after exhausting the retry budget (e.g. every
 * run crashed before committing a terminal state). Finalize them so they never
 * retry forever and the owner is informed.
 */
export async function abandonExhaustedStuckMedia(): Promise<string[]> {
  const stuck = await pool.query<{ id: string; owner_id: string }>(
    `SELECT id, owner_id FROM media_assets
     WHERE privacy_status IN ('scanning', 'processing')
       AND updated_at < now() - ($1::text || ' minutes')::interval
       AND deleted_at IS NULL
       AND processing_attempts >= $2
     LIMIT 50`,
    [String(config.MEDIA_STUCK_MINUTES), config.MEDIA_MAX_ATTEMPTS]
  );
  for (const row of stuck.rows) {
    await finalizeFailure(row.id, {
      ownerId: row.owner_id,
      code: "MEDIA_RECOVERY_EXHAUSTED",
      message: "Media processing did not complete after the maximum number of attempts",
      attempts: config.MEDIA_MAX_ATTEMPTS
    });
  }
  return stuck.rows.map((row) => row.id);
}

export async function cleanupDeletedMediaObjects(): Promise<void> {
  const result = await pool.query<{
    id: string;
    quarantine_object_key: string;
    processed_object_key: string | null;
    thumbnail_object_key: string | null;
    public_object_key: string | null;
    public_thumbnail_object_key: string | null;
  }>(
    `SELECT id, quarantine_object_key, processed_object_key, thumbnail_object_key,
            public_object_key, public_thumbnail_object_key
     FROM media_assets
     WHERE privacy_status = 'deleted'
       AND (quarantine_object_key NOT LIKE 'deleted/%'
         OR processed_object_key IS NOT NULL
         OR thumbnail_object_key IS NOT NULL
         OR public_object_key IS NOT NULL
         OR public_thumbnail_object_key IS NOT NULL)
     LIMIT 50`
  );

  for (const item of result.rows) {
    try {
      const removals: Array<Promise<void>> = [];
      if (!item.quarantine_object_key.startsWith("deleted/")) {
        removals.push(deleteObject(config.S3_QUARANTINE_BUCKET, item.quarantine_object_key));
      }
      if (item.processed_object_key) removals.push(deleteObject(config.S3_QUARANTINE_BUCKET, item.processed_object_key));
      if (item.thumbnail_object_key) removals.push(deleteObject(config.S3_QUARANTINE_BUCKET, item.thumbnail_object_key));
      if (item.public_object_key) removals.push(deleteObject(config.S3_PUBLIC_BUCKET, item.public_object_key));
      if (item.public_thumbnail_object_key) removals.push(deleteObject(config.S3_PUBLIC_BUCKET, item.public_thumbnail_object_key));
      await Promise.all(removals);

      await pool.query(
        `UPDATE media_assets
         SET quarantine_object_key = $2,
             processed_object_key = NULL,
             thumbnail_object_key = NULL,
             public_object_key = NULL,
             public_thumbnail_object_key = NULL,
             delete_after = NULL,
             updated_at = now()
         WHERE id = $1`,
        [item.id, `deleted/${item.id}.object`]
      );
    } catch (error) {
      console.error({ mediaId: item.id, error }, "failed to clean deleted media objects");
    }
  }
}

export async function markUnreferencedMediaDeleted(): Promise<void> {
  await pool.query(
    `UPDATE media_assets ma
     SET privacy_status = 'deleted', deleted_at = now(), updated_at = now()
     WHERE ma.deleted_at IS NULL
       AND ma.created_at < now() - interval '7 days'
       AND NOT EXISTS (
         SELECT 1 FROM revision_media rm WHERE rm.media_id = ma.id
       )`
  );
}
