import { createHash } from "node:crypto";
import sharp from "sharp";
import type { Metadata, OutputInfo } from "sharp";
import { privacyRegionSchema, type PrivacyRegion } from "@map/shared/contracts";
import { config } from "./config";
import { MediaProcessingError } from "./errors";

/**
 * Outcome of a detector call. The pipeline never auto-publishes when the
 * detector could not positively return an answer: a degraded/down result is
 * carried back to the job so it can process with manual regions only and route
 * the asset into manual_review.
 */
export type DetectorOutcome =
  | { status: "ok"; regions: PrivacyRegion[] }
  | { status: "degraded"; reason: "unavailable" | "bad_response" | "invalid_response"; error: string; attempts: number };

export type ProcessedImage = {
  image: Buffer;
  thumbnail: Buffer;
  width: number;
  height: number;
  sha256: string;
  perceptualHash: string;
  detectorRegions: PrivacyRegion[];
  manualRegions: PrivacyRegion[];
  detector: DetectorOutcome;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isRetryableDetectorStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function callDetectorOnce(detectorUrl: string, buffer: Buffer): Promise<DetectorOutcome> {
  let response: Response;
  try {
    response = await fetch(detectorUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ imageBase64: buffer.toString("base64") }),
      signal: AbortSignal.timeout(config.PRIVACY_DETECTOR_TIMEOUT_MS)
    });
  } catch (error) {
    // Network error, connection refused, abort/timeout: the service is down.
    throw new MediaProcessingError(
      "DETECTOR_UNAVAILABLE",
      "transient",
      `Privacy detector unavailable: ${error instanceof Error ? error.message : "network error"}`,
      error
    );
  }

  if (!response.ok) {
    if (isRetryableDetectorStatus(response.status)) {
      throw new MediaProcessingError(
        "DETECTOR_UNAVAILABLE",
        "transient",
        `Privacy detector failed with ${response.status}`
      );
    }
    // A deterministic 4xx means this detector build rejects the request; retrying
    // won't help, but auto-publishing without its answer is not acceptable.
    return {
      status: "degraded",
      reason: "bad_response",
      error: `Privacy detector rejected the request with ${response.status}`,
      attempts: 1
    };
  }

  let payload: { regions?: unknown };
  try {
    payload = await response.json() as { regions?: unknown };
  } catch (error) {
    return {
      status: "degraded",
      reason: "bad_response",
      error: `Privacy detector returned unreadable JSON: ${error instanceof Error ? error.message : "parse error"}`,
      attempts: 1
    };
  }

  const parsed = privacyRegionSchema.array().max(100).safeParse(payload.regions ?? []);
  if (!parsed.success) {
    return {
      status: "degraded",
      reason: "invalid_response",
      error: `Privacy detector returned invalid regions: ${parsed.error.issues[0]?.message ?? "unknown"}`,
      attempts: 1
    };
  }
  return { status: "ok", regions: parsed.data };
}

/**
 * Calls the detector with a short bounded retry for transient outages.
 * Never throws for a detector outage: the final attempt resolves to a degraded
 * outcome so the caller can blur with manual regions and route to a human.
 */
