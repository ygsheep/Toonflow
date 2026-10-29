/**
 * 本地 ComfyUI 媒体适配器
 *
 * 内置 Qwen Image 2.1 文生图与 MiniMax H3 参考图生视频工作流，通过 ComfyUI 的 HTTP 接口调用：
 * - 提交 POST /prompt
 * - 查询 GET /history/{prompt_id}
 * - 取结果 GET /view?filename=&subfolder=&type=output
 * - 上传参考图与参考音频 POST /upload/image
 */

type Context = ProviderContext<{ serverUrl?: string }>;

type ComfyWorkflow = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

type ComfyOutputFile = { filename: string; subfolder: string; type: string };

type ComfyOutput = { filename?: string; subfolder?: string; type?: string };

type HistoryEntry = {
  outputs?: Record<string, { images?: ComfyOutput[]; gifs?: ComfyOutput[] }>;
  status?: { status_str?: string; completed?: boolean; messages?: unknown };
};

const rules = [
  {
    type: "input",
    field: "serverUrl" as const,
    title: "ComfyUI 服务地址",
    value: "http://127.0.0.1:8188",
    props: { placeholder: "http://127.0.0.1:8188" },
    validate: [{ required: true, whitespace: true, message: "请填写 ComfyUI 服务地址" }],
  },
];

const version = "1.4.0";

/** 图片生成的总等待上限（毫秒）。 */
const imageTimeout = 20 * 60 * 1000;
/** 视频生成的总等待上限（毫秒）。 */
const videoTimeout = 90 * 60 * 1000;
/** 任务状态轮询间隔（毫秒）。 */
const pollInterval = 1500;

/**
 * Qwen Image 2.1 工作流。
 * ACT: 已剔除未启用的提示词改写分支，提示词直接接到 485 节点，减少对文本编码模型的依赖。
 */
const imageWorkflow: ComfyWorkflow = {
  "13": {
    inputs: { aspect_ratio: "16:9 (Widescreen)", megapixels: 2, multiple: 8 },
    class_type: "ResolutionSelector",
  },
  "461": {
    inputs: { filename_prefix: "Toonflow", format: "png", "format.bit_depth": "8-bit", "format.input_color_space": "sRGB", images: ["459:457", 0] },
    class_type: "SaveImageAdvanced",
  },
  "485": {
    inputs: { value: "" },
    class_type: "PrimitiveStringMultiline",
  },
  "459:451": {
    inputs: { unet_name: "qwen_image_2.1_int8_convrot.safetensors", weight_dtype: "default" },
    class_type: "UNETLoader",
  },
  "459:452": {
    inputs: { prompt: ["485", 0], negative_prompt: "", resolution: 1024, clip: ["459:453", 0] },
    class_type: "TextEncodeQwenImage21",
  },
  "459:453": {
    inputs: { clip_name: "qwen3vl_8b_int8_convrot.safetensors", type: "qwen_image", device: "default" },
    class_type: "CLIPLoader",
  },
  "459:454": {
    inputs: { vae_name: "qwen_image_2.1_vae_bf16.safetensors" },
    class_type: "VAELoader",
  },
  "459:456": {
    inputs: { width: ["13", 0], height: ["13", 1], batch_size: 1 },
    class_type: "EmptyLatentImage",
  },
  "459:457": {
    inputs: { samples: ["459:458", 0], vae: ["459:454", 0] },
    class_type: "VAEDecode",
  },
  "459:458": {
    inputs: {
      seed: 0,
      steps: 25,
      cfg: 1,
      sampler_name: "euler",
      scheduler: "simple",
      denoise: 1,
      model: ["459:480", 0],
      positive: ["459:452", 0],
      negative: ["459:452", 1],
      latent_image: ["459:456", 0],
    },
    class_type: "KSampler",
  },
  "459:480": {
    inputs: { device: "auto", dtype: "default", model: ["459:451", 0] },
    class_type: "QwenImage21Cache",
  },
};

/**
 * Qwen Image 2.1 图片编辑工作流。
 * ACT: 移除提示词改写与对比预览分支，提示词直接写入编码节点；输出尺寸跟随不超过 2 张参考图，忽略尺寸与比例参数。
 */
