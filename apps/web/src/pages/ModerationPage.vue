<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { apiFetch } from "../lib/api";

type FeatureItem = {
  revision_id: string;
  feature_id: string;
  revision_no: number;
  payload: { title: string; description: string; categoryKey: string; mediaIds?: string[] };
  submitted_at: string;
  feature_status: string;
  author_name: string;
};
type CommentItem = { id: string; feature_id: string; body: string; created_at: string; author_name: string };
type MediaItem = {
  id: string;
  original_filename: string;
  privacy_status: string;
  privacy_report: { manualRegions?: unknown[]; detectorConfigured?: boolean; detectorDegraded?: boolean };
  processed_object_key: string | null;
  created_at: string;
  owner_name: string;
};
type ReportItem = {
  id: string;
  target_type: "feature" | "comment";
  target_id: string;
  reason_code: string;
  notes: string | null;
  created_at: string;
  reporter_name: string;
};
type Queue = {
  counts: { features: number; comments: number; media: number; reports: number };
  features: FeatureItem[];
  comments: CommentItem[];
  media: MediaItem[];
  reports: ReportItem[];
};

const queue = ref<Queue>({ counts: { features: 0, comments: 0, media: 0, reports: 0 }, features: [], comments: [], media: [], reports: [] });
const error = ref("");
const notice = ref("");
const active = ref<"features" | "comments" | "media" | "reports">("features");
const previews = reactive<Record<string, string>>({});

async function load() {
  try {
    queue.value = await apiFetch<Queue>("/moderation/queue");
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "加载审核队列失败";
  }
}

function decision() {
  const reasonCode = window.prompt("原因码，例如 INCOMPLETE_INFO、WRONG_LOCATION、PERSONAL_INFORMATION、SPAM") ?? "";
  const notes = window.prompt("审核备注（可选）") ?? undefined;
  return { reasonCode, notes };
}

async function featureAction(id: string, action: "approve" | "reject" | "request-changes" | "hide") {
  try {
    const body = action === "approve" ? undefined : decision();
    if (action !== "approve" && !body?.reasonCode) return;
    await apiFetch(`/moderation/features/${id}/${action}`, { method: "POST", body });
    notice.value = "审核动作已完成。";
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "审核失败";
  }
}

async function commentAction(id: string, action: "approve" | "reject" | "hide") {
  try {
    const body = action === "approve" ? undefined : decision();
    if (action !== "approve" && !body?.reasonCode) return;
    await apiFetch(`/moderation/comments/${id}/${action}`, { method: "POST", body });
    notice.value = "评论审核完成。";
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "评论审核失败";
  }
}

async function loadPreview(item: MediaItem) {
  try {
    const result = await apiFetch<{ url: string }>(`/media/${item.id}/preview`);
    previews[item.id] = result.url;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "无法生成预览";
  }
}

async function approveMedia(id: string) {
  try {
    await apiFetch(`/media/${id}/privacy-approve`, { method: "POST" });
    notice.value = "媒体隐私处理已确认，现已转为 ready。";
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "隐私确认失败";
  }
}

async function rejectMedia(id: string) {
  const reasonCode = window.prompt("拒绝原因码，例如 UNBLURRED_PRIVACY、PERSONAL_INFORMATION") ?? "";
  if (!reasonCode) return;
  const notes = window.prompt("审核备注（可选）") ?? undefined;
  try {
    await apiFetch(`/media/${id}/privacy-reject`, { method: "POST", body: { reasonCode, notes } });
    notice.value = "媒体已被拒绝，上传者已收到通知。";
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "媒体拒绝失败";
  }
}

async function resolveReport(id: string) {
  const actionRaw = window.prompt("处理动作：none、hide、restore", "none") ?? "none";
  const statusRaw = window.prompt("处理结果：resolved 或 dismissed", actionRaw === "none" ? "dismissed" : "resolved") ?? "dismissed";
  if (!["none", "hide", "restore"].includes(actionRaw) || !["resolved", "dismissed"].includes(statusRaw)) return;
  try {
    await apiFetch(`/moderation/reports/${id}/resolve`, {
      method: "POST",
      body: { action: actionRaw, status: statusRaw, notes: "由审核工作台处理" }
    });
    notice.value = "举报已处理。";
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "举报处理失败";
  }
}

onMounted(load);
</script>

