<template>
  <div class="comfyuiLocal">
    <section class="settingSection" aria-labelledby="comfyuiDirectoryTitle">
      <div class="settingInfo">
        <h3 id="comfyuiDirectoryTitle">ComfyUI 目录</h3>
        <p class="description">选择包含 main.py 的 ComfyUI 安装目录，保存后用于软件启动时自动拉起。</p>
      </div>
      <div class="pathRow">
        <el-input v-model="config.directory" placeholder="例如 D:\ComfyUI" clearable aria-label="ComfyUI 目录" />
        <el-button @click="chooseFolder('directory')">选择目录</el-button>
      </div>
    </section>

    <section class="settingSection" aria-labelledby="comfyuiPythonTitle">
      <div class="settingInfo">
        <h3 id="comfyuiPythonTitle">Python 环境</h3>
        <p class="description">填写 python.exe 路径或虚拟环境根目录（自动查找 Scripts/python.exe）；留空使用系统 python。</p>
      </div>
      <div class="pathRow">
        <el-input v-model="config.python" placeholder="例如 D:\ComfyUI\venv" clearable aria-label="Python 环境" />
        <el-button @click="chooseFolder('python')">选择目录</el-button>
      </div>
    </section>

    <section class="settingSection">
      <div class="settingHeader">
        <div class="settingInfo">
          <h3>软件启动时自动启动</h3>
          <p class="description">打开应用后自动启动 ComfyUI；检测到已在运行的服务时不会重复启动。</p>
        </div>
        <el-switch v-model="config.autoStart" aria-label="软件启动时自动启动 ComfyUI" />
      </div>
    </section>

    <section class="settingSection">
      <div class="settingHeader">
        <div class="settingInfo">
          <h3>运行状态</h3>
          <p class="description">
            {{ status?.message || "正在读取状态" }}<span v-if="status?.pid"> · PID {{ status.pid }}</span>
          </p>
        </div>
        <el-tag :type="statusTagType" size="small">{{ statusLabel }}</el-tag>
      </div>
      <div class="actions">
        <el-button type="primary" :loading="saving" :disabled="!!acting" @click="saveConfig">保存配置</el-button>
        <el-button :loading="acting === 'start'" :disabled="busy || running || !status?.configured" @click="act('start')">启动</el-button>
        <el-button :loading="acting === 'restart'" :disabled="busy || !status?.configured" @click="act('restart')">重启</el-button>
        <el-button :loading="acting === 'stop'" :disabled="busy || stopped" @click="act('stop')">停止</el-button>
      </div>
      <p class="description">修改目录或 Python 环境后请先保存配置，再启动或重启。</p>
    </section>

    <el-dialog v-model="browserVisible" title="选择文件夹" width="560px" appendToBody>
      <div class="browser">
        <div class="browserBar">
          <el-button :disabled="!browserParent" @click="browserParent && loadDirectory(browserParent)">上一级</el-button>
          <span class="browserPath" :title="browserPath">{{ browserPath || "此电脑" }}</span>
        </div>
        <el-scrollbar height="320px">
          <p v-if="browserLoading" class="browserEmpty">正在读取目录</p>
          <p v-else-if="!browserEntries.length" class="browserEmpty">当前目录没有子文件夹</p>
          <template v-else>
            <button v-for="entry in browserEntries" :key="entry.path" class="browserItem" type="button" @click="loadDirectory(entry.path)">
              <IconFolder :size="16" aria-hidden="true" />
              <span>{{ entry.name }}</span>
            </button>
          </template>
        </el-scrollbar>
      </div>
      <template #footer>
        <el-button @click="browserVisible = false">取消</el-button>
        <el-button type="primary" :disabled="!browserPath" @click="confirmBrowser">选择此目录</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import axios from "axios";
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { IconFolder } from "@tabler/icons-vue";
import { isDesktop, isRemoteConnection } from "@/lib/platform";
import { saveSettings, settings } from "@/stores/settings";

type ComfyuiStatus = {
  status: "stopped" | "starting" | "running" | "error";
  message: string;
  pid?: number;
  external: boolean;
  configured: boolean;
};

const requestHeaders = { "x-toonflow-workspace": "1" };
const config = reactive({ directory: "", python: "", autoStart: true });
const status = ref<ComfyuiStatus>();
const saving = ref(false);
const acting = ref<"start" | "stop" | "restart">();
const canBrowse = isDesktop && !isRemoteConnection;
const browserVisible = ref(false);
const browserField = ref<"directory" | "python">("directory");
const browserPath = ref("");
const browserParent = ref<string | null>(null);
const browserEntries = ref<{ name: string; path: string }[]>([]);
const browserLoading = ref(false);
const busy = computed(() => !!acting.value || saving.value);
const running = computed(() => status.value?.status === "running" || status.value?.status === "starting");
const stopped = computed(() => !status.value || status.value.status === "stopped");
const statusLabel = computed(() => ({
  stopped: "未运行",
  starting: "启动中",
  running: "运行中",
  error: "启动失败",
}[status.value?.status ?? "stopped"]));
const statusTagType = computed(() => ({
  stopped: "info",
  starting: "warning",
  running: "success",
  error: "danger",
}[status.value?.status ?? "stopped"] as "info" | "warning" | "success" | "danger"));

