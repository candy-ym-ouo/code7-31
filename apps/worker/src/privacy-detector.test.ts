import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

let processPrivacyImage: typeof import("./privacy").processPrivacyImage;

let server: Server;
let baseUrl: string;
let handler: ((req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void) | null = null;
const calls: string[] = [];

async function sampleImage(): Promise<Buffer> {
  return sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 10, g: 20, b: 30 } }
  }).png().toBuffer();
}

beforeAll(async () => {
  process.env.DATABASE_URL = "postgres://map:map@localhost:5432/map";
  process.env.S3_ENDPOINT = "http://localhost:9000";
  process.env.S3_PUBLIC_ENDPOINT = "http://localhost:9000";
  process.env.S3_ACCESS_KEY = "test";
  process.env.S3_SECRET_KEY = "test";
  process.env.S3_QUARANTINE_BUCKET = "quarantine";
  process.env.S3_PUBLIC_BUCKET = "public";
  // Bounded, fast retry policy for the tests.
  process.env.PRIVACY_DETECTOR_TIMEOUT_MS = "300";
  process.env.PRIVACY_DETECTOR_RETRIES = "3";
  process.env.PRIVACY_DETECTOR_RETRY_BASE_MS = "2";

  server = createServer((req, res) => {
    calls.push(req.url ?? "/");
    if (handler) handler(req, res);
    else { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.PRIVACY_DETECTOR_URL = `${baseUrl}/detect`;

  const module = await import("./privacy");
  processPrivacyImage = module.processPrivacyImage;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  calls.length = 0;
  handler = null;
});

describe("privacy detector recovery", () => {
  it("degrades to manual review instead of throwing when the detector times out", async () => {
    handler = (_req, res) => {
      // Never respond within the 300ms timeout.
      setTimeout(() => res.end(), 2_000);
    };

    const result = await processPrivacyImage(await sampleImage(), []);
    expect(result.detector.status).toBe("degraded");
    expect(result.detector).toMatchObject({ reason: "unavailable" });
    expect(result.detectorRegions).toEqual([]);
    // One initial call + retries, and the image is still produced with manual regions.
    expect(calls.length).toBe(3);
    expect(result.image.length).toBeGreaterThan(0);
  });

  it("retries through a 503 outage and degrades after the budget is exhausted", async () => {
    handler = (_req, res) => { res.statusCode = 503; res.end(); };

    const result = await processPrivacyImage(await sampleImage(), []);
    expect(result.detector.status).toBe("degraded");
    expect(result.detector).toMatchObject({ reason: "unavailable" });
    expect(calls.length).toBe(3);
  });

  it("degrades immediately (without retry storm) on a deterministic 400", async () => {
    handler = (_req, res) => { res.statusCode = 400; res.end(); };

    const result = await processPrivacyImage(await sampleImage(), []);
    expect(result.detector.status).toBe("degraded");
    expect(result.detector).toMatchObject({ reason: "bad_response" });
    expect(calls.length).toBe(1);
  });

  it("degrades on an invalid region payload rather than trusting it", async () => {
    handler = (_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ regions: [{ x: 5 }] }));
    };

    const result = await processPrivacyImage(await sampleImage(), []);
    expect(result.detector.status).toBe("degraded");
    expect(result.detector).toMatchObject({ reason: "invalid_response" });
    expect(result.detectorRegions).toEqual([]);
  });

  it("uses detector regions when the detector responds healthily", async () => {
    handler = (_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ regions: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.2 }] }));
    };

    const result = await processPrivacyImage(await sampleImage(), []);
    expect(result.detector.status).toBe("ok");
    expect(result.detectorRegions).toHaveLength(1);
    expect(calls.length).toBe(1);
  });

  it("recovers when the detector is briefly down then healthy on retry", async () => {
    let attempts = 0;
    handler = (_req, res) => {
      attempts += 1;
      if (attempts < 2) { res.statusCode = 500; res.end(); return; }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ regions: [] }));
    };

    const result = await processPrivacyImage(await sampleImage(), []);
    expect(result.detector.status).toBe("ok");
    expect(attempts).toBe(2);
  });
});
