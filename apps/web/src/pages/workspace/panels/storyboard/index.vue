<template>
  <section class="storyboardPage" aria-label="分镜检测">
    <header class="pageHeader">
      <el-select v-model="currentId" class="segmentSelect" size="small" placeholder="选择分段" :disabled="!segments.length">
        <el-option v-for="segment in segments" :key="segment.id" :label="`${segment.id} · ${segment.shotCount} 镜`" :value="segment.id" />
      </el-select>
      <template v-if="currentSegment">
        <el-tag size="small">镜 {{ currentSegment.shotCount }}</el-tag>
        <el-tag size="small">总时长 {{ totalDuration }}s</el-tag>
        <el-tag size="small" :type="currentSegment.frameCount === currentSegment.shotCount ? 'success' : 'warning'">
          关键帧 {{ currentSegment.frameCount }}/{{ currentSegment.shotCount }}
        </el-tag>
        <el-tag size="small" :type="currentSegment.imageCount === currentSegment.shotCount ? 'success' : 'info'">
          素材图 {{ currentSegment.imageCount }}/{{ currentSegment.shotCount }}
        </el-tag>
        <el-tag size="small" :type="currentSegment.video.exists ? 'success' : 'info'">
          {{ currentSegment.video.exists ? `视频已归位 ${currentSegment.video.name}` : `视频缺失 ${currentSegment.video.name}` }}
        </el-tag>
      </template>
      <el-tag v-if="pending.length" size="small" type="warning">待归位 {{ pending.length }}</el-tag>
      <span class="pageTip">视频放入 生成/待归位/ 后按缺失段号自动改名归位</span>
      <el-button class="refreshButton" text size="small" :icon="IconRefresh" @click="refresh">刷新</el-button>
    </header>

    <!-- ACT: 参考图素材来自 Seedance 提示词的素材清单，固定放在页面最上方方便对账。 -->
    <div v-if="currentSegment?.references.length" class="referenceStrip" aria-label="参考图素材">
      <article v-for="ref in currentSegment.references" :key="ref.label" class="referenceCard" :title="`${ref.name} · ${ref.note}`">
        <div class="referenceThumb">
          <img v-if="ref.path && imageUrls[ref.path]" :src="imageUrls[ref.path]" :alt="ref.name" />
          <span v-else class="thumbMissing">缺图</span>
        </div>
        <div class="referenceInfo">
          <b>{{ ref.label }}</b>
          <span class="referenceName">{{ ref.name }}</span>
          <span class="referenceUsage">{{ ref.usage || ref.type }}</span>
        </div>
      </article>
      <span v-if="currentSegment.prompt" class="referenceSource">{{ currentSegment.prompt.file }}</span>
    </div>

    <p v-if="error" class="pageHint">{{ error }}</p>
    <p v-else-if="!segments.length" class="pageHint">没有找到 分镜表/*_导出/分镜脚本.json</p>

    <template v-else-if="currentSegment">
      <div class="timeline" role="group" aria-label="时间轴">
        <div class="sceneRow">
          <span v-for="group in sceneGroups" :key="group.key" class="sceneCell" :style="{ flexGrow: group.duration }">
            {{ group.label }} · {{ group.shots.length }} 镜 / {{ formatDuration(group.duration) }}s
          </span>
        </div>
        <div class="shotRow">
          <button
            v-for="shot in currentSegment.shots"
            :key="shot.no"
            type="button"
            class="shotCell"
            :class="{ active: shot.no === selected?.no, missing: !shot.frame }"
            :style="{ flexGrow: shotDuration(shot) }"
            :title="`${shot.no} · ${shot.size} · ${shot.dur}s`"
            @click="selectedNo = shot.no">
            <span class="shotNo">{{ shotLabel(shot) }}</span>
            <span class="shotMeta">{{ shot.size || "—" }} · {{ shot.dur || "—" }}s</span>
          </button>
        </div>
      </div>

      <div ref="pageBody" class="pageBody" :class="{ resizing: splitterActive }" :style="{ '--inspector-width': `${inspectorWidth}px` }">
        <el-scrollbar class="shotList">
          <article
            v-for="shot in currentSegment.shots"
            :key="shot.no"
            class="shotCard"
            :class="{ active: shot.no === selected?.no, missing: !shot.frame }"
            @click="selectedNo = shot.no">
            <div class="shotThumb">
              <img v-if="previewUrl(shot)" :src="previewUrl(shot)" :alt="shot.asset" loading="lazy" />
              <span v-else class="thumbMissing">缺帧</span>
            </div>
            <div class="shotInfo">
              <div class="shotHead">
                <span class="shotTitle">{{ shot.no }}</span>
                <span class="shotMeta">{{ shot.size || "—" }} · {{ shot.angle || "—" }} · {{ shot.dur || "—" }}s</span>
              </div>
              <p class="shotVisual">{{ shot.visual || "（画面内容未填）" }}</p>
              <p class="shotExtra">{{ shot.asset || "无资产编号" }}</p>
            </div>
          </article>
        </el-scrollbar>

        <div
          class="paneSplitter"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整左右面板宽度"
          title="拖动调整左右面板宽度"
          @pointerdown="startResize" />

        <aside class="inspector" aria-label="镜头检查器">
          <header class="inspectorHeader">
            <span class="inspectorTitle">{{ selected?.no }}</span>
            <div class="inspectorNav">
              <el-button text size="small" :icon="IconChevronLeft" :disabled="selectedIndex <= 0" aria-label="上一镜" @click="stepShot(-1)" />
              <span class="inspectorCount">{{ selectedIndex + 1 }} / {{ currentSegment.shots.length }}</span>
              <el-button text size="small" :icon="IconChevronRight" :disabled="selectedIndex >= currentSegment.shots.length - 1" aria-label="下一镜" @click="stepShot(1)" />
            </div>
          </header>

          <el-segmented v-model="inspectorTab" class="inspectorTabs" :options="inspectorTabs" size="small" aria-label="检查器视图" />

          <el-scrollbar v-if="selected" class="inspectorBody">
            <template v-if="inspectorTab === 'fields'">
              <div class="fieldGrid">
                <span v-for="field in fieldList" :key="field.label" class="fieldChip" :class="{ empty: !field.value || field.value === '—' }">
                  <em>{{ field.label }}</em>
                  {{ field.value || "未填" }}
                </span>
              </div>
              <div class="textBlocks">
                <div v-for="block in textBlocks" :key="block.label" class="textBlock" :class="{ empty: !block.value || block.value === '—' }">
                  <b>{{ block.label }}</b>
                  <p>{{ block.value || "未填" }}</p>
                </div>
              </div>
            </template>

            <template v-else-if="inspectorTab === 'prompt'">
              <div class="promptToolbar">
                <el-segmented v-model="promptScope" :options="promptScopeOptions" size="small" aria-label="提示词范围" />
                <el-button size="small" :icon="IconCopy" :disabled="!promptText" @click="copyPrompt">复制</el-button>
              </div>
              <pre class="promptText">{{ promptText || "该镜没有可用的提示词" }}</pre>
              <span v-if="currentSegment.prompt" class="promptSource">来源 {{ currentSegment.prompt.file }}</span>
              <span v-else class="promptSource">未找到 Seedance 提示词文件，显示由分镜字段拼接的内容</span>
            </template>

            <template v-else>
              <div class="mediaBlock">
                <b>关键帧 · 预览</b>
                <div class="mediaBox imageBox">
                  <img v-if="selected.frame && imageUrls[selected.frame.path]" :src="imageUrls[selected.frame.path]" :alt="`${selected.no} 关键帧`" />
                  <span v-else class="mediaMissing">待生成 · 段视频就绪后自动按镜时长截取</span>
                </div>
                <span class="mediaMeta">{{ selected.frame?.path ?? "未生成关键帧" }}</span>
              </div>
              <div class="mediaBlock">
                <b>素材图 · {{ selected.asset || "无素材编号" }}</b>
                <div class="mediaBox imageBox">
                  <img v-if="selected.image && imageUrls[selected.image.path]" :src="imageUrls[selected.image.path]" :alt="selected.asset" />
                  <span v-else class="mediaMissing">缺图 · 资产/ 中未找到 {{ selected.asset || "同名文件" }}</span>
                </div>
                <span class="mediaMeta">{{ selected.image?.name ?? "未放置图片" }}</span>
              </div>
              <div class="mediaBlock">
                <b>段视频 · {{ currentSegment.video.name }}</b>
                <div class="mediaBox videoBox">
                  <video v-if="videoUrl" :src="videoUrl" controls preload="metadata"></video>
                  <span v-else class="mediaMissing">待生成 · 放入 生成/待归位/ 自动归位</span>
                </div>
                <span class="mediaMeta">{{ currentSegment.video.path }}</span>
              </div>
            </template>
          </el-scrollbar>
        </aside>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import axios from "axios";
import { ElMessage } from "element-plus";
import { IconChevronLeft, IconChevronRight, IconCopy, IconRefresh } from "@tabler/icons-vue";
import { useWorkspaceStore } from "@/stores/workspace";
import useWorkspaceFiles from "@/lib/workspaceFiles";

type Shot = {
  no: string;
  scene: string;
  size: string;
  angle: string;
  pos: string;
  move: string;
  lens: string;
  dur: string;
  visual: string;
  action: string;
  line: string;
  sfx: string;
  trans: string;
  light: string;
  color: string;
  prop: string;
  wardrobe: string;
  vfx: string;
  beat: string;
  risk: string;
  asset: string;
  prompt: string;
  image: { name: string; path: string } | null;
  frame: { name: string; path: string } | null;
};
type Reference = {
  label: string;
  name: string;
  type: string;
  note: string;
  usage: string;
  path: string | null;
};
type Segment = {
  id: string;
  number: string;
  shotCount: number;
  imageCount: number;
  frameCount: number;
  video: { name: string; path: string; exists: boolean };
  references: Reference[];
  prompt: { file: string; full: string; shots: { no: string; text: string }[] } | null;
  shots: Shot[];
};
type Snapshot = { segments: Segment[]; pending: string[] };

const segmentPollInterval = 3000;
const inspectorTabs = [
  { label: "字段", value: "fields" },
  { label: "提示词", value: "prompt" },
  { label: "素材", value: "media" },
];
const promptScopeOptions = [
  { label: "当前镜", value: "shot" },
  { label: "整段", value: "segment" },
];

const workspace = useWorkspaceStore();
const files = useWorkspaceFiles();
const snapshot = shallowRef<Snapshot>({ segments: [], pending: [] });
const currentId = ref("");
const selectedNo = ref("");
const inspectorTab = ref<"fields" | "prompt" | "media">("fields");
const promptScope = ref<"shot" | "segment">("shot");
const error = ref("");
const imageUrls = shallowRef<Record<string, string>>({});
const videoUrl = shallowRef<string>();

// ACT: 左右面板分栏宽度；默认 360px，拖动后写入 localStorage 便于下次沿用。
const inspectorWidthKey = "toonflow.storyboard.inspectorWidth";
const minPaneWidth = 280;
const pageBody = ref<HTMLElement>();
const splitterActive = ref(false);
const inspectorWidth = ref((() => {
  const saved = Number.parseFloat(localStorage.getItem(inspectorWidthKey) ?? "");
  return Number.isFinite(saved) && saved >= minPaneWidth ? saved : 360;
})());
let stopResize: (() => void) | null = null;

function startResize(event: PointerEvent) {
  const body = pageBody.value;
  if (!body || event.button !== 0) return;
  event.preventDefault();
  splitterActive.value = true;
  const rect = body.getBoundingClientRect();
  const maxWidth = Math.max(minPaneWidth, rect.width - minPaneWidth);
  const move = (moveEvent: PointerEvent) => {
    inspectorWidth.value = Math.round(Math.min(maxWidth, Math.max(minPaneWidth, rect.right - moveEvent.clientX)));
  };
  const finish = () => {
    splitterActive.value = false;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", finish);
    stopResize = null;
    localStorage.setItem(inspectorWidthKey, String(inspectorWidth.value));
  };
  stopResize = finish;
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", finish);
  window.addEventListener("pointercancel", finish);
}

const segments = computed(() => snapshot.value.segments);
const pending = computed(() => snapshot.value.pending);
const currentSegment = computed(() => segments.value.find(segment => segment.id === currentId.value));
const selected = computed(() => currentSegment.value?.shots.find(shot => shot.no === selectedNo.value) ?? currentSegment.value?.shots[0]);
const selectedIndex = computed(() => (currentSegment.value?.shots.findIndex(shot => shot.no === selected.value?.no) ?? -1));
const totalDuration = computed(() => formatDuration((currentSegment.value?.shots ?? []).reduce((sum, shot) => sum + shotDuration(shot), 0)));
const sceneGroups = computed(() => {
  const groups: { key: string; label: string; duration: number; shots: Shot[] }[] = [];
  for (const shot of currentSegment.value?.shots ?? []) {
    const key = /^SC\d+/.exec(shot.scene)?.[0] ?? shot.scene ?? shot.no;
    const group = groups.find(item => item.key === key);
    if (group) {
      group.duration += shotDuration(shot);
      group.shots.push(shot);
    } else {
      groups.push({ key, label: shot.scene || key, duration: shotDuration(shot), shots: [shot] });
    }
  }
  return groups;
});
const fieldList = computed(() => {
  const shot = selected.value;
  if (!shot) return [];
  return [
    { label: "镜号", value: shot.no },
    { label: "场景", value: shot.scene },
    { label: "景别", value: shot.size },
    { label: "摄法", value: shot.angle },
    { label: "机位", value: shot.pos },
    { label: "运镜", value: shot.move },
    { label: "焦段", value: shot.lens },
    { label: "时长", value: shot.dur ? `${shot.dur}s` : "" },
    { label: "节拍", value: shot.beat },
    { label: "转场", value: shot.trans },
    { label: "台词", value: shot.line },
    { label: "声音", value: shot.sfx },
    { label: "素材", value: shot.asset },
  ];
});
const textBlocks = computed(() => {
  const shot = selected.value;
  if (!shot) return [];
  return [
    { label: "画面内容", value: shot.visual },
    { label: "人物动作", value: shot.action },
    { label: "光线", value: shot.light },
    { label: "色彩", value: shot.color },
    { label: "道具", value: shot.prop },
    { label: "服装", value: shot.wardrobe },
    { label: "特效", value: shot.vfx },
    { label: "风险", value: shot.risk },
  ];
});
const promptText = computed(() => {
  const shot = selected.value;
  if (!shot) return "";
  const prompt = currentSegment.value?.prompt;
  if (promptScope.value === "segment") return prompt?.full || shot.prompt;
  return prompt?.shots.find(item => item.no === shot.no)?.text || shot.prompt;
});
const mediaKey = computed(() => {
  const segment = currentSegment.value;
  if (!segment) return "";
  return [
    segment.id,
    segment.video.exists ? segment.video.path : "",
    ...segment.references.map(reference => reference.path ?? ""),
    ...segment.shots.flatMap(shot => [shot.frame?.path ?? "", shot.image?.path ?? ""]),
  ].join("|");
});

let pollTimer: number | undefined;
let requestId = 0;
let mediaToken = 0;
let mediaReleases: (() => void)[] = [];
let appliedSignature = "";

function shotDuration(shot: Shot) {
  const value = Number.parseFloat(shot.dur);
  return Number.isFinite(value) && value > 0 ? value : 0.5;
}

function formatDuration(value: number) {
  return Number(value.toFixed(1));
}

function shotLabel(shot: Shot) {
  return shot.no.split("-").pop() || shot.no;
}

function stepShot(offset: number) {
  const shots = currentSegment.value?.shots ?? [];
  const next = shots[selectedIndex.value + offset];
  if (next) selectedNo.value = next.no;
}

function mimeType(name: string) {
  const extension = name.slice(name.lastIndexOf(".")).toLowerCase();
  return { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" }[extension] ?? "application/octet-stream";
}

// ACT: 缩略图优先用视频抽出的关键帧，其次回落到 资产/ 中的素材图。
function previewPath(shot: Shot) {
  return shot.frame?.path ?? shot.image?.path;
}

function previewUrl(shot: Shot) {
  const path = previewPath(shot);
  return path ? imageUrls.value[path] : undefined;
}

async function loadMedia(segment: Segment | undefined) {
  const token = ++mediaToken;
  mediaReleases.forEach(release => release());
  mediaReleases = [];
  imageUrls.value = {};
  videoUrl.value = undefined;
  if (!segment) return;
  const releases: (() => void)[] = [];
  const urls: Record<string, string> = {};
  const paths = [
    ...segment.references.map(reference => reference.path),
    ...segment.shots.flatMap(shot => [shot.frame?.path, shot.image?.path]),
  ].filter((path): path is string => Boolean(path));
  for (const path of new Set(paths)) {
    const handle = files.acquireUrl(path, mimeType(path));
    releases.push(handle.release);
    urls[path] = await handle.url.catch(() => "");
  }
  let nextVideoUrl: string | undefined;
  if (segment.video.exists) {
    const handle = files.acquireUrl(segment.video.path, "video/mp4");
    releases.push(handle.release);
    nextVideoUrl = await handle.url.catch(() => undefined);
  }
  if (token !== mediaToken) {
    releases.forEach(release => release());
    return;
  }
  mediaReleases = releases;
  imageUrls.value = Object.fromEntries(Object.entries(urls).filter(([, url]) => url));
  videoUrl.value = nextVideoUrl;
}

async function copyPrompt() {
  if (!promptText.value) return;
  try {
    await navigator.clipboard.writeText(promptText.value);
    ElMessage.success(promptScope.value === "segment" ? "整段提示词已复制" : "当前镜提示词已复制");
  } catch {
    ElMessage.error("复制失败，请手动选择文本");
  }
}

function applySnapshot(data: Snapshot) {
  const signature = JSON.stringify(data);
  if (signature === appliedSignature) return;
  appliedSignature = signature;
  snapshot.value = data;
  if (!data.segments.some(segment => segment.id === currentId.value)) {
    const target = data.segments.find(segment => !segment.video.exists) ?? data.segments[0];
    currentId.value = target?.id ?? "";
  }
}

async function refresh() {
  const directory = workspace.project?.directory;
  if (!directory) {
    error.value = "请先打开工作区";
    return;
  }
  const id = ++requestId;
  try {
    const { data } = await axios.get<{ data: Snapshot; message: string }>("/api/storyboard/get", {
      params: { directory }, headers: { "x-toonflow-workspace": "1" },
    });
    if (id !== requestId) return;
    error.value = "";
    applySnapshot(data.data);
  } catch (cause) {
    if (id !== requestId) return;
    error.value = axios.isAxiosError<{ message?: string }>(cause) ? cause.response?.data?.message || cause.message : "分镜数据读取失败";
  }
}

// ACT: 切换分段或数据刷新后，保证选中的镜仍存在，否则回落到第一镜。
watch([currentSegment, selectedNo], () => {
  const shots = currentSegment.value?.shots ?? [];
  if (shots.length && !shots.some(shot => shot.no === selectedNo.value)) selectedNo.value = shots[0].no;
}, { immediate: true });
watch(mediaKey, () => void loadMedia(currentSegment.value), { immediate: true });

onMounted(() => {
  void refresh();
  pollTimer = window.setInterval(() => void refresh(), segmentPollInterval);
});
onBeforeUnmount(() => {
  window.clearInterval(pollTimer);
  stopResize?.();
  mediaToken++;
  mediaReleases.forEach(release => release());
  mediaReleases = [];
});
</script>

<style scoped lang="scss">
.storyboardPage {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  width: calc(100% - var(--agentWidth, 0px));
  height: 100%;
  padding-top: 60px;
  background: var(--el-bg-color);
}

.pageHeader {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 8px 16px;
  border-bottom: 1px solid var(--el-border-color-light);

  .segmentSelect { width: 180px; }
  .pageTip { font-size: 12px; color: var(--el-text-color-secondary); }
  .refreshButton { margin-left: auto; }
}

.pageHint {
  margin: 24px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.referenceStrip {
  display: flex;
  gap: 10px;
  align-items: stretch;
  padding: 10px 16px;
  overflow-x: auto;
  border-bottom: 1px solid var(--el-border-color-light);
}

.referenceCard {
  display: flex;
  flex-shrink: 0;
  gap: 8px;
  align-items: center;
  max-width: 260px;
  padding: 6px;
  background: var(--el-fill-color-lighter);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;

  .referenceThumb {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    width: 64px;
    height: 64px;
    overflow: hidden;
    background: var(--el-fill-color-light);
    border-radius: 6px;

    img { width: 100%; height: 100%; object-fit: contain; }
    .thumbMissing { font-size: 10px; color: var(--el-text-color-placeholder); }
  }

  .referenceInfo {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;

    b { font-size: 11px; color: var(--el-text-color-primary); }
  }

  .referenceName {
    overflow: hidden;
    font-size: 10px;
    color: var(--el-text-color-regular);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .referenceUsage { font-size: 10px; color: var(--el-text-color-secondary); }
}

.referenceSource {
  flex-shrink: 0;
  align-self: flex-end;
  margin-left: auto;
  font-size: 10px;
  color: var(--el-text-color-placeholder);
  white-space: nowrap;
}

.timeline {
  padding: 8px 16px 10px;
  border-bottom: 1px solid var(--el-border-color-light);
}

.sceneRow,
.shotRow {
  display: flex;
  min-width: 0;
}

.sceneRow { margin-bottom: 4px; }

.sceneCell {
  flex-basis: 0;
  min-width: 0;
  overflow: hidden;
  padding: 2px 6px;
  font-size: 10px;
  color: var(--el-text-color-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
  border-right: 1px solid var(--el-border-color-lighter);

  &:last-child { border-right: 0; }
}

.shotRow { height: 34px; }

.shotCell {
  display: flex;
  flex-basis: 0;
  flex-direction: column;
  gap: 1px;
  align-items: center;
  justify-content: center;
  min-width: 28px;
  padding: 0 2px;
  overflow: hidden;
  font-family: inherit;
  cursor: pointer;
  background: var(--el-fill-color-light);
  border: 0;
  border-right: 1px solid var(--el-bg-color);
  transition: background 0.15s;

  &:last-child { border-right: 0; }

  &.missing { background: var(--el-color-warning-light-9); }
  &.active { background: var(--el-color-primary-light-8); }

  &:hover { background: var(--el-color-primary-light-9); }

  .shotNo {
    overflow: hidden;
    font-size: 10px;
    font-weight: 600;
    color: var(--el-text-color-primary);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .shotMeta {
    overflow: hidden;
    font-size: 9px;
    color: var(--el-text-color-secondary);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.pageBody {
  display: grid;
  flex: 1;
  grid-template-columns: minmax(0, 1fr) 8px var(--inspector-width, 360px);
  min-height: 0;
}

.paneSplitter {
  position: relative;
  cursor: col-resize;
  touch-action: none;
  background: var(--el-bg-color);

  &::after {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 3px;
    width: 2px;
    content: "";
    border-radius: 1px;
    background: transparent;
    transition: background-color 0.15s;
  }

  &:hover::after,
  .pageBody.resizing &::after {
    background: var(--el-color-primary-light-5);
  }
}

.shotList {
  min-height: 0;
  padding: 12px 16px;
}

.shotCard {
  display: flex;
  gap: 10px;
  padding: 10px;
  margin-bottom: 8px;
  cursor: pointer;
  background: var(--el-bg-color-overlay);
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  transition: border-color 0.15s, box-shadow 0.15s;

  &:hover { border-color: var(--el-color-primary-light-5); }

  &.active {
    border-color: var(--el-color-primary);
    box-shadow: inset 0 0 0 1px var(--el-color-primary);
  }

  &.missing .shotThumb {
    border-style: dashed;
    border-color: var(--el-color-warning);
  }

  .shotThumb {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    width: 96px;
    height: 54px;
    overflow: hidden;
    background: var(--el-fill-color-light);
    border: 1px solid var(--el-border-color-lighter);
    border-radius: 6px;

    img { width: 100%; height: 100%; object-fit: cover; }

    .thumbMissing { font-size: 11px; color: var(--el-text-color-placeholder); }
  }

  .shotInfo {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }

  .shotHead {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: baseline;
  }

  .shotTitle { font-size: 12px; font-weight: 600; }
  .shotMeta { font-size: 11px; color: var(--el-text-color-secondary); }

  .shotVisual {
    display: -webkit-box;
    overflow: hidden;
    font-size: 11px;
    line-height: 1.5;
    color: var(--el-text-color-regular);
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
  }

  .shotExtra { font-size: 10px; color: var(--el-text-color-placeholder); }
}

.inspector {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 10px 12px;
  border-left: 1px solid var(--el-border-color-light);
}

.inspectorHeader {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;

  .inspectorTitle { overflow: hidden; font-size: 13px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
  .inspectorNav { display: flex; gap: 2px; align-items: center; }
  .inspectorCount { font-size: 11px; color: var(--el-text-color-secondary); }
}

.inspectorTabs {
  align-self: flex-start;
  margin-bottom: 8px;
}

.inspectorBody {
  flex: 1;
  min-height: 0;
}

.fieldGrid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
  margin-bottom: 10px;
}

.fieldChip {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 4px 6px;
  overflow: hidden;
  font-size: 11px;
  line-height: 1.4;
  color: var(--el-text-color-regular);
  background: var(--el-fill-color-light);
  border-radius: 6px;

  em {
    font-size: 10px;
    font-style: normal;
    color: var(--el-text-color-secondary);
  }

  &.empty { color: var(--el-color-danger); }
}

.textBlocks {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.textBlock {
  padding: 6px 8px;
  background: var(--el-fill-color-lighter);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;

  b { font-size: 11px; color: var(--el-text-color-secondary); }
  p { margin-top: 2px; font-size: 11px; line-height: 1.6; color: var(--el-text-color-regular); word-break: break-word; white-space: pre-wrap; }

  &.empty p { color: var(--el-color-danger); }
}

.promptToolbar {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.promptText {
  margin: 0;
  padding: 8px;
  font-family: inherit;
  font-size: 11px;
  line-height: 1.65;
  color: var(--el-text-color-regular);
  word-break: break-word;
  white-space: pre-wrap;
  background: var(--el-fill-color-light);
  border-radius: 6px;
}

.mediaBlock {
  margin-bottom: 14px;

  b { font-size: 11px; color: var(--el-text-color-secondary); }
}

.promptSource {
  display: block;
  margin-top: 6px;
  font-size: 10px;
  color: var(--el-text-color-placeholder);
}

.mediaBox {
  display: flex;
  align-items: center;
  justify-content: center;
  margin-top: 6px;
  overflow: hidden;
  background: var(--el-fill-color-light);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;

  &.imageBox {
    aspect-ratio: 16 / 9;

    img { width: 100%; height: 100%; object-fit: contain; }
  }

  &.videoBox {
    aspect-ratio: 16 / 9;

    video { width: 100%; height: 100%; object-fit: contain; }
  }

  .mediaMissing {
    padding: 0 8px;
    font-size: 11px;
    color: var(--el-text-color-placeholder);
    text-align: center;
  }
}

.mediaMeta {
  display: block;
  margin-top: 4px;
  overflow: hidden;
  font-size: 10px;
  color: var(--el-text-color-placeholder);
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 1100px) {
  .pageBody { grid-template-columns: minmax(0, 1fr) 8px var(--inspector-width, 300px); }
}
</style>
