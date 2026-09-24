/**
 * Classified privacy/media pipeline errors.
 *
 * The pipeline distinguishes three failure families so a dependency outage can
 * never permanently fail a piece of media:
 *
 * - "transient": infrastructure hiccup (network, timeout, storage, ClamAV down).
 *   The job is retried; once the attempt budget is exhausted it falls back to a
 *   human, never to an automatic public failure.
 * - "detector": the privacy detector is unavailable or returned an unusable
 *   answer. Processing still succeeds using the operator/member regions and the
 *   result is routed to manual_review instead of auto-publishing.
 * - "permanent": deterministic rejection of the asset itself (unsupported format,
 *   too many pixels, malware). Retrying cannot help; the media is marked failed.
 */
export type MediaErrorKind = "transient" | "detector" | "permanent";

const PERMANENT_CODES = new Set([
  "MALWARE_DETECTED",
  "UNSUPPORTED_FORMAT",
  "IMAGE_TOO_LARGE",
  "MEDIA_RECORD_MISSING",
  "SOURCE_OBJECT_MISSING"
]);

const DETECTOR_CODES = new Set([
  "DETECTOR_UNAVAILABLE",
  "DETECTOR_BAD_RESPONSE",
  "DETECTOR_INVALID_RESPONSE",
  "DETECTOR_MISCONFIGURED"
]);

export class MediaProcessingError extends Error {
  readonly code: string;
  readonly kind: MediaErrorKind;
  readonly cause?: unknown;

  constructor(code: string, kind: MediaErrorKind, message: string, cause?: unknown) {
    super(message);
    this.name = "MediaProcessingError";
    this.code = code;
    this.kind = kind;
    this.cause = cause;
  }
}

function failureCodeFromError(error: unknown): string {
  if (error instanceof MediaProcessingError) return error.code;
  if (error instanceof Error) {
    const normalized = error.message.slice(0, 80).toUpperCase().replaceAll(/[^A-Z0-9]+/g, "_");
    return normalized ? `UNCLASSIFIED_${normalized}`.slice(0, 120) : "UNCLASSIFIED_ERROR";
  }
  return "UNCLASSIFIED_ERROR";
}

export type ClassifiedError = {
  kind: MediaErrorKind;
  code: string;
  message: string;
  retryable: boolean;
};

export function classifyMediaError(error: unknown): ClassifiedError {
  if (error instanceof MediaProcessingError) {
    return {
      kind: error.kind,
      code: error.code,
      message: error.message,
      retryable: error.kind === "transient"
    };
  }

  const message = error instanceof Error ? error.message : "Unknown media processing error";
  const code = failureCodeFromError(error);

  if (PERMANENT_CODES.has(code)) {
    return { kind: "permanent", code, message, retryable: false };
  }
  if (DETECTOR_CODES.has(code)) {
    return { kind: "detector", code, message, retryable: false };
  }

  // Unknown failures are treated as transient and retried. Failing safe means we
  // prefer an extra pass (and eventual manual review) over losing the upload.
  return { kind: "transient", code, message, retryable: true };
}

/**
 * Map a ClamAV scan failure to a kind. Malware hits are permanent rejections of
 * the asset; scanner outages are transient dependency failures.
 */
export function classifyClamavError(error: unknown): MediaProcessingError {
  const message = error instanceof Error ? error.message : "Malware scan failed";
  if (message.startsWith("Malware detected")) {
    return new MediaProcessingError("MALWARE_DETECTED", "permanent", message, error);
  }
  return new MediaProcessingError("CLAMAV_UNAVAILABLE", "transient", message, error);
}
