import { afterAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import sharp from "sharp";

const baseEnv: Record<string, string> = {
  DATABASE_URL: "postgres://map:map@localhost:5432/map",
  S3_ENDPOINT: "http://localhost:9000",
  S3_PUBLIC_ENDPOINT: "http://localhost:9000",
  S3_ACCESS_KEY: "test",
  S3_SECRET_KEY: "test",
  S3_QUARANTINE_BUCKET: "quarantine",
  S3_PUBLIC_BUCKET: "public",
  PRIVACY_DETECTOR_URL: ""
};

async function loadPrivacy(env: Record<string, string> = {}) {
  Object.assign(process.env, baseEnv, env);
  vi.resetModules();
  return import("./privacy");
}

async function makeSource(): Promise<Buffer> {
  return sharp({
    create: { width: 320, height: 320, channels: 3, background: { r: 20, g: 40, b: 160 } }
  }).composite([{
    input: Buffer.from('<svg width="320" height="320"><rect x="120" y="120" width="80" height="80" fill="#ff0000"/></svg>'),
    top: 0,
    left: 0
  }]).png().toBuffer();
}

async function withDetector(
  handler: (body: string | undefined) => { status: number; payload?: unknown } | "hang",
  run: (detectorUrl: string) => Promise<void>
): Promise<void> {
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const action = handler(body);
      if (action === "hang") return;
      response.statusCode = action.status;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(action.payload ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}/detect`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("privacy image processing", () => {
  it("creates the public thumbnail from the blurred server output", async () => {
    const { processPrivacyImage } = await loadPrivacy();
    const source = await makeSource();

    const result = await processPrivacyImage(source, [{ x: 0.33, y: 0.33, width: 0.34, height: 0.34 }]);
    const directThumbnail = await sharp(source)
      .resize({ width: 720, height: 720, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 78, effort: 4 })
      .toBuffer();

    const processedRaw = await sharp(result.thumbnail).resize(64, 64, { fit: "fill" }).raw().toBuffer();
    const directRaw = await sharp(directThumbnail).resize(64, 64, { fit: "fill" }).raw().toBuffer();
    let difference = 0;
    for (let index = 0; index < processedRaw.length; index += 1) {
      difference += Math.abs((processedRaw[index] ?? 0) - (directRaw[index] ?? 0));
    }
    expect(result.image.length).toBeGreaterThan(0);
    expect(result.thumbnail.length).toBeGreaterThan(0);
    expect(difference).toBeGreaterThan(500);
    expect(result.detectorDegraded).toBeNull();
  });
});

describe("privacy detector degradation", () => {
  it("uses detector regions when the detector responds successfully", async () => {
    await withDetector(
      () => ({ status: 200, payload: { regions: [{ x: 0.3, y: 0.3, width: 0.2, height: 0.2 }] } }),
      async (detectorUrl) => {
        const { processPrivacyImage } = await loadPrivacy({ PRIVACY_DETECTOR_URL: detectorUrl });
        const result = await processPrivacyImage(await makeSource(), []);
        expect(result.detectorDegraded).toBeNull();
        expect(result.detectorRegions).toHaveLength(1);
      }
    );
  });

  it("degrades to manual regions when the detector is unreachable", async () => {
    const { processPrivacyImage } = await loadPrivacy({ PRIVACY_DETECTOR_URL: "http://127.0.0.1:1/detect" });
    const result = await processPrivacyImage(await makeSource(), [{ x: 0.1, y: 0.1, width: 0.2, height: 0.2 }]);
    expect(result.detectorDegraded).toBeTruthy();
    expect(result.detectorRegions).toHaveLength(0);
    expect(result.image.length).toBeGreaterThan(0);
  });

  it("degrades when the detector responds with an error status", async () => {
    await withDetector(
      () => ({ status: 500 }),
      async (detectorUrl) => {
        const { processPrivacyImage } = await loadPrivacy({ PRIVACY_DETECTOR_URL: detectorUrl });
        const result = await processPrivacyImage(await makeSource(), []);
        expect(result.detectorDegraded).toContain("500");
        expect(result.detectorRegions).toHaveLength(0);
      }
    );
  });

  it("degrades when the detector returns an invalid payload", async () => {
    await withDetector(
      () => ({ status: 200, payload: { regions: [{ x: "not-a-number" }] } }),
      async (detectorUrl) => {
        const { processPrivacyImage } = await loadPrivacy({ PRIVACY_DETECTOR_URL: detectorUrl });
        const result = await processPrivacyImage(await makeSource(), []);
        expect(result.detectorDegraded).toBeTruthy();
        expect(result.detectorRegions).toHaveLength(0);
      }
    );
  });

  it("degrades when the detector times out", async () => {
    await withDetector(
      () => "hang",
      async (detectorUrl) => {
        const { processPrivacyImage } = await loadPrivacy({
          PRIVACY_DETECTOR_URL: detectorUrl,
          PRIVACY_DETECTOR_TIMEOUT_MS: "100"
        });
        const result = await processPrivacyImage(await makeSource(), []);
        expect(result.detectorDegraded).toBeTruthy();
        expect(result.detectorRegions).toHaveLength(0);
      }
    );
  });

  it("still blurs manual regions while degraded", async () => {
    const { processPrivacyImage } = await loadPrivacy({ PRIVACY_DETECTOR_URL: "http://127.0.0.1:1/detect" });
    const source = await makeSource();
    const result = await processPrivacyImage(source, [{ x: 0.33, y: 0.33, width: 0.34, height: 0.34 }]);
    expect(result.detectorDegraded).toBeTruthy();

    const directThumbnail = await sharp(source)
      .resize({ width: 720, height: 720, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 78, effort: 4 })
      .toBuffer();
    const processedRaw = await sharp(result.thumbnail).resize(64, 64, { fit: "fill" }).raw().toBuffer();
    const directRaw = await sharp(directThumbnail).resize(64, 64, { fit: "fill" }).raw().toBuffer();
    let difference = 0;
    for (let index = 0; index < processedRaw.length; index += 1) {
      difference += Math.abs((processedRaw[index] ?? 0) - (directRaw[index] ?? 0));
    }
    expect(difference).toBeGreaterThan(500);
  });
});

describe("resolveMediaStatusAfterProcessing", () => {
  it("returns ready only when the detector is configured and healthy", async () => {
    const { resolveMediaStatusAfterProcessing } = await loadPrivacy({ PRIVACY_DETECTOR_URL: "http://127.0.0.1:1/detect" });
    expect(resolveMediaStatusAfterProcessing({ detectorConfigured: true, detectorDegraded: null })).toBe("ready");
    expect(resolveMediaStatusAfterProcessing({ detectorConfigured: true, detectorDegraded: "timeout" })).toBe("manual_review");
    expect(resolveMediaStatusAfterProcessing({ detectorConfigured: false, detectorDegraded: null })).toBe("manual_review");
  });
});

afterAll(() => {
  vi.resetModules();
});
