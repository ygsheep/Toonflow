<template>
  <section class="storyboardPage" aria-label="分镜检测">
    <header class="pageHeader">
      <el-select v-model="currentId" class="segmentSelect" size="small" placeholder="选择分段" :disabled="!segments.length">
        <el-option v-for="segment in segments" :key="segment.id" :label="segmentLabel(segment)" :value="segment.id" />
      </el-select>
      <template v-if="currentSegment">
        <el-tag size="small">镜 {{ currentSegment.shotCount }}</el-tag>
        <el-tag size="small">总时长 {{ totalDuration }}s</el-tag>
        <el-tag v-if="currentSegment.parseError" size="small" type="danger">解析失败</el-tag>
        <el-tag size="small" :type="issueTagType" class="issueTagButton" @click="openReview()">
          问题 {{ issueStats.total }}
        </el-tag>
        <el-tag v-if="confirmedCount" size="small" type="success">已确认 {{ confirmedCount }}/{{ currentSegment.shotCount }}</el-tag>
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
      <p v-if="currentSegment.parseError" class="pageHint">
        {{ currentSegment.parseError }} · {{ currentSegment.source }}
      </p>
      <template v-else>
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
            :class="{ active: shot.no === selected?.no, missing: !shot.frame, flagged: shotIssueCount(shot.no) }"
            :style="{ flexGrow: shotDuration(shot) }"
            :title="`${shot.no} · ${shot.size} · ${shot.dur}s${shotIssueCount(shot.no) ? ` · 问题 ${shotIssueCount(shot.no)}` : ''}`"
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
            :class="{ active: shot.no === selected?.no, missing: !shot.frame, flagged: shotIssueCount(shot.no) }"
            @click="selectedNo = shot.no">
            <div class="shotThumb">
              <img v-if="previewUrl(shot)" :src="previewUrl(shot)" :alt="shot.asset" loading="lazy" />
              <span v-else class="thumbMissing">缺帧</span>
            </div>
            <div class="shotInfo">
              <div class="shotHead">
                <span class="shotTitle">{{ shot.no }}</span>
                <span class="shotMeta">{{ shot.size || "—" }} · {{ shot.angle || "—" }} · {{ shot.dur || "—" }}s</span>
                <el-tag v-if="shotIssueCount(shot.no)" size="small" type="danger">{{ shotIssueCount(shot.no) }}</el-tag>
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

          <div v-if="selected" class="reviewBar">
            <el-segmented v-model="selectedStatus" :options="statusOptions" size="small" aria-label="审阅状态" />
            <el-button text size="small" @click="openReview('shot')">看问题</el-button>
          </div>

          <div v-if="selectedIssues.length" class="issueStrip">
            <button v-for="issue in selectedIssues.slice(0, 3)" :key="issue.id" type="button" class="issueLine" @click="openReview('shot')">
              <span class="issueBadge" :class="issue.severity">{{ severityLabel(issue.severity) }}</span>
              <span class="issueDesc">{{ issue.desc }}</span>
            </button>
            <button v-if="selectedIssues.length > 3" type="button" class="issueMore" @click="openReview('shot')">
              还有 {{ selectedIssues.length - 3 }} 条
            </button>
          </div>

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
    </template>

    <el-drawer v-if="currentSegment" v-model="reviewOpen" class="reviewDrawer" :appendToBody="false" size="560px" title="审阅意见">
      <div class="reviewPanel">
        <div class="reviewSummary">
          <el-tag size="small" type="danger">P0 {{ issueStats.p0 }}</el-tag>
          <el-tag size="small" type="warning">P1 {{ issueStats.p1 }}</el-tag>
          <el-tag size="small" type="info">P2 {{ issueStats.p2 }}</el-tag>
          <span class="reviewHint">{{ unresolvedIssues.length }} 条未解决 · {{ currentSegment.id }}</span>
        </div>
        <p v-if="currentSegment.orphanPrompts.length" class="orphanPrompts">
          孤儿提示词：{{ currentSegment.orphanPrompts.join("、") }}
        </p>
        <div class="reviewFilters">
          <el-select v-model="issueFilter.severity" size="small" style="width: 112px">
            <el-option label="全部级别" value="all" />
            <el-option label="P0 阻断" value="p0" />
            <el-option label="P1 重要" value="p1" />
            <el-option label="P2 建议" value="p2" />
          </el-select>
          <el-select v-model="issueFilter.field" size="small" style="width: 118px">
            <el-option label="全部字段" value="all" />
            <el-option v-for="field in issueFields" :key="field" :label="field" :value="field" />
          </el-select>
          <el-checkbox v-model="issueFilter.currentShot">当前镜</el-checkbox>
          <el-checkbox v-model="issueFilter.showIgnored">已忽略</el-checkbox>
        </div>

        <div class="issueList">
          <article v-for="issue in filteredIssues" :key="issue.id" class="issueItem" :class="[issue.severity, { ignored: issue.ignored }]">
            <div class="issueItemHead">
              <span class="issueBadge">{{ severityLabel(issue.severity) }}</span>
              <button type="button" class="issueShot" :disabled="!issue.shotNo" @click="jumpToIssue(issue)">{{ issue.shotNo || "分段级" }}</button>
              <span class="issueField">{{ issue.field }}</span>
              <span class="issueSource">{{ issue.source === "auto" ? "自动" : "人工" }}</span>
            </div>
            <p class="issueText">{{ issue.desc }}</p>
            <p v-if="issue.fix" class="issueFix">改法：{{ issue.fix }}</p>
            <p v-if="issue.ignored" class="issueIgnored">已忽略：{{ issue.ignoreReason }}</p>
            <div class="issueActions">
              <el-button v-if="issue.shotNo" text size="small" @click="jumpToIssue(issue)">定位</el-button>
              <el-button v-if="issue.source === 'auto' && !issue.ignored" text size="small" @click="ignoreIssue(issue)">忽略</el-button>
              <el-button v-if="issue.source === 'auto' && issue.ignored" text size="small" @click="restoreIssue(issue)">恢复</el-button>
              <el-button v-if="issue.source === 'manual'" text size="small" type="danger" @click="removeManualIssue(issue)">删除</el-button>
            </div>
          </article>
          <p v-if="!filteredIssues.length" class="reviewHint">没有符合条件的问题</p>
        </div>

        <el-collapse class="manualForm">
          <el-collapse-item title="新增人工意见" name="manual">
            <div class="manualRow">
              <el-input v-model="newIssue.shotNo" size="small" placeholder="镜号（留空为分段级）" />
              <el-select v-model="newIssue.field" size="small" style="width: 110px">
                <el-option v-for="field in manualFieldOptions" :key="field" :label="field" :value="field" />
              </el-select>
              <el-select v-model="newIssue.severity" size="small" style="width: 92px">
                <el-option label="P0" value="p0" />
                <el-option label="P1" value="p1" />
                <el-option label="P2" value="p2" />
              </el-select>
            </div>
            <el-input v-model="newIssue.desc" size="small" type="textarea" :rows="2" placeholder="问题描述" />
            <el-input v-model="newIssue.fix" class="manualFix" size="small" placeholder="建议改法（可选）" />
            <el-button size="small" type="primary" @click="addManualIssue">添加意见</el-button>
          </el-collapse-item>
        </el-collapse>
      </div>
      <template #footer>
        <el-button size="small" @click="reviewOpen = false">关闭</el-button>
        <el-button size="small" type="primary" :disabled="!unresolvedIssues.length" @click="exportReview">导出意见</el-button>
      </template>
    </el-drawer>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from "vue";