const editImageWorkflow: ComfyWorkflow = {
  "461": {
    inputs: { filename_prefix: "Toonflow", format: "png", "format.bit_depth": "8-bit", "format.input_color_space": "sRGB", images: ["459:457", 0] },
    class_type: "SaveImageAdvanced",
  },
  "470": { inputs: { image: "" }, class_type: "LoadImage" },
  "475": { inputs: { image: "" }, class_type: "LoadImage" },
  "459:451": {
    inputs: { unet_name: "qwen_image_2.1_int8_convrot.safetensors", weight_dtype: "default" },
    class_type: "UNETLoader",
  },
  "459:453": {
    inputs: { clip_name: "qwen3vl_8b_int8_convrot.safetensors", type: "qwen_image", device: "default" },
    class_type: "CLIPLoader",
  },
  "459:454": { inputs: { vae_name: "qwen_image_2.1_vae_bf16.safetensors" }, class_type: "VAELoader" },
  "459:457": { inputs: { samples: ["459:458", 0], vae: ["459:454", 0] }, class_type: "VAEDecode" },
  "459:458": {
    inputs: {
      seed: 0,
      steps: 25,
      cfg: 1,
      sampler_name: "euler",
      scheduler: "simple",
      denoise: 1,
      model: ["459:469", 0],
      positive: ["459:474", 0],
      negative: ["459:474", 1],
      latent_image: ["459:474", 2],
    },
    class_type: "KSampler",
  },
  "459:469": {
    inputs: { device: "auto", dtype: "default", model: ["459:451", 0] },
    class_type: "QwenImage21Cache",
  },
  "459:474": {
    inputs: {
      prompt: "Replace costumes for the character",
      negative_prompt: "",
      // ACT: 参考图需缩到模型训练分辨率附近，0 会按原图尺寸编码，参考 latent 过长导致编辑指令几乎不生效、输出接近复制原图。
      resolution: 1024,
      clip: ["459:453", 0],
      "images.image_1": ["470", 0],
      "images.image_2": ["475", 0],
      vae: ["459:454", 0],
    },
    class_type: "TextEncodeQwenImage21",
  },
};

/**
 * Qwen Image Edit 2511 工作流（外部导入）。
 * ACT: 面向抠图与人物/场景编辑；默认 40 步 + CFG 4，把 170:168 开关改为 true 可启用 4 步 Lightning LoRA。
 */
const editImage2511Workflow: ComfyWorkflow = {
  "9": { inputs: { filename_prefix: "Toonflow", images: ["170:158", 0] }, class_type: "SaveImage" },
  "41": { inputs: { image: "" }, class_type: "LoadImage" },
  "83": { inputs: { image: "" }, class_type: "LoadImage" },
  "170:145": { inputs: { shift: 3.1, sampling: "flow", model: ["170:161", 0] }, class_type: "ModelSamplingAuraFlow" },
  "170:146": { inputs: { vae_name: "qwen_image_vae.safetensors" }, class_type: "VAELoader" },
  "170:147": { inputs: { reference_latents_method: "index_timestep_zero", conditioning: ["170:149", 0] }, class_type: "FluxKontextMultiReferenceLatentMethod" },
  "170:148": { inputs: { reference_latents_method: "index_timestep_zero", conditioning: ["170:151", 0] }, class_type: "FluxKontextMultiReferenceLatentMethod" },
  "170:149": { inputs: { prompt: "", clip: ["170:162", 0], vae: ["170:146", 0], image1: ["170:160", 0], image2: ["83", 0] }, class_type: "TextEncodeQwenImageEditPlus" },
  "170:151": { inputs: { prompt: "Change the furniture leather difference in image 1 to the fur material in image 2.", clip: ["170:162", 0], vae: ["170:146", 0], image1: ["170:160", 0], image2: ["83", 0] }, class_type: "TextEncodeQwenImageEditPlus" },
  "170:152": { inputs: { strength: 1, pre_cfg: false, model: ["170:145", 0] }, class_type: "CFGNorm" },
  "170:153": { inputs: { lora_name: "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors", strength_model: 1, model: ["170:152", 0] }, class_type: "LoraLoaderModelOnly" },
  "170:154": { inputs: { value: 4 }, class_type: "PrimitiveFloat" },
  "170:155": { inputs: { value: 1 }, class_type: "PrimitiveFloat" },
  "170:156": { inputs: { pixels: ["170:160", 0], vae: ["170:146", 0] }, class_type: "VAEEncode" },
  "170:158": { inputs: { samples: ["170:169", 0], vae: ["170:146", 0] }, class_type: "VAEDecode" },
  "170:160": { inputs: { image: ["41", 0] }, class_type: "FluxKontextImageScale" },
  "170:161": { inputs: { unet_name: "qwen_image_edit_2511_fp8mixed.safetensors", weight_dtype: "default" }, class_type: "UNETLoader" },
  "170:162": { inputs: { clip_name: "qwen_2.5_vl_7b_fp8_scaled.safetensors", type: "qwen_image", device: "default" }, class_type: "CLIPLoader" },
  "170:163": { inputs: { switch: ["170:168", 0], on_false: ["170:152", 0], on_true: ["170:153", 0] }, class_type: "ComfySwitchNode" },
  "170:164": { inputs: { switch: ["170:168", 0], on_false: ["170:154", 0], on_true: ["170:155", 0] }, class_type: "ComfySwitchNode" },
  "170:165": { inputs: { value: 4 }, class_type: "PrimitiveInt" },
  "170:166": { inputs: { value: 40 }, class_type: "PrimitiveInt" },
  "170:167": { inputs: { switch: ["170:168", 0], on_false: ["170:166", 0], on_true: ["170:165", 0] }, class_type: "ComfySwitchNode" },
  "170:168": { inputs: { value: false }, class_type: "PrimitiveBoolean" },
  "170:169": { inputs: { seed: 0, steps: ["170:167", 0], cfg: ["170:164", 0], sampler_name: "euler", scheduler: "simple", denoise: 1, model: ["170:163", 0], positive: ["170:148", 0], negative: ["170:147", 0], latent_image: ["170:156", 0] }, class_type: "KSampler" },
};

