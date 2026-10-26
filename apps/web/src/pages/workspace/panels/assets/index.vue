<template>
  <section class="assetsPanel" aria-label="资产管理">
    <header class="assetsHeader">
      <el-input v-model="keyword" class="searchInput" size="small" placeholder="搜索主体、文件名或镜号" clearable :prefixIcon="IconSearch" />
      <span class="assetsStats">就绪 {{ readyCount }} / {{ assets.length }}<template v-if="missingCount"> · 缺图 {{ missingCount }}</template></span>
      <el-button class="refreshButton" text size="small" @click="refresh">刷新</el-button>
    </header>
    <p v-if="error" class="assetsHint">{{ error }}</p>
    <p v-else-if="!loading && !assets.length && !unused.length" class="assetsHint">当前项目没有可用的分镜资产引用</p>
    <div v-else class="assetsBody">
      <nav class="assetNav" aria-label="资产分类">
        <template v-for="group in groups" :key="group.key">
          <div class="navRow">
            <button
              class="navItem"
              :class="{ on: activeGroup === group.key && !activeAsset }"
              :aria-pressed="activeGroup === group.key && !activeAsset"
              :title="group.key === 'pending' ? `${group.total} 个未被清单或分镜引用的文件` : `就绪 ${group.ready} / ${group.total}`"
              @click="selectGroup(group.key)">
              <span class="navLabel">{{ group.label }}</span>
              <span class="navCount">{{ group.total }}</span>
            </button>
            <button
              v-if="group.subjects.length"
              class="navToggle"
              :aria-label="`${collapsed.includes(group.key) ? '展开' : '收起'} ${group.label} 主体`"
              @click="toggleGroup(group.key)">
              <IconChevronRight class="navCaret" :class="{ open: !collapsed.includes(group.key) }" />
            </button>
          </div>
          <div v-if="group.subjects.length && !collapsed.includes(group.key)" class="navSubjects">
            <button
              v-for="subject in group.subjects"
              :key="subject.id"
              class="navSubject"
              :class="{ on: activeAsset === subject.id, missing: !subject.fileCount }"
              :title="subject.name"
              @click="selectSubject(group.key, subject.id)">
              <span class="navLabel">{{ subject.name }}</span>
              <span class="navCount">{{ subject.fileCount }}</span>
            </button>
          </div>
        </template>
      </nav>
      <el-scrollbar class="assetMain">
        <template v-if="activeGroup === 'pending' && !activeAsset">
          <div v-for="section in pendingGroups" :key="section.label" class="pendingSection">
            <h2 class="pendingTitle">{{ section.label }} · {{ section.files.length }}</h2>
            <div class="pendingList">
              <span v-for="name in section.files" :key="name" class="pendingItem" :title="name">{{ name }}</span>
            </div>
          </div>
          <p v-if="!pendingGroups.length" class="assetsHint">没有待入库的文件</p>
        </template>
        <template v-else>
          <section v-for="section in assetSections" :key="section.key" class="assetSection">
            <h2 class="assetSectionTitle">
              <span>{{ section.label }} · {{ section.total }}</span>
              <span class="sectionMeta">就绪 {{ section.ready }} / {{ section.total }}</span>
            </h2>
            <div class="assetGrid">
              <template v-for="asset in section.assets" :key="asset.id">
                <article v-for="(file, index) in assetFiles(asset)" :key="`${asset.id}:${file ?? index}`" class="assetCard" :class="{ missing: !file }">
                  <div class="assetThumb">
                    <img v-if="file && imageUrls[file]" :src="imageUrls[file]" :alt="cardTitle(asset, index)" loading="lazy" />
                    <span v-else class="assetMissing">缺图</span>
                  </div>
                  <div class="assetInfo">
                    <p class="assetTitle" :title="assetTitle(asset)">{{ cardTitle(asset, index) }}</p>
                    <p class="assetFile" :title="file ?? '资产目录中未找到对应文件'">{{ file ?? "未放置图片" }}</p>
                    <p class="assetRefs" :title="refsLabel(asset)">{{ metaLabel(asset) }}</p>
                  </div>
                </article>
              </template>
            </div>
          </section>
          <p v-if="!assetSections.length" class="assetsHint">该分类下没有资产</p>
        </template>
      </el-scrollbar>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import axios from "axios";
