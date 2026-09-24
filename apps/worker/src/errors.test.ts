import { describe, expect, it } from "vitest";
import { classifyClamavError, classifyMediaError, MediaProcessingError } from "./errors";

describe("classifyMediaError", () => {
  it("treats explicit permanent media errors as non-retryable", () => {
    const result = classifyMediaError(new MediaProcessingError("MALWARE_DETECTED", "permanent", "Malware detected: x"));
    expect(result.kind).toBe("permanent");
    expect(result.retryable).toBe(false);
    expect(result.code).toBe("MALWARE_DETECTED");
  });

  it("treats unknown errors as transient so they are retried before failing", () => {
    const result = classifyMediaError(new Error("ECONNRESET"));
    expect(result.kind).toBe("transient");
    expect(result.retryable).toBe(true);
  });

  it("classifies ClamAV malware hits as permanent and scanner outages as transient", () => {
    const malware = classifyClamavError(new Error("Malware detected: Eicar-Test-Signature"));
    expect(malware.kind).toBe("permanent");
    expect(malware.code).toBe("MALWARE_DETECTED");

    const timeout = classifyClamavError(new Error("ClamAV scan timed out"));
    expect(timeout.kind).toBe("transient");
    expect(timeout.code).toBe("CLAMAV_UNAVAILABLE");
  });
});
