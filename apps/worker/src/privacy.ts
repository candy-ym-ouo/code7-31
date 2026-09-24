import { createHash } from "node:crypto";
import sharp from "sharp";
import { privacyRegionSchema, type PrivacyRegion } from "@map/shared/contracts";
import { config } from "./config";

export type DetectorResponse = {
  regions?: PrivacyRegion[];
};

export type ProcessedImage = {
  image: Buffer;
  thumbnail: Buffer;
  width: number;
  height: number;
  sha256: string;
  perceptualHash: string;
  detectorRegions: PrivacyRegion[];
  manualRegions: PrivacyRegion[];
  /**
   * 检测器已配置但调用失败（超时、不可达、非法响应）时的降级原因。
   * 为 null 表示检测器未配置或调用成功。非 null 时媒体必须进入人工复核，
   * 不得自动发布（项目文档 §6.3、验收场景 A14）。
   */
  detectorDegraded: string | null;
};

async function detectRegions(buffer: Buffer): Promise<PrivacyRegion[]> {
  if (!config.PRIVACY_DETECTOR_URL) return [];
  const response = await fetch(config.PRIVACY_DETECTOR_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ imageBase64: buffer.toString("base64") }),
    signal: AbortSignal.timeout(config.PRIVACY_DETECTOR_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`Privacy detector failed with ${response.status}`);
  const payload = await response.json() as DetectorResponse;
  const parsed = privacyRegionSchema.array().max(100).safeParse(payload.regions ?? []);
  if (!parsed.success) throw new Error(`Privacy detector returned invalid regions: ${parsed.error.issues[0]?.message ?? "unknown"}`);
  return parsed.data;
}

/**
 * 处理完成后的媒体状态决策：只有检测器已配置且本次调用成功时才允许 ready；
 * 检测器未配置或已降级（超时、不可用、非法响应）一律进入人工复核。
 */
export function resolveMediaStatusAfterProcessing(input: {
  detectorConfigured: boolean;
  detectorDegraded: string | null;
}): "ready" | "manual_review" {
  if (!input.detectorConfigured || input.detectorDegraded) return "manual_review";
  return "ready";
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

export async function processPrivacyImage(source: Buffer, manualRegions: PrivacyRegion[]): Promise<ProcessedImage> {
  const sourceImage = sharp(source, {
    failOn: "error",
    limitInputPixels: config.MEDIA_MAX_PIXELS
  });
  const sourceMetadata = await sourceImage.metadata();
  if (!sourceMetadata.format || !["jpeg", "png", "webp"].includes(sourceMetadata.format)) {
    throw new Error(`Unsupported image format: ${sourceMetadata.format ?? "unknown"}`);
  }
  const normalized = await sourceImage
    .rotate()
    .toBuffer({ resolveWithObject: true });

  if (normalized.info.width * normalized.info.height > config.MEDIA_MAX_PIXELS) {
    throw new Error("Image exceeds the configured pixel limit");
  }

  let detectorRegions: PrivacyRegion[] = [];
  let detectorDegraded: string | null = null;
  try {
    detectorRegions = await detectRegions(normalized.data);
  } catch (error) {
    // 检测器超时或不可用不得让媒体直接失败：降级为仅人工框处理，
    // 由媒体任务把结果转入 manual_review，绝不自动公开。
    detectorDegraded = error instanceof Error ? error.message.slice(0, 300) : "Privacy detector unavailable";
    console.warn({ error: detectorDegraded }, "privacy detector degraded, falling back to manual review");
  }
  const regions = [...manualRegions, ...detectorRegions].map(sanitizeRegion).map(expandRegion);
  const composites = [];

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
    detectorDegraded
  };
}
