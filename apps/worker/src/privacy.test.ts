import { beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";

let processPrivacyImage: typeof import("./privacy").processPrivacyImage;

beforeAll(async () => {
  process.env.DATABASE_URL = "postgres://map:map@localhost:5432/map";
  process.env.S3_ENDPOINT = "http://localhost:9000";
  process.env.S3_PUBLIC_ENDPOINT = "http://localhost:9000";
  process.env.S3_ACCESS_KEY = "test";
  process.env.S3_SECRET_KEY = "test";
  process.env.S3_QUARANTINE_BUCKET = "quarantine";
  process.env.S3_PUBLIC_BUCKET = "public";
  process.env.PRIVACY_DETECTOR_URL = "";
  process.env.PRIVACY_DETECTOR_RETRIES = "1";
  process.env.PRIVACY_DETECTOR_RETRY_BASE_MS = "1";
  const module = await import("./privacy");
  processPrivacyImage = module.processPrivacyImage;
});

describe("privacy image processing", () => {
  it("creates the public thumbnail from the blurred server output", async () => {
    const source = await sharp({
      create: { width: 320, height: 320, channels: 3, background: { r: 20, g: 40, b: 160 } }
    }).composite([{
      input: Buffer.from('<svg width="320" height="320"><rect x="120" y="120" width="80" height="80" fill="#ff0000"/></svg>'),
      top: 0,
      left: 0
    }]).png().toBuffer();

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
  });

  it("reports a degraded detector outcome when no detector is configured", async () => {
    const source = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 10, g: 20, b: 30 } }
    }).png().toBuffer();

    const result = await processPrivacyImage(source, []);
    expect(result.detector.status).toBe("degraded");
    expect(result.detectorRegions).toEqual([]);
  });

  it("rejects unsupported image formats with a permanent error", async () => {
    const source = Buffer.from("this is not an image");
    await expect(processPrivacyImage(source, [])).rejects.toMatchObject({
      name: "MediaProcessingError",
      code: "UNSUPPORTED_FORMAT",
      kind: "permanent"
    });
  });
});