import axios from "axios";
import { ElMessage, ElMessageBox } from "element-plus";
import { IconChevronLeft, IconChevronRight, IconCopy, IconRefresh } from "@tabler/icons-vue";
import { useWorkspaceStore } from "@/stores/workspace";
import useWorkspaceFiles from "@/lib/workspaceFiles";
import { emptyReview, loadReview, saveReview, type IssueSeverity, type ManualIssue, type ReviewState, type ReviewStatus } from "./reviewStore";

type AutoIssue = {
  id: string;
  code: string;
  shotNo: string;
  field: string;
  severity: IssueSeverity;
  source: "auto";
  desc: string;
  fix: string;
};
type IssueView = {
  id: string;
  code: string;
  shotNo: string;
  field: string;
  severity: IssueSeverity;
  source: "auto" | "manual";
  desc: string;
  fix: string;
  ignored: boolean;
  ignoreReason: string;
};

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
  source: string;
  parseError?: string;
  issues: AutoIssue[];
  orphanPrompts: string[];
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
const statusOptions = [
  { label: "未读", value: "unread" },
  { label: "已读", value: "read" },
  { label: "有问题", value: "flagged" },
  { label: "已确认", value: "confirmed" },
];
const manualFieldOptions = ["镜号", "场景", "景别", "摄法", "机位", "运镜", "焦段", "时长", "画面", "动作", "台词", "光线", "色彩", "素材", "提示词", "槽位", "文件"];

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
const reviewState = ref<ReviewState>(emptyReview());
const reviewOpen = ref(false);
const issueFilter = reactive({ severity: "all", field: "all", currentShot: false, showIgnored: false });
const newIssue = reactive({ shotNo: "", field: "画面", severity: "p1" as IssueSeverity, desc: "", fix: "" });

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
const autoIssues = computed<IssueView[]>(() => (currentSegment.value?.issues ?? []).map(issue => ({
  ...issue,
  ignored: Boolean(reviewState.value.ignored[issue.id]),
  ignoreReason: reviewState.value.ignored[issue.id] ?? "",
})));
const manualIssues = computed<IssueView[]>(() => reviewState.value.manual
  .filter(issue => issue.segmentId === currentSegment.value?.id)
  .map(issue => ({ ...issue, ignored: false, ignoreReason: "" })));