<template>
  <section>
    <div class="page-heading">
      <div><h1>审核工作台</h1><p>所有批准、拒绝、隐私确认和举报处理都会写入审计日志。</p></div>
      <button class="button secondary" type="button" @click="load">刷新队列</button>
    </div>
    <p v-if="error" class="error-box">{{ error }}</p>
    <p v-if="notice" class="success-box">{{ notice }}</p>
    <div class="pill-tabs">
      <button :class="{ active: active === 'features' }" @click="active = 'features'">地点内容 {{ queue.counts.features }}</button>
      <button :class="{ active: active === 'comments' }" @click="active = 'comments'">评论 {{ queue.counts.comments }}</button>
      <button :class="{ active: active === 'media' }" @click="active = 'media'">隐私媒体 {{ queue.counts.media }}</button>
      <button :class="{ active: active === 'reports' }" @click="active = 'reports'">举报 {{ queue.counts.reports }}</button>
    </div>

    <div v-if="active === 'features'" class="moderation-grid">
      <article v-for="item in queue.features" :key="item.revision_id" class="card"><div class="card-body">
        <div class="inline"><span class="badge pending">待审核</span><span class="badge">{{ item.payload.categoryKey }}</span></div>
        <h3>{{ item.payload.title }}</h3>
        <p>{{ item.payload.description }}</p>
        <p class="muted">作者：{{ item.author_name }} · 修订 {{ item.revision_no }} · {{ new Date(item.submitted_at).toLocaleString() }}</p>
        <p v-if="item.payload.mediaIds?.length" class="notice-box">包含 {{ item.payload.mediaIds.length }} 张媒体，批准前所有媒体必须为 ready。</p>
        <div class="inline">
          <button class="button" @click="featureAction(item.feature_id, 'approve')">批准发布</button>
          <button class="button secondary" @click="featureAction(item.feature_id, 'request-changes')">要求修改</button>
          <button class="button danger" @click="featureAction(item.feature_id, 'reject')">拒绝</button>
          <button class="button ghost" @click="featureAction(item.feature_id, 'hide')">隐藏</button>
        </div>
      </div></article>
      <div v-if="!queue.features.length" class="card empty">没有待审核地点内容。</div>
    </div>

    <div v-if="active === 'comments'" class="moderation-grid">
      <article v-for="item in queue.comments" :key="item.id" class="card"><div class="card-body">
        <p>{{ item.body }}</p>
        <p class="muted">{{ item.author_name }} · {{ new Date(item.created_at).toLocaleString() }}</p>
        <div class="inline">
          <button class="button" @click="commentAction(item.id, 'approve')">批准</button>
          <button class="button danger" @click="commentAction(item.id, 'reject')">拒绝</button>
          <button class="button ghost" @click="commentAction(item.id, 'hide')">隐藏</button>
        </div>
      </div></article>
      <div v-if="!queue.comments.length" class="card empty">没有待审核评论。</div>
    </div>

    <div v-if="active === 'media'" class="moderation-grid">
      <article v-for="item in queue.media" :key="item.id" class="card"><div class="card-body">
        <h3>{{ item.original_filename }}</h3>
        <p class="muted">上传者：{{ item.owner_name }} · 人工框选 {{ item.privacy_report.manualRegions?.length ?? 0 }} 个区域</p>
        <p v-if="item.privacy_report.detectorDegraded" class="notice-box">自动检测器调用失败，已降级为仅人工框处理，请重点复核敏感区域。</p>
        <p class="notice-box">自动检测器{{ item.privacy_report.detectorConfigured ? "已启用" : "未启用" }}。服务端已应用人工框选，仍需审核员确认。</p>
        <img v-if="previews[item.id]" :src="previews[item.id]" alt="隐私处理结果预览" style="width:100%; border-radius:12px" />
        <div class="inline" style="margin-top: 12px">
          <button class="button secondary" @click="loadPreview(item)">生成 10 分钟预览</button>
          <button class="button" @click="approveMedia(item.id)">确认隐私并发布媒体</button>
          <button class="button danger" @click="rejectMedia(item.id)">拒绝媒体</button>
        </div>
      </div></article>
      <div v-if="!queue.media.length" class="card empty">没有待确认媒体。</div>
    </div>

    <div v-if="active === 'reports'" class="moderation-grid">
      <article v-for="item in queue.reports" :key="item.id" class="card"><div class="card-body">
        <div class="inline"><span class="badge pending">{{ item.target_type }}</span><span class="badge">{{ item.reason_code }}</span></div>
        <p>{{ item.notes || "无补充说明" }}</p>
        <p class="muted">举报人：{{ item.reporter_name }} · {{ new Date(item.created_at).toLocaleString() }}</p>
        <p class="muted">目标 ID：{{ item.target_id }}</p>
        <button class="button" @click="resolveReport(item.id)">处理举报</button>
      </div></article>
      <div v-if="!queue.reports.length" class="card empty">没有待处理举报。</div>
    </div>
  </section>
</template>