import { IconChevronRight, IconSearch } from "@tabler/icons-vue";
import { useWorkspaceStore } from "@/stores/workspace";
import useWorkspaceFiles from "@/lib/workspaceFiles";

type AssetEntry = {
  id: string;
  name: string;
  type: string;
  file: string | null;
  files: string[];
  refs: { segment: string; number: string; no: string }[];
  note: string;
  source: "storyboard" | "manifest";
};
type AssetSnapshot = { assets: AssetEntry[]; unused: string[] };

// ACT: PRD 4.6 资产看板按主体类型分组；音频目前只有清单，保留分组位。
const typeOrder = ["角色", "场景", "道具", "音频"];

const workspace = useWorkspaceStore();
const files = useWorkspaceFiles();
const snapshot = shallowRef<AssetSnapshot>({ assets: [], unused: [] });
const keyword = ref("");
const activeGroup = ref("all");
// ACT: 主体分支选中后只显示该主体的素材，避免大列表里翻找。
const activeAsset = ref("");
const collapsed = ref<string[]>([]);
const error = ref("");
const loading = ref(true);
const imageUrls = shallowRef<Record<string, string>>({});
const assets = computed(() => snapshot.value.assets);
const unused = computed(() => snapshot.value.unused);
const readyCount = computed(() => assets.value.filter(asset => asset.files.length).length);
const missingCount = computed(() => assets.value.length - readyCount.value);

// ACT: 类型优先取清单字段，缺失时退回文件所在的 角色/场景/道具/音频 目录。
function assetGroup(asset: AssetEntry) {
  const declared = asset.type.trim();
  if (declared) return declared;
  const segment = asset.file?.split("/")[0] ?? "";
  return typeOrder.includes(segment) ? segment : "未分类";
}

const groups = computed(() => {
  const buckets = new Map<string, AssetEntry[]>();
  for (const asset of assets.value) {
    const key = assetGroup(asset);
    buckets.set(key, [...(buckets.get(key) ?? []), asset]);
  }
  const ordered = typeOrder.filter(type => buckets.has(type)).concat([...buckets.keys()].filter(key => !typeOrder.includes(key)));
  const sections = ordered.map(key => {
    const items = buckets.get(key)!;
    return {
      key,
      label: key,
      total: items.length,
      ready: items.filter(asset => asset.files.length).length,
      // ACT: 二级分支 = 每个主体（唐炎、王嫣…），右侧显示该主体已有的素材文件数。
      subjects: items
        .map(asset => ({ id: asset.id, name: asset.name || asset.id, fileCount: asset.files.length }))
        .sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true })),
    };
  });
  return [
    { key: "all", label: "全部", total: assets.value.length, ready: readyCount.value, subjects: [] as { id: string; name: string; fileCount: number }[] },
    ...sections,
    // ACT: 待入库 = 资产目录里存在但清单与分镜都没引用的文件，按所在类型目录再分一次。
    ...(unused.value.length ? [{ key: "pending", label: "待入库", total: unused.value.length, ready: 0, subjects: [] }] : []),
  ];
});

const pendingGroups = computed(() => {
  const query = keyword.value.trim().toLowerCase();
  const buckets = new Map<string, string[]>();
  for (const file of unused.value) {
    if (query && !file.toLowerCase().includes(query)) continue;
    const segment = file.includes("/") ? file.split("/")[0]! : "根目录";
    buckets.set(segment, [...(buckets.get(segment) ?? []), file]);
  }
  return [...buckets.entries()]
    .sort(([left], [right]) => (typeOrder.indexOf(left) + 1 || 99) - (typeOrder.indexOf(right) + 1 || 99) || left.localeCompare(right, "zh-CN"))
    .map(([label, files]) => ({ label, files }));
});