const allIssues = computed(() => [...autoIssues.value, ...manualIssues.value]);
const unresolvedIssues = computed(() => allIssues.value.filter(issue => !issue.ignored));
const issueStats = computed(() => {
  const stats = { total: 0, p0: 0, p1: 0, p2: 0 };
  for (const issue of unresolvedIssues.value) {
    stats.total++;
    stats[issue.severity]++;
  }
  return stats;
});
const issueTagType = computed<"danger" | "warning" | "success">(() => issueStats.value.p0 ? "danger" : issueStats.value.total ? "warning" : "success");
const issueFields = computed(() => [...new Set(allIssues.value.map(issue => issue.field))]);
const filteredIssues = computed(() => allIssues.value.filter(issue => {
  if (!issueFilter.showIgnored && issue.ignored) return false;
  if (issueFilter.severity !== "all" && issue.severity !== issueFilter.severity) return false;
  if (issueFilter.field !== "all" && issue.field !== issueFilter.field) return false;
  if (issueFilter.currentShot && issue.shotNo !== selected.value?.no) return false;
  return true;
}));
const selectedIssues = computed(() => unresolvedIssues.value.filter(issue => issue.shotNo && issue.shotNo === selected.value?.no));
const confirmedCount = computed(() => {
  const segment = currentSegment.value;
  if (!segment) return 0;
  return segment.shots.filter(shot => reviewState.value.shots[`${segment.id}:${shot.no}`]?.status === "confirmed").length;
});
const selectedStatus = computed<ReviewStatus>({
  get: () => {
    const segment = currentSegment.value;
    const shot = selected.value;
    return segment && shot ? reviewState.value.shots[`${segment.id}:${shot.no}`]?.status ?? "unread" : "unread";
  },
  set: value => {
    const segment = currentSegment.value;
    const shot = selected.value;
    if (!segment || !shot) return;
    reviewState.value.shots[`${segment.id}:${shot.no}`] = { status: value };
    persistReview();
  },
});
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

function reviewDirectory() {
  return workspace.project?.directory ?? "";
}

function persistReview() {
  saveReview(reviewDirectory(), reviewState.value);
}

function loadReviewState() {
  reviewState.value = loadReview(reviewDirectory());
}

function segmentLabel(segment: Segment) {
  return `${segment.id} · ${segment.shotCount} 镜${segment.issues.length ? ` · 问题 ${segment.issues.length}` : ""}`;
}

function shotIssueCount(shotNo: string) {
  return unresolvedIssues.value.filter(issue => issue.shotNo === shotNo).length;
}