let timer: ReturnType<typeof setInterval> | undefined;
let refreshing = false;

function applySettings() {
  const raw = settings.value.comfyuiLocal;
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  config.directory = typeof value.directory === "string" ? value.directory : "";
  config.python = typeof value.python === "string" ? value.python : "";
  config.autoStart = value.autoStart !== false;
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const { data } = await axios.get<{ code: number; data: ComfyuiStatus }>("/api/comfyui/local/status", { headers: requestHeaders });
    if (data.code === 200) status.value = data.data;
  } catch {
    // ACT: 状态轮询失败时保留上一次结果，避免面板反复闪回未运行。
  } finally {
    refreshing = false;
  }
}

async function saveConfig() {
  saving.value = true;
  try {
    await saveSettings(current => ({
      ...current,
      comfyuiLocal: { directory: config.directory.trim(), python: config.python.trim(), autoStart: config.autoStart },
    }));
    ElMessage.success("本地 ComfyUI 配置已保存");
    await refresh();
  } catch {
    ElMessage.error("保存本地 ComfyUI 配置失败，请稍后重试");
  } finally {
    saving.value = false;
  }
}

async function act(name: "start" | "stop" | "restart") {
  if (busy.value) return;
  acting.value = name;
  try {
    const { data } = await axios.post<{ code: number; data: ComfyuiStatus; message: string }>(`/api/comfyui/local/${name}`, null, { headers: requestHeaders });
    if (data.code !== 200) throw new Error(data.message);
    status.value = data.data;
    ElMessage.success(data.message);
    void refresh();
  } catch (error) {
    ElMessage.error(axios.isAxiosError<{ message?: string }>(error)
      ? error.response?.data?.message || "操作失败"
      : error instanceof Error ? error.message : "操作失败");
  } finally {
    acting.value = undefined;
  }
}

async function loadDirectory(path: string) {
  browserLoading.value = true;
  try {
    const { data } = await axios.get<{
      code: number;
      data: { directory: string; parent: string | null; entries: { name: string; path: string }[] };
      message: string;
    }>("/api/comfyui/local/browse", { params: { path }, headers: requestHeaders });
    if (data.code !== 200) throw new Error(data.message);
    browserPath.value = data.data.directory;
    browserParent.value = data.data.parent;
    browserEntries.value = data.data.entries;
  } catch (error) {
    ElMessage.error(axios.isAxiosError<{ message?: string }>(error)
      ? error.response?.data?.message || "读取目录失败"
      : error instanceof Error ? error.message : "读取目录失败");
  } finally {
    browserLoading.value = false;
  }
}

function openBrowser(field: "directory" | "python") {
  browserField.value = field;
  browserVisible.value = true;
  void loadDirectory(config[field].trim());
}

function confirmBrowser() {
  config[browserField.value] = browserPath.value;
  browserVisible.value = false;
}

async function chooseFolder(field: "directory" | "python") {
  // ACT: 浏览器访问时没有原生目录选择器，改用本机目录浏览弹窗。
  if (!canBrowse) {
    openBrowser(field);
    return;
  }
  try {
    const { data } = await axios.post<{ data: { directory: string | null } }>("/api/desktop/selectDirectory", null, {
      headers: { "x-toonflow-desktop": "1" },
    });
    if (data.data?.directory) config[field] = data.data.directory;
  } catch {
    ElMessage.error("无法打开文件夹选择器，请手动填写路径");
  }
}

onMounted(() => {
  applySettings();
  void refresh();
  timer = setInterval(() => void refresh(), 3000);
});

onBeforeUnmount(() => clearInterval(timer));
</script>

<style lang="scss" scoped>
.comfyuiLocal {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 0 4px 8px;

  .settingSection {
    .settingHeader {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 24px;

      > .el-switch {
        flex-shrink: 0;
      }
    }

    .settingInfo h3 {
      margin: 0 0 6px;
      font-size: 14px;
      font-weight: 600;
    }

    .description {
      margin: 0;
      color: var(--el-text-color-secondary);
      font-size: 12px;
      line-height: 1.6;
    }

    .pathRow {
      display: flex;
      gap: 10px;
      margin-top: 10px;

      .el-input {
        flex: 1;
        min-width: 0;
      }
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin: 12px 0 8px;
    }
  }
}

.browser {
  .browserBar {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 8px;
  }

  .browserPath {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    color: var(--el-text-color-secondary);
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .browserItem {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 8px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--el-text-color-primary);
    cursor: pointer;
    font-size: 13px;
    text-align: left;

    &:hover {
      background: var(--el-fill-color-light);
    }
  }

  .browserEmpty {
    margin: 12px 8px;
    color: var(--el-text-color-secondary);
    font-size: 12px;
  }
}
</style>