const assetSections = computed(() => {
  const query = keyword.value.trim().toLowerCase();
  const matches = (asset: AssetEntry) => !query
    || [asset.id, asset.name, asset.type, ...asset.files].some(value => value.toLowerCase().includes(query))
    || asset.refs.some(ref => ref.no.toLowerCase().includes(query));
  if (activeAsset.value) {
    const asset = assets.value.find(item => item.id === activeAsset.value);
    if (!asset || !matches(asset)) return [];
    return [{
      key: asset.id,
      label: [asset.name || asset.id, assetGroup(asset)].filter(Boolean).join(" · "),
      // ACT: 主体视图按素材文件计数，与右侧分支上的数量保持一致。
      total: asset.files.length || 1,
      ready: asset.files.length,
      assets: [asset],
    }];
  }
  return groups.value
    .filter(group => group.key !== "all" && group.key !== "pending")
    .filter(group => activeGroup.value === "all" || activeGroup.value === group.key)
    .map(group => {
      const items = assets.value.filter(asset => assetGroup(asset) === group.key && matches(asset));
      return { key: group.key, label: group.label, total: items.length, ready: items.filter(asset => asset.files.length).length, assets: items };
    })
    .filter(section => section.assets.length);
});

// ACT: 刷新后分组或主体可能消失（例如文件被删除），选中项回退到全部。
watch(groups, current => {
  if (!current.some(group => group.key === activeGroup.value)) activeGroup.value = "all";
  if (activeAsset.value && !assets.value.some(asset => asset.id === activeAsset.value)) activeAsset.value = "";
});

function selectGroup(key: string) {
  activeGroup.value = key;
  activeAsset.value = "";
  if (collapsed.value.includes(key)) collapsed.value = collapsed.value.filter(item => item !== key);
}

function selectSubject(group: string, id: string) {
  activeGroup.value = group;
  activeAsset.value = id;
}

function toggleGroup(key: string) {
  collapsed.value = collapsed.value.includes(key) ? collapsed.value.filter(item => item !== key) : [...collapsed.value, key];
}

function assetFiles(asset: AssetEntry): (string | null)[] {
  return asset.files.length ? asset.files : [null];
}

function cardTitle(asset: AssetEntry, index: number) {
  const name = asset.name || asset.id;
  return asset.files.length > 1 ? `${name} · ${index + 1}/${asset.files.length}` : name;
}

let requestId = 0;
let mediaToken = 0;
let mediaReleases: (() => void)[] = [];
let appliedSignature = "";
let source: EventSource | null = null;
let reconnectTimer: number | undefined;
let reconnectDelay = 1000;

function assetTitle(asset: AssetEntry) {
  return [asset.id, asset.note].filter(Boolean).join("\n");
}

