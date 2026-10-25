import axios from "axios";
import tfRouter from "@toonflow/providers/language/tfRouter";
import tfRouterSource from "@toonflow/providers/media/tfRouter?raw";
import { invalidateNodeModels } from "@toonflow/nodes-scaffold/nodeAi";
import { saveSettings } from "@/stores/settings";
import type { MediaProvider } from "@/components/settings/panels/mediaModel/types";

// ACT: 登录拿到的 Key 与设置面板手动填写的 Key 都走这里，保证文本供应商和媒体供应商的 apiKey 同步。
export async function applyTfRouterKey(apiKey: string, signal?: AbortSignal) {
  const mediaResponse = await axios.get<{ code: number; data: MediaProvider[] }>("/api/providers/media/list", { signal });
  if (mediaResponse.data.code !== 200 || !Array.isArray(mediaResponse.data.data)) throw new Error("读取媒体供应商失败，请重试配置");
  signal?.throwIfAborted();
  if (!mediaResponse.data.data.some(provider => provider.id === tfRouter.id)) {
    await axios.post("/api/providers/media/add", { source: tfRouterSource }, { signal });
  }
  signal?.throwIfAborted();
  // ACT: 媒体文件已安装但保存失败时保留文件，重试通过列表复用，不覆盖用户编辑的模型。
  await saveSettings(settings => {
    signal?.throwIfAborted();
    const providers = settings.customProviders ?? [];
    if (!Array.isArray(providers)) throw new Error("语言模型配置格式无效");
    const configs = settings.mediaProviderConfigs as Record<string, Record<string, unknown>> | undefined;
    if (configs !== undefined && (!configs || typeof configs !== "object" || Array.isArray(configs))) throw new Error("媒体供应商配置格式无效");
    const current = configs?.[tfRouter.id];
    if (current !== undefined && (!current || typeof current !== "object" || Array.isArray(current))) throw new Error("当前供应商配置格式无效");
    const index = providers.findIndex(provider => typeof provider?.id === "string" && provider.id.toLowerCase() === tfRouter.id.toLowerCase());
    const previous = providers[index];
    const provider = {
      ...previous,
      id: previous?.id ?? tfRouter.id,
      label: previous?.label ?? tfRouter.label,
      icon: previous?.icon ?? tfRouter.icon,
      apiUrl: tfRouter.apiUrl,
      protocol: tfRouter.protocol,
      apiKey,
      models: previous?.models ?? [],
    };
    return {
      customProviders: index < 0 ? [...providers, provider] : providers.map((item, position) => position === index ? provider : item),
      mediaProviderConfigs: { ...configs, [tfRouter.id]: { ...current, apiKey } },
    };
  });
  invalidateNodeModels("media");
}