export async function detectRegions(buffer: Buffer): Promise<DetectorOutcome> {
  const detectorUrl = config.PRIVACY_DETECTOR_URL;
  if (!detectorUrl) {
    return { status: "degraded", reason: "unavailable", error: "Privacy detector is not configured", attempts: 0 };
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= config.PRIVACY_DETECTOR_RETRIES; attempt += 1) {
    try {
      return await callDetectorOnce(detectorUrl, buffer);
    } catch (error) {
      lastError = error;
      if (attempt < config.PRIVACY_DETECTOR_RETRIES) {
        // Exponential backoff, e.g. 200ms, 400ms, ...
        await sleep(config.PRIVACY_DETECTOR_RETRY_BASE_MS * 2 ** (attempt - 1));
      }
    }
  }

  return {
    status: "degraded",
    reason: "unavailable",
    error: lastError instanceof MediaProcessingError
      ? lastError.message
      : "Privacy detector did not respond after retries",
    attempts: config.PRIVACY_DETECTOR_RETRIES
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function sanitizeRegion(region: PrivacyRegion): PrivacyRegion {
  const x = clamp(region.x, 0, 0.999);
  const y = clamp(region.y, 0, 0.999);
  const width = clamp(region.width, 0.001, 1 - x);
  const height = clamp(region.height, 0.001, 1 - y);
  return { x, y, width, height };
}

function expandRegion(region: PrivacyRegion): PrivacyRegion {
  const padding = config.PRIVACY_BLUR_PADDING;
  const x = Math.max(0, region.x - padding);
  const y = Math.max(0, region.y - padding);
  const right = Math.min(1, region.x + region.width + padding);
  const bottom = Math.min(1, region.y + region.height + padding);
  return { x, y, width: right - x, height: bottom - y };
}

function averageHash(input: Buffer): string {
  const bytes = Buffer.alloc(64);
  for (let index = 0; index < 64; index += 1) bytes[index] = input[index] ?? 0;
  const average = bytes.reduce((sum, value) => sum + value, 0) / bytes.length;
  let bits = "";
  for (const value of bytes) bits += value >= average ? "1" : "0";
  let hash = "";
  for (let index = 0; index < bits.length; index += 4) {
    hash += Number.parseInt(bits.slice(index, index + 4), 2).toString(16);
  }
  return hash;
}

function toMediaProcessingError(error: unknown): MediaProcessingError {
  const message = error instanceof Error ? error.message : "Image processing failed";
  if (/unsupported image format/i.test(message)) {
    return new MediaProcessingError("UNSUPPORTED_FORMAT", "permanent", message, error);
  }
  if (message.includes("pixel limit") || message.includes("exceeds the configured pixel limit")) {
    return new MediaProcessingError("IMAGE_TOO_LARGE", "permanent", message, error);
  }
  // Corrupt input that Sharp refuses is a property of the file, not infra.
  if (error instanceof Error && /Input (buffer|file|image) .*(corrupt|truncated|missing|unsupported)/i.test(message)) {
    return new MediaProcessingError("UNSUPPORTED_FORMAT", "permanent", message, error);
  }
  return new MediaProcessingError("IMAGE_PROCESSING_FAILED", "transient", message, error);
}

export async function processPrivacyImage(source: Buffer, manualRegions: PrivacyRegion[]): Promise<ProcessedImage> {
  let normalized: { data: Buffer; info: OutputInfo };
  try {
    const sourceImage = sharp(source, {
      failOn: "error",
      limitInputPixels: config.MEDIA_MAX_PIXELS
    });
    const sourceMetadata: Metadata = await sourceImage.metadata();
    if (!sourceMetadata.format || !["jpeg", "png", "webp"].includes(sourceMetadata.format)) {
      throw new MediaProcessingError(
        "UNSUPPORTED_FORMAT",
        "permanent",
        `Unsupported image format: ${sourceMetadata.format ?? "unknown"}`
      );
    }
    normalized = await sourceImage.rotate().toBuffer({ resolveWithObject: true });

    if (normalized.info.width * normalized.info.height > config.MEDIA_MAX_PIXELS) {
      throw new MediaProcessingError("IMAGE_TOO_LARGE", "permanent", "Image exceeds the configured pixel limit");
    }
  } catch (error) {
    throw error instanceof MediaProcessingError ? error : toMediaProcessingError(error);
  }

  const detector = await detectRegions(normalized.data);
  const detectorRegions = detector.status === "ok" ? detector.regions : [];
  const regions = [...manualRegions, ...detectorRegions].map(sanitizeRegion).map(expandRegion);
  const composites = [];

  try {
    for (const region of regions) {
      const left = Math.max(0, Math.floor(region.x * normalized.info.width));
      const top = Math.max(0, Math.floor(region.y * normalized.info.height));
      const width = Math.max(1, Math.min(normalized.info.width - left, Math.ceil(region.width * normalized.info.width)));
      const height = Math.max(1, Math.min(normalized.info.height - top, Math.ceil(region.height * normalized.info.height)));
      const sigma = Math.max(0.3, Math.min(config.PRIVACY_BLUR_SIGMA, Math.max(1, Math.min(width, height) / 4)));
      const blurred = await sharp(normalized.data)
        .extract({ left, top, width, height })
        .blur(sigma)
        .toBuffer();
      composites.push({ input: blurred, left, top });
    }

    let pipeline = sharp(normalized.data);
    if (composites.length) pipeline = pipeline.composite(composites);
    const image = await pipeline.webp({ quality: 86, effort: 4 }).toBuffer();

    const thumbnail = await sharp(image)
      .resize({ width: 720, height: 720, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 78, effort: 4 })
      .toBuffer();

    const hashInput = await sharp(image).resize(8, 8, { fit: "fill" }).grayscale().raw().toBuffer();

    return {
      image,
      thumbnail,
      width: normalized.info.width,
      height: normalized.info.height,
      sha256: createHash("sha256").update(image).digest("hex"),
      perceptualHash: averageHash(hashInput),
      detectorRegions,
      manualRegions,
      detector
    };
  } catch (error) {
    throw error instanceof MediaProcessingError ? error : toMediaProcessingError(error);
  }
}
