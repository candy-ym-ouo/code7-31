<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { apiFetch, uploadFile } from "../lib/api";

type PrivacyRegion = { x: number; y: number; width: number; height: number };
type MediaResult = { id: string; status: string; url: string | null; thumbnailUrl: string | null };

const props = defineProps<{ file: File }>();
const emit = defineEmits<{ processed: [value: MediaResult]; remove: [] }>();

const previewUrl = URL.createObjectURL(props.file);
const preview = ref<HTMLImageElement | null>(null);
const regions = ref<PrivacyRegion[]>([]);
const drawing = ref<PrivacyRegion | null>(null);
const pointerStart = ref<{ x: number; y: number } | null>(null);
const containsPeopleOrPlates = ref(true);
const rightsConfirmed = ref(false);
const status = ref("未处理");
const media = ref<MediaResult | null>(null);
const error = ref("");
const busy = ref(false);
const boxes = computed(() => drawing.value ? [...regions.value, drawing.value] : regions.value);

function normalizedPoint(event: PointerEvent) {
  const element = preview.value;
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
    y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height))
  };
}

function startDraw(event: PointerEvent) {
  if ((event.target as HTMLElement).closest(".region-box")) return;
  const point = normalizedPoint(event);
  if (!point) return;
  pointerStart.value = point;
  drawing.value = { x: point.x, y: point.y, width: 0, height: 0 };
  preview.value?.setPointerCapture(event.pointerId);
}

function moveDraw(event: PointerEvent) {
  if (!pointerStart.value) return;
  const point = normalizedPoint(event);
  if (!point) return;
  const x = Math.min(pointerStart.value.x, point.x);
  const y = Math.min(pointerStart.value.y, point.y);
  drawing.value = {
    x,
    y,
    width: Math.abs(point.x - pointerStart.value.x),
    height: Math.abs(point.y - pointerStart.value.y)
  };
}

function finishDraw(event: PointerEvent) {
  moveDraw(event);
  if (drawing.value && drawing.value.width > 0.01 && drawing.value.height > 0.01) {
    regions.value.push(drawing.value);
  }
  drawing.value = null;
  pointerStart.value = null;
  preview.value?.releasePointerCapture(event.pointerId);
}

function removeRegion(index: number) {
  regions.value.splice(index, 1);
}

async function processImage() {
  if (!rightsConfirmed.value) {
    error.value = "请先确认你拥有图片使用权并已完成隐私检查。";
    return;
  }
  busy.value = true;
  error.value = "";
  status.value = "创建隔离上传…";
  try {
    const init = await apiFetch<{ id: string; uploadUrl: string }>("/media/uploads", {
      method: "POST",
      body: {
        filename: props.file.name,
        mimeType: props.file.type,
        byteSize: props.file.size
      }
    });
    status.value = "上传到私有隔离区…";
    await uploadFile(init.uploadUrl, props.file);
    await completeUpload(init.id);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "图片处理失败";
    status.value = "失败";
  } finally {
    busy.value = false;
  }
}

async function completeUpload(mediaId: string) {
  status.value = "服务端处理隐私模糊…";
  try {
    await apiFetch(`/media/uploads/${mediaId}/complete`, {
      method: "POST",
      body: {
        privacyRegions: regions.value,
        containsPeopleOrPlates: containsPeopleOrPlates.value,
        rightsConfirmed: true
      }
    });
  } catch (cause) {
    // Queue unavailable: the server keeps the asset recoverable and processes it
    // automatically. Keep polling rather than telling the user it failed.
    status.value = "处理队列繁忙，等待自动重试…";
  }
  await pollUntilSettled(mediaId);
}

async function pollUntilSettled(mediaId: string) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const result = await apiFetch<MediaResult>(`/media/${mediaId}`);
    media.value = result;
    status.value = result.status;
    if (["ready", "manual_review", "failed", "rejected"].includes(result.status)) {
      emit("processed", result);
      if (result.status === "failed" || result.status === "rejected") {
        error.value = result.status === "rejected"
          ? "照片未通过人工隐私复核，可调整隐私框选后重试。"
          : "服务端处理失败，可点击重试，或删除后重新上传。";
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("处理仍在进行，请稍后在投稿页刷新媒体状态");
}

async function retryMedia() {
  if (!media.value) return;
  busy.value = true;
  error.value = "";
  status.value = "重新提交处理…";
  try {
    await apiFetch(`/media/${media.value.id}/retry`, { method: "POST" });
    await pollUntilSettled(media.value.id);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "重试失败";
    status.value = "失败";
  } finally {
    busy.value = false;
  }
}

onBeforeUnmount(() => URL.revokeObjectURL(previewUrl));
</script>

<template>
  <article class="uploader">
    <div class="inline" style="justify-content: space-between">
      <div>
        <strong>{{ file.name }}</strong>
        <div class="muted">{{ (file.size / 1024 / 1024).toFixed(2) }} MB · {{ status }}</div>
      </div>
      <button class="button ghost small" type="button" :disabled="busy" @click="emit('remove')">移除</button>
    </div>

    <div
      ref="preview"
      class="preview-wrap"
      @pointerdown="startDraw"
      @pointermove="moveDraw"
      @pointerup="finishDraw"
      @pointercancel="finishDraw"
    >
      <img :src="previewUrl" :alt="file.name" />
      <button
        v-for="(region, index) in boxes"
        :key="index"
        class="region-box"
        type="button"
        :style="{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%` }"
        :aria-label="`隐私区域 ${index + 1}`"
        @click.stop="index < regions.length && removeRegion(index)"
      />
    </div>
    <p class="muted">在图片上拖动框选人脸、车牌或其他敏感区域。点击已画区域可删除。</p>
    <label class="inline"><input v-model="containsPeopleOrPlates" type="checkbox" /> 图片可能包含人物或车牌</label>
    <label class="inline"><input v-model="rightsConfirmed" type="checkbox" /> 我拥有图片使用权，并确认需要处理的隐私区域</label>
    <p v-if="error" class="error-box">{{ error }}</p>
    <div class="inline" style="margin-top: 10px">
      <button class="button" type="button" :disabled="busy || (media !== null && !['failed', 'rejected'].includes(media.status))" @click="processImage">
        {{ busy ? "处理中…" : "上传并由服务端处理" }}
      </button>
      <button v-if="['failed', 'rejected'].includes(media?.status ?? '')" class="button secondary" type="button" :disabled="busy" @click="retryMedia">
        重试处理
      </button>
      <span v-if="media?.status === 'manual_review'" class="badge pending">等待审核员确认隐私处理（检测器不可用时也会进入此状态）</span>
      <span v-if="media?.status === 'ready'" class="badge">隐私处理通过</span>
    </div>
  </article>
</template>