function severityLabel(severity: IssueSeverity) {
  return severity.toUpperCase();
}

function openReview(scope: "all" | "shot" = "all") {
  issueFilter.currentShot = scope === "shot";
  newIssue.shotNo = selected.value?.no ?? "";
  reviewOpen.value = true;
}

function jumpToIssue(issue: IssueView) {
  if (!issue.shotNo) return;
  selectedNo.value = issue.shotNo;
  reviewOpen.value = false;
}

async function ignoreIssue(issue: IssueView) {
  try {
    const { value } = await ElMessageBox.prompt("导出意见时不会带上这条问题。", "忽略问题", {
      inputPlaceholder: "例如：过渡镜，机位固定无需标注",
      confirmButtonText: "忽略",
      cancelButtonText: "取消",
      inputValidator: input => Boolean(input?.trim()) || "请填写忽略原因",
    });
    reviewState.value.ignored[issue.id] = value.trim();
    persistReview();
  } catch {
    // 取消忽略
  }
}

function restoreIssue(issue: IssueView) {
  delete reviewState.value.ignored[issue.id];
  persistReview();
}

async function removeManualIssue(issue: IssueView) {
  try {
    await ElMessageBox.confirm("删除后不可恢复。", "删除人工意见", { type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" });
  } catch {
    return;
  }
  reviewState.value.manual = reviewState.value.manual.filter(item => item.id !== issue.id);
  persistReview();
}

function addManualIssue() {
  const segment = currentSegment.value;
  if (!segment) return;
  const desc = newIssue.desc.trim();
  if (!desc) {
    ElMessage.warning("请填写问题描述");
    return;
  }
  const shotNo = newIssue.shotNo.trim();
  if (shotNo && !segment.shots.some(shot => shot.no === shotNo)) {
    ElMessage.warning("该镜号不在当前分段");
    return;
  }
  const issue: ManualIssue = {
    id: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    code: "manual",
    segmentId: segment.id,
    shotNo,
    field: newIssue.field,
    severity: newIssue.severity,
    source: "manual",
    desc,
    fix: newIssue.fix.trim(),
    createdAt: Date.now(),
  };
  reviewState.value.manual.push(issue);
  if (shotNo) reviewState.value.shots[`${segment.id}:${shotNo}`] = { status: "flagged" };
  persistReview();
  newIssue.desc = "";
  newIssue.fix = "";
  ElMessage.success("已添加人工意见");
}

function buildReviewMarkdown(segment: Segment, issues: IssueView[], exportedAt: Date) {
  const count = (severity: IssueSeverity) => issues.filter(issue => issue.severity === severity).length;
  const groups = new Map<string, IssueView[]>();
  for (const issue of issues) {
    const key = issue.shotNo || "分段级";
    groups.set(key, [...groups.get(key) ?? [], issue]);
  }
  const lines = [
    `# 审阅意见 · ${segment.id}`,
    "",
    `> 来源：${segment.source}`,
    `> 导出时间：${exportedAt.toLocaleString("zh-CN")}`,
    `> 未解决 ${issues.length} 条：P0 ${count("p0")} / P1 ${count("p1")} / P2 ${count("p2")}`,
    "",
  ];
  for (const [shotNo, list] of groups) {
    lines.push(`## ${shotNo}`, "");
    for (const issue of list) {
      lines.push(`- ${severityLabel(issue.severity)} · ${issue.field}：${issue.desc}`);
      if (issue.fix) lines.push(`  - 改法：${issue.fix}`);
      lines.push(`  - 来源：${issue.source === "auto" ? "自动检查" : "人工批注"}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function exportReview() {
  const segment = currentSegment.value;
  const directory = workspace.project?.directory;
  if (!segment || !directory) return;
  const issues = unresolvedIssues.value;
  if (!issues.length) {
    ElMessage.info("当前段没有未解决的审阅意见");
    return;
  }
  const exportedAt = new Date();
  const payload = {
    segment: segment.id,
    source: segment.source,
    exportedAt: exportedAt.toISOString(),
    issues: issues.map(issue => ({
      severity: issue.severity,
      code: issue.code,
      shotNo: issue.shotNo,
      field: issue.field,
      desc: issue.desc,
      fix: issue.fix,
      source: issue.source,
    })),
  };
  const writer = useWorkspaceFiles(directory);
  const segmentDirectory = `_review/${segment.id}`;
  try {
    const root = await writer.list("");
    if (!root.entries.some(entry => entry.name === "_review" && entry.type === "directory")) await writer.mkdir("_review");
    const reviewRoot = await writer.list("_review");
    if (!reviewRoot.entries.some(entry => entry.name === segment.id && entry.type === "directory")) await writer.mkdir(segmentDirectory);
    await writer.write(`${segmentDirectory}/审阅意见.md`, buildReviewMarkdown(segment, issues, exportedAt));
    await writer.writeJson(`${segmentDirectory}/问题清单.json`, payload);
    ElMessage.success(`已导出到 ${segmentDirectory}/`);
  } catch (cause) {
    ElMessage.error(axios.isAxiosError<{ message?: string }>(cause) ? cause.response?.data?.message || cause.message : "导出失败");
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
watch(() => workspace.project?.directory, () => loadReviewState());

onMounted(() => {
  loadReviewState();
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
  position: relative;
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
  &.flagged { background: var(--el-color-danger-light-9); }

  &.flagged::after {
    position: absolute;
    top: 3px;
    right: 3px;
    width: 5px;
    height: 5px;
    content: "";
    background: var(--el-color-danger);
    border-radius: 50%;
  }

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

  &.flagged { border-left: 3px solid var(--el-color-danger); }

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

.reviewBar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  margin-bottom: 8px;
}

.issueStrip {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 6px 8px;
  margin-bottom: 8px;
  background: var(--el-fill-color-light);
  border-radius: 6px;
}

.issueLine,
.issueMore {
  display: flex;
  gap: 6px;
  align-items: center;
  width: 100%;
  padding: 0;
  font-family: inherit;
  font-size: 11px;
  color: var(--el-text-color-regular);
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: 0;
}

.issueMore { color: var(--el-color-primary); }

.issueBadge {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 600;
  color: var(--el-color-danger);

  &.p1 { color: var(--el-color-warning); }
  &.p2 { color: var(--el-color-info); }
}

.issueDesc {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.issueTagButton { cursor: pointer; }

.reviewPanel {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.reviewSummary {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.reviewHint {
  font-size: 11px;
  color: var(--el-text-color-secondary);
}

.orphanPrompts {
  padding: 6px 8px;
  font-size: 11px;
  color: var(--el-color-warning);
  background: var(--el-color-warning-light-9);
  border-radius: 6px;
}

.reviewFilters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.issueList {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 48vh;
  padding-right: 2px;
  overflow-y: auto;
}

.issueItem {
  padding: 8px 10px;
  border: 1px solid var(--el-border-color-lighter);
  border-left: 3px solid var(--el-color-danger);
  border-radius: 6px;

  &.p1 { border-left-color: var(--el-color-warning); }
  &.p2 { border-left-color: var(--el-color-info); }
  &.ignored { opacity: 0.6; }
}

.issueItemHead {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 11px;
}

.issueShot {
  padding: 0;
  font-family: inherit;
  font-size: 11px;
  color: var(--el-color-primary);
  cursor: pointer;
  background: transparent;
  border: 0;

  &:disabled { color: var(--el-text-color-secondary); cursor: default; }
}

.issueField { color: var(--el-text-color-secondary); }

.issueSource {
  margin-left: auto;
  font-size: 10px;
  color: var(--el-text-color-placeholder);
}

.issueText {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-primary);
}

.issueFix,
.issueIgnored {
  margin-top: 2px;
  font-size: 11px;
  color: var(--el-text-color-secondary);
}

.issueIgnored { color: var(--el-color-info); }

.issueActions {
  display: flex;
  gap: 4px;
  margin-top: 4px;
}

.manualForm { margin-top: 4px; }

.manualRow {
  display: flex;
  gap: 6px;
  margin-bottom: 6px;

  .el-input { flex: 1; }
}

.manualFix { margin: 6px 0; }

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