/**
 * Krea2 角色四视图工作流。
 * ACT: 移除仅用于预览的 GetImageSize 节点，参考图缩放后接入 Krea2 编辑编码，输出固定 1536x1024。
 */
const characterSheetWorkflow: ComfyWorkflow = {
  "122": {
    inputs: { clip_name: "qwen3vl_4b_fp8_scaled.safetensors", type: "krea2", device: "default" },
    class_type: "CLIPLoader",
  },
  "123": { inputs: { vae_name: "qwen_image_vae.safetensors" }, class_type: "VAELoader" },
  "125": { inputs: { pixels: ["136", 0], vae: ["123", 0] }, class_type: "VAEEncode" },
  "127": { inputs: { samples: ["142", 0], vae: ["123", 0] }, class_type: "VAEDecode" },
  "128": {
    inputs: { unet_name: "krea2_turbo_int8_convrot.safetensors", weight_dtype: "default" },
    class_type: "UNETLoader",
  },
  "129": { inputs: { filename_prefix: "Toonflow", images: ["127", 0] }, class_type: "SaveImage" },
  "132": {
    inputs: {
      ref_boost: 1,
      ref_boost_a: 1,
      fit_mode: "fit",
      model: ["145", 0],
      source_latent: ["125", 0],
      vae: ["123", 0],
      source_image: ["136", 0],
    },
    class_type: "Krea2EditModelPatch",
  },
  "133": {
    inputs: { prompt: "", grounding_px: 768, system_prompt: "", clip: ["122", 0], image: ["136", 0] },
    class_type: "Krea2EditGroundedEncode",
  },
  "136": {
    inputs: {
      width: 1024,
      height: 1024,
      upscale_method: "lanczos",
      keep_proportion: "resize",
      pad_color: "0, 0, 0",
      crop_position: "center",
      divisible_by: 2,
      device: "cpu",
      image: ["146", 0],
    },
    class_type: "ImageResizeKJv2",
  },
  "141": { inputs: { width: 1536, height: 1024, batch_size: 1 }, class_type: "EmptySD3LatentImage" },
  "142": {
    inputs: {
      seed: 0,
      steps: 10,
      cfg: 1,
      sampler_name: "euler",
      scheduler: "simple",
      denoise: 1,
      model: ["132", 0],
      positive: ["143", 0],
      negative: ["133", 0],
      latent_image: ["141", 0],
    },
    class_type: "KSampler",
  },
  "143": {
    inputs: {
      prompt: "Convert the character in the image to a Character Sheet showing a face close-up, front full body, side full body and back full body views",
      grounding_px: 0,
      system_prompt: "",
      clip: ["122", 0],
      image: ["136", 0],
    },
    class_type: "Krea2EditGroundedEncode",
  },
  "145": {
    inputs: { lora_name: "krea2_4panel.safetensors", strength_model: 1, model: ["128", 0] },
    class_type: "LoraLoaderModelOnly",
  },
  "146": { inputs: { image: "" }, class_type: "LoadImage" },
};

/**
 * MiniMax H3 参考图生视频工作流（含音频）。
 * ACT: 已剔除二次放大与未启用的分支，保留 9 个参考图与 3 个参考音频槽位；未提供的槽位在提交前删除。
 */
