<template>
  <div class="accountPanel">
    <div class="accountIntro">
      <div class="accountText">
        <el-text tag="strong">TF-Router 官方账户</el-text>
        <el-text size="small" type="info">登录后自动配置文本模型与媒体模型，也可以手动填写 API Key。</el-text>
      </div>
      <el-tag size="small" :type="apiKey ? 'success' : 'info'">{{ apiKey ? "已配置" : "未配置" }}</el-tag>
    </div>
    <div class="accountActions">
      <el-button type="primary" :icon="IconLogin" :loading="saving" @click="openLogin">
        {{ apiKey ? "重新登录 TF-Router" : "登录 TF-Router" }}
      </el-button>
      <el-text v-if="loginError" type="danger" size="small">{{ loginError }}</el-text>
    </div>

    <tfAccount :apiKey="apiKey" :visible="visible" :saveApiKey="saveApiKey" />

    <el-dialog v-model="loginVisible" title="登录 TF-Router" width="min(640px, 92vw)" alignCenter appendToBody destroyOnClose>
      <div v-loading="saving" class="loginBody" element-loading-text="正在配置文本模型和媒体模型…">
        <iframe ref="loginFrame" class="loginFrame" :src="loginUrl" title="TF-Router 登录与注册" />
      </div>
      <el-alert v-if="loginError" class="loginError" :title="loginError" type="error" :closable="false" showIcon />
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import axios from "axios";
import { ElMessage } from "element-plus";
import { IconLogin } from "@tabler/icons-vue";
import { customProviders } from "@/stores/settings";
import { applyTfRouterKey } from "@/lib/tfRouterSetup";
import { isTfRouterProvider } from "@/lib/tf";
import tfAccount from "../tfAccount.vue";

const { visible = true } = defineProps<{ visible?: boolean }>();

const apiKey = computed(() => {
  const provider = customProviders.value.find(item => isTfRouterProvider(item));
  return typeof provider?.apiKey === "string" ? provider.apiKey.trim() : "";
});

const loginVisible = ref(false);
const loginUrl = "https://api.toonflow.net/login?type=toonflow";
const loginOrigin = new URL(loginUrl).origin;
const loginFrame = ref<HTMLIFrameElement>();
const loginError = ref("");
const saving = ref(false);
let request: AbortController | undefined;

function openLogin() {
  loginError.value = "";
  loginVisible.value = true;
}

async function receiveLogin(event: MessageEvent) {
  if (!loginVisible.value || saving.value || event.origin !== loginOrigin || event.source !== loginFrame.value?.contentWindow) return;
  const data = event.data as { type?: string; msg?: string; key?: string; error?: string } | null;
  if (!data || typeof data !== "object" || !["register", "login"].includes(data.type ?? "")) return;
  if (data.msg === "failed") {
    loginError.value = typeof data.error === "string" && data.error.trim() ? data.error : data.type === "register" ? "注册失败" : "登录失败";
    return;
  }
  if (data.msg !== "success") return;
  if (data.type === "register") {
    ElMessage.success("注册成功，请继续登录以自动配置模型");
    return;
  }
  if (typeof data.key !== "string" || !data.key.trim() || data.key.length > 8192) {
    loginError.value = "登录未返回有效的 API Key，请重新登录";
    return;
  }
  const key = data.key.trim();
  loginError.value = "";
  saving.value = true;
  const active = new AbortController();
  request = active;
  try {
    await applyTfRouterKey(key, active.signal);
    if (active.signal.aborted) return;
    ElMessage.success("TF-Router API Key 已配置完成");
    loginVisible.value = false;
  } catch (error) {
    if (!active.signal.aborted)
      loginError.value = axios.isAxiosError(error)
        ? error.response?.data?.message || "自动配置失败，请重试"
        : error instanceof Error
        ? error.message
        : "自动配置失败，请重试";
  } finally {
    saving.value = false;
  }
}

async function saveApiKey(key: string) {
  await applyTfRouterKey(key);
  ElMessage.success("API Key 已保存");
}

onMounted(() => {
  window.addEventListener("message", receiveLogin);
});
onBeforeUnmount(() => {
  window.removeEventListener("message", receiveLogin);
  request?.abort();
});
</script>

<style lang="scss" scoped>
.accountPanel {
  display: flex;
  flex-direction: column;
  gap: 16px;

  .accountIntro {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;

    .accountText {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
  }

  .accountActions {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .loginBody {
    height: min(640px, 78vh);
    border: 1px solid var(--el-border-color-light);
    border-radius: var(--el-border-radius-base);
    overflow: hidden;
  }

  .loginFrame {
    width: 100%;
    height: 100%;
    border: 0;
  }

  .loginError {
    margin-top: 12px;
  }
}
</style>
