<template>
  <section class="assetsPanel" aria-label="资产管理">
    <header class="assetsHeader">
      <el-input v-model="keyword" class="searchInput" size="small" placeholder="搜索资产、文件名或镜号" clearable :prefixIcon="IconSearch" />
      <el-tag size="small">共 {{ assets.length }}</el-tag>
      <el-tag size="small" type="success">已就绪 {{ readyCount }}</el-tag>
      <el-tag size="small" :type="missingCount ? 'warning' : 'info'">缺图 {{ missingCount }}</el-tag>
      <el-tag v-if="unused.length" size="small" type="info">未引用 {{ unused.length }}</el-tag>
      <el-button class="refreshButton" text size="small" @click="refresh">刷新</el-button>
    </header>
    <p v-if="error" class="assetsHint">{{ error }}</p>
    <p v-else-if="!loading && !assets.length" class="assetsHint">当前项目没有可用的分镜资产引用</p>
    <el-scrollbar v-else class="assetsBody">
      <div class="assetGrid">
        <article v-for="asset in visibleAssets" :key="asset.id" class="assetCard" :class="{ missing: !asset.file }">
          <div class="assetThumb">
            <img v-if="asset.file && imageUrls[asset.file]" :src="imageUrls[asset.file]" :alt="asset.id" loading="lazy" />
            <span v-else class="assetMissing">缺图</span>
          </div>
          <div class="assetInfo">
            <p class="assetTitle" :title="assetTitle(asset)">{{ asset.name || asset.id }}</p>
            <p class="assetFile" :title="asset.file ?? '资产目录中未找到对应文件'">{{ asset.file ?? "未放置图片" }}</p>
            <p class="assetRefs" :title="refsLabel(asset)">{{ metaLabel(asset) }}</p>
          </div>
        </article>
      </div>
      <div v-if="unused.length" class="unusedBlock">
        <h2 class="unusedTitle">未被引用的文件（{{ unused.length }}）</h2>
        <div class="unusedList">
          <span v-for="name in unused" :key="name" class="unusedItem" :title="name">{{ name }}</span>
        </div>
      </div>
    </el-scrollbar>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import axios from "axios";
import { IconSearch } from "@tabler/icons-vue";
import { useWorkspaceStore } from "@/stores/workspace";
import useWorkspaceFiles from "@/lib/workspaceFiles";

type AssetEntry = {
  id: string;
  name: string;
  type: string;
  file: string | null;
  refs: { segment: string; number: string; no: string }[];
  note: string;
  source: "storyboard" | "manifest";
};
type AssetSnapshot = { assets: AssetEntry[]; unused: string[] };

const assetPollInterval = 3000;

const workspace = useWorkspaceStore();
const files = useWorkspaceFiles();
const snapshot = shallowRef<AssetSnapshot>({ assets: [], unused: [] });
const keyword = ref("");
const error = ref("");
const loading = ref(true);
const imageUrls = shallowRef<Record<string, string>>({});
const assets = computed(() => snapshot.value.assets);
const unused = computed(() => snapshot.value.unused);
const readyCount = computed(() => assets.value.filter(asset => asset.file).length);
const missingCount = computed(() => assets.value.length - readyCount.value);
const visibleAssets = computed(() => {
  const query = keyword.value.trim().toLowerCase();
  return query
    ? assets.value.filter(asset => [asset.id, asset.name, asset.type, asset.file ?? ""].some(value => value.toLowerCase().includes(query)) || asset.refs.some(ref => ref.no.toLowerCase().includes(query)))
    : assets.value;
});

let pollTimer: number | undefined;
let requestId = 0;
let mediaToken = 0;
let mediaReleases: (() => void)[] = [];
let appliedSignature = "";

function assetTitle(asset: AssetEntry) {
  return [asset.id, asset.note].filter(Boolean).join("\n");
}

function metaLabel(asset: AssetEntry) {
  const parts = [asset.type, asset.refs.length ? `${asset.refs.length} 处引用` : "未引用"].filter(Boolean);
  return parts.join(" · ");
}