const videoWorkflow: ComfyWorkflow = {
  "56": {
    inputs: {
      prompt: ["84", 0],
      width: ["73", 0],
      height: ["73", 1],
      length: ["75", 1],
      ref_image_size: "max",
      clip: ["118", 1],
      vae: ["65", 0],
      audio_vae: ["66", 0],
      "ref_images.ref_image_0": ["170", 0],
      "ref_images.ref_image_1": ["172", 0],
      "ref_images.ref_image_2": ["173", 0],
      "ref_images.ref_image_3": ["169", 0],
      "ref_images.ref_image_4": ["148", 0],
      "ref_images.ref_image_5": ["178", 0],
      "ref_images.ref_image_6": ["182", 0],
      "ref_images.ref_image_7": ["183", 0],
      "ref_images.ref_image_8": ["184", 0],
      "ref_audios.ref_audio_0": ["175", 0],
      "ref_audios.ref_audio_1": ["176", 0],
      "ref_audios.ref_audio_2": ["177", 0],
    },
    class_type: "MiniMaxH3ReferenceToVideo",
  },
  "57": { inputs: { model: ["118", 0], conditioning: ["56", 0] }, class_type: "BasicGuider" },
  "58": { inputs: { sampler_name: "euler" }, class_type: "KSamplerSelect" },
  "63": { inputs: { noise_seed: 0 }, class_type: "RandomNoise" },
  "64": {
    inputs: { clip_name: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", type: "minimax", device: "default" },
    class_type: "CLIPLoader",
  },
  "65": { inputs: { vae_name: "minimax_h3_video_vae_fp16.safetensors" }, class_type: "VAELoader" },
  "66": { inputs: { vae_name: "minimax_h3_audio_vae_fp32.safetensors" }, class_type: "VAELoader" },
  "69": {
    inputs: { unet_name: "DasiwaMinimaxH3_dasiwaHybridV4_int8.safetensors", weight_dtype: "default" },
    class_type: "UNETLoader",
  },
  "70": { inputs: { model: ["69", 0] }, class_type: "MiniMaxH3MemoryEfficientSageAttentionPatch" },
  "71": { inputs: { scheduler: "simple", steps: 6, denoise: 1, model: ["118", 0] }, class_type: "BasicScheduler" },
  "73": { inputs: { aspect_ratio: "16:9 (Widescreen)", megapixels: 0.4, multiple: 8 }, class_type: "ResolutionSelector" },
  "74": { inputs: { value: 10 }, class_type: "PrimitiveFloat" },
  "75": {
    inputs: {
      expression: "max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17",
      "values.a": ["74", 0],
    },
    class_type: "ComfyMathExpression",
  },
  "84": { inputs: { value: "" }, class_type: "PrimitiveStringMultiline" },
  "102": { inputs: { av_latent: ["108", 0] }, class_type: "LTXVSeparateAVLatent" },
  "108": {
    inputs: { noise: ["63", 0], guider: ["57", 0], sampler: ["58", 0], sigmas: ["71", 0], latent_image: ["56", 1] },
    class_type: "SamplerCustomAdvanced",
  },
  "109": { inputs: { samples: ["102", 0], vae: ["65", 0] }, class_type: "VAEDecode" },
  "110": { inputs: { samples: ["102", 1], vae: ["66", 0] }, class_type: "VAEDecodeAudio" },
  "118": {
    inputs: {
      lora_01: "None",
      strength_01: 0.8,
      lora_02: "minimaxh3\\minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
      strength_02: 1,
      lora_03: "None",
      strength_03: 1,
      lora_04: "None",
      strength_04: 1,
      model: ["143", 0],
      clip: ["64", 0],
    },
    class_type: "Lora Loader Stack (rgthree)",
  },
  "119": { inputs: { attention: "comfy kitchen attention", model: ["70", 0] }, class_type: "ModelAttentionBackend" },
  "121": {
    inputs: {
      selection: "sol-attn",
      "selection.tau": 1.3,
      start_percent: 0.2,
      end_percent: 0.9,
      dense_blocks: "",
      min_tokens: 12288,
      extra_tokens: 256,
      sink_conditioning: "exact_kv_and_rows",
      verbose: false,
      model: ["119", 0],
    },
    class_type: "BlockSparseAttention",
  },
  "141": {
    inputs: {
      frame_rate: 24,
      loop_count: 0,
      filename_prefix: "Toonflow",
      format: "video/h264-mp4",
      pix_fmt: "yuv420p",
      crf: 19,
      save_metadata: false,
      trim_to_audio: false,
      pingpong: false,
      save_output: true,
      images: ["109", 0],
      audio: ["110", 0],
    },
    class_type: "VHS_VideoCombine",
  },
  "143": { inputs: { chunks: 2, seq_threshold: 4096, model: ["121", 0] }, class_type: "MiniMaxChunkFeedForward" },
  "148": { inputs: { image: "" }, class_type: "LoadImage" },
  "169": { inputs: { image: "" }, class_type: "LoadImage" },
  "170": { inputs: { image: "" }, class_type: "LoadImage" },
  "172": { inputs: { image: "" }, class_type: "LoadImage" },
  "173": { inputs: { image: "" }, class_type: "LoadImage" },
  "175": { inputs: { audio: "" }, class_type: "LoadAudio" },
  "176": { inputs: { audio: "" }, class_type: "LoadAudio" },
  "177": { inputs: { audio: "" }, class_type: "LoadAudio" },
  "178": { inputs: { image: "" }, class_type: "LoadImage" },
  "182": { inputs: { image: "" }, class_type: "LoadImage" },
  "183": { inputs: { image: "" }, class_type: "LoadImage" },
  "184": { inputs: { image: "" }, class_type: "LoadImage" },
};

/** 参考图槽位与对应的工作流加载节点，按顺序使用。 */
const videoImageSlots = ["170", "172", "173", "169", "148", "178", "182", "183", "184"];

/** 参考音频槽位与对应的工作流加载节点，按顺序使用。 */
const videoAudioSlots = ["175", "176", "177"];

/** 视频比例选择器支持的取值。 */
const videoRatioOptions: Record<string, string> = {
  "1:1": "1:1 (Square)",
  "3:4": "3:4 (Portrait Standard)",
  "4:3": "4:3 (Standard)",
  "9:16": "9:16 (Portrait Widescreen)",
  "16:9": "16:9 (Widescreen)",
};

/** 节点比例选择器支持的取值。 */
const ratioOptions: Record<string, string> = {
  "1:1": "1:1 (Square)",
  "2:3": "2:3 (Portrait Photo)",
  "3:2": "3:2 (Photo)",
  "3:4": "3:4 (Portrait Standard)",
  "4:3": "4:3 (Standard)",
  "9:16": "9:16 (Portrait Widescreen)",
  "16:9": "16:9 (Widescreen)",
  "21:9": "21:9 (Ultrawide)",
};

function sleep(signal: AbortSignal, ms: number) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

function resolveBaseUrl(value: unknown) {
  const baseUrl = (typeof value === "string" ? value : "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error("请填写有效的 ComfyUI 服务地址，例如 http://127.0.0.1:8188");
  return baseUrl;
}

/** size 形如 2MP，转为节点需要的像素量。 */
function resolveMegapixels(value: string | undefined, fallback: number) {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) && parsed >= 0.1 && parsed <= 16 ? parsed : fallback;
}

function createImageWorkflow(request: ImageRequest) {
  const workflow = JSON.parse(JSON.stringify(imageWorkflow)) as ComfyWorkflow;
  workflow["485"].inputs.value = request.prompt;
  workflow["13"].inputs.aspect_ratio = ratioOptions[request.ratio ?? ""] ?? ratioOptions["16:9"];
  workflow["13"].inputs.megapixels = resolveMegapixels(request.size, 2);
  workflow["459:458"].inputs.seed = Math.floor(Math.random() * 1e15);
  return workflow;
}

function createEditImageWorkflow(request: ImageRequest, imageNames: string[]) {
  const workflow = JSON.parse(JSON.stringify(editImageWorkflow)) as ComfyWorkflow;
  // ACT: 未填写提示词时沿用工作流内置提示词，避免覆盖预制内容。
  if (request.prompt.trim()) workflow["459:474"].inputs.prompt = request.prompt;
  workflow["459:458"].inputs.seed = Math.floor(Math.random() * 1e15);
  // ACT: 参考图数量不固定，按张数动态生成 LoadImage 并挂到 images.image_N（节点上限 16 个槽位）。
  delete workflow["470"];
  delete workflow["475"];
  const encode = workflow["459:474"].inputs;
  for (const key of Object.keys(encode)) if (key.startsWith("images.")) delete encode[key];
  imageNames.forEach((name, index) => {
    const nodeId = String(470 + index);
    workflow[nodeId] = { class_type: "LoadImage", inputs: { image: name } };
    encode[`images.image_${index + 1}`] = [nodeId, 0];
  });
  return workflow;
}

function createEditImage2511Workflow(request: ImageRequest, imageNames: string[]) {
  const workflow = JSON.parse(JSON.stringify(editImage2511Workflow)) as ComfyWorkflow;
  // ACT: 未填写提示词时沿用工作流内置提示词，避免覆盖预制内容。
  if (request.prompt.trim()) workflow["170:151"].inputs.prompt = request.prompt;
  workflow["170:169"].inputs.seed = Math.floor(Math.random() * 1e15);
  workflow["41"].inputs.image = imageNames[0];
  if (imageNames[1]) {
    workflow["83"].inputs.image = imageNames[1];
  } else {
    // ACT: TextEncodeQwenImageEditPlus 的 image2 为可选输入，只有 1 张参考图时移除该节点与连线。
    delete workflow["83"];
    delete workflow["170:149"].inputs.image2;
    delete workflow["170:151"].inputs.image2;
  }
  return workflow;
}

function createCharacterSheetWorkflow(request: ImageRequest, imageName: string) {
  const workflow = JSON.parse(JSON.stringify(characterSheetWorkflow)) as ComfyWorkflow;
  // ACT: 未填写提示词时沿用工作流内置提示词，避免覆盖预制内容。
  if (request.prompt.trim()) workflow["143"].inputs.prompt = request.prompt;
  workflow["142"].inputs.seed = Math.floor(Math.random() * 1e15);
  workflow["146"].inputs.image = imageName;
  return workflow;
}

function createVideoWorkflow(request: VideoRequest, imageNames: string[], audioNames: string[]) {
  const workflow = JSON.parse(JSON.stringify(videoWorkflow)) as ComfyWorkflow;
  workflow["84"].inputs.value = request.prompt;
  workflow["73"].inputs.aspect_ratio = videoRatioOptions[request.ratio ?? ""] ?? videoRatioOptions["16:9"];
  workflow["73"].inputs.megapixels = resolveMegapixels(request.resolution, 0.4);
  workflow["74"].inputs.value = request.duration ?? 10;
  workflow["63"].inputs.noise_seed = Math.floor(Math.random() * 1e15);
  videoImageSlots.forEach((nodeId, index) => {
    const name = imageNames[index];
    if (name) {
      workflow[nodeId].inputs.image = name;
      return;
    }
    delete workflow[nodeId];
    delete workflow["56"].inputs[`ref_images.ref_image_${index}`];
  });
  videoAudioSlots.forEach((nodeId, index) => {
    const name = audioNames[index];
    if (name) {
      workflow[nodeId].inputs.audio = name;
      return;
    }
    delete workflow[nodeId];
    delete workflow["56"].inputs[`ref_audios.ref_audio_${index}`];
  });
  return workflow;
}

function collectOutputFiles(outputs: HistoryEntry["outputs"]): ComfyOutputFile[] {
  const files: ComfyOutputFile[] = [];
  for (const output of Object.values(outputs ?? {})) {
    for (const file of [...(output.images ?? []), ...(output.gifs ?? [])]) {
      if (file?.filename) files.push({ filename: file.filename, subfolder: file.subfolder ?? "", type: file.type ?? "output" });
    }
  }
  return files;
}

function viewUrl(baseUrl: string, file: ComfyOutputFile) {
  const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder, type: file.type });
  return `${baseUrl}/view?${query}`;
}