function metaLabel(asset: AssetEntry) {
  const parts = [
    assetGroup(asset),
    asset.files.length > 1 ? `${asset.files.length} 张素材` : "",
    asset.refs.length ? `${asset.refs.length} 处引用` : "未引用",
  ].filter(Boolean);
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
  for (const file of new Set(entries.flatMap(entry => entry.files))) {
    const handle = files.acquireUrl(`资产/${file}`, mimeType(file));
    releases.push(handle.release);
    urls[file] = await handle.url.catch(() => "");
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

// ACT: 服务端监听 资产/ 与 生成/待归位，文件增删改后经 SSE 通知页面拉取最新快照。
function subscribe() {
  stopWatch();
  const directory = workspace.project?.directory;
  if (!directory) return;
  const connection = new EventSource(`/api/storyboard/watch?directory=${encodeURIComponent(directory)}`);
  source = connection;
  connection.onopen = () => { if (source === connection) reconnectDelay = 1000; };
  connection.onmessage = () => { if (source === connection) void refresh(); };
  connection.onerror = () => {
    if (source !== connection) return;
    connection.close();
    source = null;
    // ACT: 服务端重启或短暂断线时按退避重连，恢复后继续自动刷新。
    reconnectTimer = window.setTimeout(() => { if (!source) subscribe(); }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 15000);
  };
}

function stopWatch() {
  window.clearTimeout(reconnectTimer);
  source?.close();
  source = null;
}

watch(() => workspace.project?.directory, (current, previous) => {
  if (current === previous) return;
  appliedSignature = "";
  void refresh();
  subscribe();
});

onMounted(() => {
  void refresh();
  subscribe();
});
onBeforeUnmount(() => {
  stopWatch();
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
  .assetsStats { font-size: 12px; color: var(--el-text-color-secondary); }
  .refreshButton { margin-left: auto; }
}

.assetsHint {
  margin: 24px 16px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.assetsBody {
  display: grid;
  flex: 1;
  grid-template-columns: 184px minmax(0, 1fr);
  min-height: 0;
}

.assetNav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px;
  overflow-y: auto;
  border-right: 1px solid var(--el-border-color-light);

  .navRow {
    display: flex;
    gap: 2px;
    align-items: center;
    border-radius: 6px;

    &:hover { background: var(--el-fill-color-light); }
  }

  .navItem {
    display: flex;
    flex: 1;
    gap: 8px;
    align-items: center;
    justify-content: space-between;
    min-width: 0;
    padding: 6px 10px;
    font-size: 12px;
    color: var(--el-text-color-regular);
    text-align: left;
    cursor: pointer;
    background: transparent;
    border: 0;
    border-radius: 6px;

    &.on {
      font-weight: 600;
      color: var(--el-color-primary);
      background: var(--el-color-primary-light-9);
    }

    .navLabel { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .navCount { flex: none; font-size: 11px; color: var(--el-text-color-secondary); }
  }

  .navToggle {
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 24px;
    padding: 0;
    color: var(--el-text-color-secondary);
    cursor: pointer;
    background: transparent;
    border: 0;
    border-radius: 4px;

    &:hover { color: var(--el-color-primary); background: var(--el-fill-color); }

    .navCaret {
      width: 12px;
      height: 12px;
      transition: transform 0.15s;

      &.open { transform: rotate(90deg); }
    }
  }

  .navSubjects {
    display: flex;
    flex-direction: column;
    gap: 1px;
    margin: 2px 0 4px 8px;
    padding-left: 6px;
    border-left: 1px solid var(--el-border-color-light);

    .navSubject {
      display: flex;
      gap: 6px;
      align-items: center;
      justify-content: space-between;
      padding: 4px 8px;
      font-size: 12px;
      color: var(--el-text-color-regular);
      text-align: left;
      cursor: pointer;
      background: transparent;
      border: 0;
      border-radius: 5px;

      &:hover { background: var(--el-fill-color-light); }

      &.on {
        font-weight: 600;
        color: var(--el-color-primary);
        background: var(--el-color-primary-light-9);
      }

      &.missing .navCount { color: var(--el-color-warning); }

      .navLabel { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .navCount { flex: none; font-size: 11px; color: var(--el-text-color-secondary); }
    }
  }
}

.assetMain {
  min-width: 0;
  padding: 12px 16px;
}

.assetSection {
  margin-bottom: 20px;

  .assetSectionTitle {
    display: flex;
    gap: 8px;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 8px;
    font-size: 13px;
    font-weight: 600;
    color: var(--el-text-color-primary);
  }

  .sectionMeta { font-size: 11px; font-weight: 400; color: var(--el-text-color-secondary); }
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

.pendingSection {
  margin-bottom: 16px;

  .pendingTitle { margin-bottom: 8px; font-size: 12px; font-weight: 600; color: var(--el-text-color-regular); }
  .pendingList { display: flex; flex-wrap: wrap; gap: 6px; }
  .pendingItem {
    max-width: 260px;
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