function refsLabel(asset: AssetEntry) {
  return asset.refs.map(ref => `${ref.segment} ${ref.no}`).join("\n") || asset.note;
}

function mimeType(name: string) {
  const extension = name.slice(name.lastIndexOf(".")).toLowerCase();
  return { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" }[extension] ?? "application/octet-stream";
}

async function loadThumbnails(entries: AssetEntry[]) {
  const token = ++mediaToken;
  mediaReleases.forEach(release => release());
  mediaReleases = [];
  imageUrls.value = {};
  const releases: (() => void)[] = [];
  const urls: Record<string, string> = {};
  for (const entry of entries) {
    if (!entry.file) continue;
    const handle = files.acquireUrl(`资产/${entry.file}`, mimeType(entry.file));
    releases.push(handle.release);
    urls[entry.file] = await handle.url.catch(() => "");
  }
  if (token !== mediaToken) {
    releases.forEach(release => release());
    return;
  }
  mediaReleases = releases;
  imageUrls.value = Object.fromEntries(Object.entries(urls).filter(([, url]) => url));
}

async function refresh() {
  const directory = workspace.project?.directory;
  if (!directory) {
    error.value = "请先打开工作区";
    loading.value = false;
    return;
  }
  const id = ++requestId;
  try {
    const { data } = await axios.get<{ data: AssetSnapshot }>("/api/storyboard/assets", {
      params: { directory }, headers: { "x-toonflow-workspace": "1" },
    });
    if (id !== requestId) return;
    error.value = "";
    loading.value = false;
    const signature = JSON.stringify(data.data);
    if (signature === appliedSignature) return;
    appliedSignature = signature;
    snapshot.value = data.data;
    void loadThumbnails(data.data.assets);
  } catch (cause) {
    if (id !== requestId) return;
    loading.value = false;
    error.value = axios.isAxiosError<{ message?: string }>(cause) ? cause.response?.data?.message || cause.message : "资产数据读取失败";
  }
}

onMounted(() => {
  void refresh();
  pollTimer = window.setInterval(() => void refresh(), assetPollInterval);
});
onBeforeUnmount(() => {
  window.clearInterval(pollTimer);
  mediaToken++;
  mediaReleases.forEach(release => release());
  mediaReleases = [];
});
</script>

<style scoped lang="scss">
.assetsPanel {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  width: calc(100% - var(--agentWidth, 0px));
  height: 100%;
  padding-top: 60px;
  background: var(--el-bg-color);
}

.assetsHeader {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 8px 16px;
  border-bottom: 1px solid var(--el-border-color-light);

  .searchInput { width: 220px; }
  .refreshButton { margin-left: auto; }
}

.assetsHint {
  margin: 24px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.assetsBody {
  flex: 1;
  min-height: 0;
  padding: 12px 16px;
}

.assetGrid {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
}

.assetCard {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--el-bg-color-overlay);
  border: 1px solid var(--el-border-color);
  border-radius: 8px;

  &.missing { border-style: dashed; border-color: var(--el-color-warning); }
}

.assetThumb {
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 4 / 3;
  background: var(--el-fill-color-light);

  img { width: 100%; height: 100%; object-fit: cover; }

  .assetMissing { font-size: 12px; color: var(--el-text-color-placeholder); }
}

.assetInfo {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;

  .assetTitle { overflow: hidden; font-size: 12px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
  .assetFile { overflow: hidden; font-size: 11px; color: var(--el-text-color-secondary); text-overflow: ellipsis; white-space: nowrap; }
  .assetRefs { font-size: 11px; color: var(--el-text-color-placeholder); }
}

.unusedBlock {
  margin-top: 20px;

  .unusedTitle { margin-bottom: 8px; font-size: 12px; font-weight: 600; color: var(--el-text-color-regular); }
  .unusedList { display: flex; flex-wrap: wrap; gap: 6px; }
  .unusedItem {
    max-width: 240px;
    overflow: hidden;
    padding: 2px 8px;
    font-size: 11px;
    color: var(--el-text-color-secondary);
    text-overflow: ellipsis;
    white-space: nowrap;
    background: var(--el-fill-color-light);
    border-radius: 4px;
  }
}
</style>