async function submitWorkflow(context: Context, baseUrl: string, workflow: ComfyWorkflow, signal: AbortSignal) {
  const response = await context.tool.fetch(`${baseUrl}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow }),
    signal,
  });
  if (!response.ok) throw new Error(`提交 ComfyUI 任务失败：HTTP ${response.status}：${context.tool.errorMessage(await response.text())}`);
  const submitted = (await response.json()) as { prompt_id?: string; node_errors?: Record<string, unknown> };
  if (submitted.node_errors && Object.keys(submitted.node_errors).length) {
    throw new Error(`ComfyUI 工作流校验失败：${JSON.stringify(submitted.node_errors)}`);
  }
  if (!submitted.prompt_id) throw new Error("提交 ComfyUI 任务后未返回任务 ID");
  return submitted.prompt_id;
}

async function waitForOutputs(context: Context, baseUrl: string, promptId: string, signal: AbortSignal) {
  while (true) {
    let entry: HistoryEntry | undefined;
    try {
      const response = await context.tool.fetch(`${baseUrl}/history/${encodeURIComponent(promptId)}`, { signal });
      if (response.ok) entry = ((await response.json()) as Record<string, HistoryEntry>)[promptId];
    } catch (error) {
      // ACT: ComfyUI 执行任务时会短暂不响应 HTTP 请求，单次查询失败不能判定生成失败，继续轮询到总超时。
      if (signal.aborted) throw error;
    }
    if (entry) {
      if (entry.status?.status_str === "error") {
        throw new Error(`ComfyUI 生成失败：${context.tool.errorMessage(entry.status.messages) || "请查看 ComfyUI 控制台日志"}`);
      }
      const files = collectOutputFiles(entry.outputs);
      if (files.length) return files;
      if (entry.status?.completed) throw new Error("ComfyUI 任务已结束，但未返回结果文件");
    }
    await sleep(signal, pollInterval);
  }
}

const fileExtensions: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
};

async function uploadFile(context: Context, baseUrl: string, media: MediaInput, name: string, signal: AbortSignal) {
  if (media.type === "url") throw new Error("ComfyUI 参考素材暂不支持远程地址");
  const bytes = media.type === "base64" ? Buffer.from(media.data.replace(/^data:[^;]+;base64,/, ""), "base64") : media.data;
  const extension = fileExtensions[media.mimeType] ?? (media.mimeType.startsWith("audio/") ? "wav" : "png");
  const boundary = `----toonflow${Math.random().toString(16).slice(2)}`;
  // ACT: 文件名按任务唯一，避免多个并发任务上传时互相覆盖参考素材导致串图。
  const fileName = `${name}-${Math.random().toString(16).slice(2, 10)}`;
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${fileName}.${extension}"\r\nContent-Type: ${media.mimeType}\r\n\r\n`,
  );
  const tail = encoder.encode(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head);
  body.set(bytes, head.length);
  body.set(tail, head.length + bytes.length);
  const response = await context.tool.fetch(`${baseUrl}/upload/image`, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
    signal,
  });
  if (!response.ok) throw new Error(`上传参考素材到 ComfyUI 失败：HTTP ${response.status}：${context.tool.errorMessage(await response.text())}`);
  const uploaded = (await response.json()) as { name?: string; subfolder?: string };
  if (!uploaded.name) throw new Error("上传参考素材后未返回文件名");
  return uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name;
}

export default {
  id: "comfyui",
  label: "ComfyUI",
  icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiByeD0iOCIgZmlsbD0iIzIwMjEyNCIvPjxwYXRoIGQ9Ik05IDkuNWEyLjUgMi41IDAgMCAxIDIuNS0yLjVoNGEyLjUgMi41IDAgMCAxIDIuNSAyLjV2NGEyLjUgMi41IDAgMCAxLTIuNSAyLjVoLTRBMi41IDIuNSAwIDAgMSA5IDEzLjV2LTRaIiBmaWxsPSIjZjRiOTQyIi8+PHBhdGggZD0iTTE0IDE2LjVoNC41QTIuNSAyLjUgMCAwIDEgMjEgMTl2My41YTIuNSAyLjUgMCAwIDEtMi41IDIuNWgtNGEyLjUgMi41IDAgMCAxLTIuNS0yLjVWMTlhMi41IDIuNSAwIDAgMSAyLTIuNVoiIGZpbGw9IiMzYjgyZjYiLz48L3N2Zz4=",
  version,
  readme: `连接本机或局域网内的 ComfyUI，使用内置工作流生成图片或视频。

使用前请确认：
- ComfyUI 已启动，地址与服务地址一致（默认 http://127.0.0.1:8188）。
- 已安装工作流所需节点：
  - 图片：ResolutionSelector、TextEncodeQwenImage21、QwenImage21Cache、SaveImageAdvanced
  - 视频：MiniMaxH3ReferenceToVideo、MiniMaxH3MemoryEfficientSageAttentionPatch、MiniMaxChunkFeedForward、ModelAttentionBackend、BlockSparseAttention、Lora Loader Stack (rgthree)、VHS_VideoCombine、ComfyMathExpression
- 图片模型：qwen_image_2.1_int8_convrot、qwen3vl_8b_int8_convrot、qwen_image_2.1_vae_bf16
- 视频模型：DasiwaMinimaxH3_dasiwaHybridV4_int8、qwen3vl_32b_minimax_h3_nvfp4_awq、minimax_h3_video_vae_fp16、minimax_h3_audio_vae_fp32、lora minimaxh3/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16
- 视频需 1-9 张参考图、最多 3 段参考音频，输出 24fps H.264 MP4（含音频）。
- 图片编辑需 1-2 张参考图，输出尺寸跟随参考图，忽略分辨率与比例设置。
- 图片编辑（2511）需 1-2 张参考图，适合抠图与人物/场景编辑；默认 40 步 + CFG 4。
- 图片编辑（2511）所需节点：TextEncodeQwenImageEditPlus、FluxKontextImageScale、FluxKontextMultiReferenceLatentMethod、ModelSamplingAuraFlow、CFGNorm、ComfySwitchNode。
- 图片编辑（2511）所需模型：qwen_image_edit_2511_fp8mixed、qwen_2.5_vl_7b_fp8_scaled、qwen_image_vae、lora Qwen-Image-Edit-2511-Lightning-4steps-V1.0。
- 角色四视图需 1 张参考图，输出固定 1536x1024，忽略分辨率与比例设置。
- 角色四视图所需节点：Krea2EditModelPatch、Krea2EditGroundedEncode、ImageResizeKJv2（ComfyUI-KJNodes）、EmptySD3LatentImage、LoraLoaderModelOnly。
- 角色四视图所需模型：krea2_turbo_int8_convrot、qwen3vl_4b_fp8_scaled、qwen_image_vae、lora krea2_4panel。`,
  rules,
  models: [
    {
      id: "qwen-image-2.1",
      label: "Qwen Image 2.1（文生图）",
      type: "image",
      mode: ["text"],
      imageSizes: ["2MP", "4MP"],
      imageRatios: ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"],
    },
    {
      id: "qwen-image-2.1-edit",
      label: "Qwen Image 2.1（图片编辑）",
      type: "image",
      mode: ["singleImage", "multiReference"],
      defaultPrompt: "Replace costumes for the character",
    },
    {
      id: "qwen-image-edit-2511",
      label: "Qwen Image Edit 2511（抠图 / 人物场景）",
      type: "image",
      mode: ["singleImage", "multiReference"],
      defaultPrompt: "Remove the background and keep the main subject cleanly cut out",
    },
    {
      id: "krea2-character-sheet",
      label: "Krea2 角色四视图",
      type: "image",
      mode: ["singleImage"],
      defaultPrompt: "Convert the character in the image to a Character Sheet showing a face close-up, front full body, side full body and back full body views",
    },
    {
      id: "minimax-h3",
      label: "MiniMax H3（参考图生视频）",
      type: "video",
      mode: [["imageReference:9", "audioReference:3"]],
      audio: true,
      durationResolutionMap: [{ duration: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["0.2MP", "0.4MP", "1MP"] }],
    },
  ] satisfies ProviderModel[],
  async generateImage(this: Context, request: ImageRequest): Promise<MediaAsset[]> {
    const baseUrl = resolveBaseUrl(this.config.serverUrl);
    if (request.model === "qwen-image-2.1" && !request.prompt.trim()) throw new Error("请输入生成提示词");
    // ACT: 合并外部取消与总超时；ComfyUI 任务本身不会随请求取消，仅停止轮询。
    const signal = AbortSignal.any([AbortSignal.timeout(imageTimeout), ...(this.signal ? [this.signal] : [])]);
    if (request.model === "qwen-image-2.1-edit") {
      const images = request.images ?? [];
      if (!images.length) throw new Error("请至少添加 1 张参考图");
      if (images.length > 8) throw new Error("图片编辑最多支持 8 张参考图");
      const imageNames: string[] = [];
      for (let index = 0; index < images.length; index += 1) {
        imageNames.push(await uploadFile(this, baseUrl, images[index], `toonflow-edit-${index}`, signal));
      }
      const promptId = await submitWorkflow(this, baseUrl, createEditImageWorkflow(request, imageNames), signal);
      const files = await waitForOutputs(this, baseUrl, promptId, signal);
      return files.map(file => ({ mediaType: "image" as const, type: "url" as const, url: viewUrl(baseUrl, file), mimeType: "image/png" }));
    }
    if (request.model === "qwen-image-edit-2511") {
      const images = request.images ?? [];
      if (!images.length) throw new Error("请至少添加 1 张参考图");
      if (images.length > 2) throw new Error("Qwen Image Edit 2511 最多支持 2 张参考图");
      const imageNames: string[] = [];
      for (let index = 0; index < images.length; index += 1) {
        imageNames.push(await uploadFile(this, baseUrl, images[index], `toonflow-edit-2511-${index}`, signal));
      }
      const promptId = await submitWorkflow(this, baseUrl, createEditImage2511Workflow(request, imageNames), signal);
      const files = await waitForOutputs(this, baseUrl, promptId, signal);
      return files.map(file => ({ mediaType: "image" as const, type: "url" as const, url: viewUrl(baseUrl, file), mimeType: "image/png" }));
    }
    if (request.model === "krea2-character-sheet") {
      const images = request.images ?? [];
      if (!images.length) throw new Error("请添加 1 张角色参考图");
      if (images.length > 1) throw new Error("角色四视图只支持 1 张参考图");
      const imageName = await uploadFile(this, baseUrl, images[0], "toonflow-character-sheet", signal);
      const promptId = await submitWorkflow(this, baseUrl, createCharacterSheetWorkflow(request, imageName), signal);
      const files = await waitForOutputs(this, baseUrl, promptId, signal);
      return files.map(file => ({ mediaType: "image" as const, type: "url" as const, url: viewUrl(baseUrl, file), mimeType: "image/png" }));
    }
    const promptId = await submitWorkflow(this, baseUrl, createImageWorkflow(request), signal);
    const files = await waitForOutputs(this, baseUrl, promptId, signal);
    return files.map(file => ({ mediaType: "image" as const, type: "url" as const, url: viewUrl(baseUrl, file), mimeType: "image/png" }));
  },
  async generateVideo(this: Context, request: VideoRequest): Promise<MediaAsset[]> {
    const baseUrl = resolveBaseUrl(this.config.serverUrl);
    if (!request.prompt.trim()) throw new Error("请输入生成提示词");
    const images = request.images ?? [];
    const audios = request.audios ?? [];
    if (!images.length) throw new Error("请至少添加 1 张参考图");
    if (images.length > videoImageSlots.length) throw new Error(`最多支持 ${videoImageSlots.length} 张参考图`);
    if (audios.length > videoAudioSlots.length) throw new Error(`最多支持 ${videoAudioSlots.length} 段参考音频`);
    const signal = AbortSignal.any([AbortSignal.timeout(videoTimeout), ...(this.signal ? [this.signal] : [])]);
    const imageNames: string[] = [];
    for (let index = 0; index < images.length; index += 1) {
      imageNames.push(await uploadFile(this, baseUrl, images[index], `toonflow-image-${index}`, signal));
    }
    const audioNames: string[] = [];
    for (let index = 0; index < audios.length; index += 1) {
      audioNames.push(await uploadFile(this, baseUrl, audios[index], `toonflow-audio-${index}`, signal));
    }
    const promptId = await submitWorkflow(this, baseUrl, createVideoWorkflow(request, imageNames, audioNames), signal);
    const files = await waitForOutputs(this, baseUrl, promptId, signal);
    return files.map(file => ({ mediaType: "video" as const, type: "url" as const, url: viewUrl(baseUrl, file), mimeType: "video/mp4" }));
  },
} satisfies ProviderDefinition<typeof rules>;
