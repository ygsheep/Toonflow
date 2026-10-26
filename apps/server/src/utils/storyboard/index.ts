import { lstat, mkdir, readFile, readdir, unlink } from "@toonflow/file";
import { basename, extname, join } from "node:path";
import { lockWorkspaceFiles, renameWorkspaceFile, resolveWorkspacePath } from "@/utils/workspace/files";
import { getStatus } from "@/utils/ffmpeg";
import { reviewSegment, type StoryboardIssue } from "./review";

const storyboardDirectory = "分镜表";
const assetDirectory = "资产";
// ACT: 逐镜关键帧只是分镜页的预览图，从段视频抽帧后放在 生成/关键帧/<段>/，不进入资产库。
const keyframeDirectory = "生成/关键帧";
const videoDirectory = "生成";
const pendingDirectory = "生成/待归位";
const promptDirectory = "提示词";
const segmentNamePattern = /^第([\d.]+)段_导出$/;
const videoExtensions = new Set([".mp4", ".mov", ".webm", ".mkv", ".m4v"]);
const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const assetManifest = "assets.json";

export type StoryboardShot = {
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
  // ACT: 关键帧是从段视频抽出的预览图，独立于资产库中的素材图。
  frame: { name: string; path: string } | null;
};

export type StoryboardSegment = {
  id: string;
  number: string;
  shotCount: number;
  imageCount: number;
  frameCount: number;
  // ACT: 源文件相对路径与解析错误一起返回，面板才能把坏稿显示成“无法解析”而不是整段消失。
  source: string;
  parseError?: string;
  issues: StoryboardIssue[];
  orphanPrompts: string[];
  video: { name: string; path: string; exists: boolean };
  // ACT: 参考图来自 Seedance 提示词文件的「素材清单」，只做展示与对账，不参与资产看板统计。
  references: StoryboardReference[];
  prompt: StoryboardPrompt | null;
  prompts: StoryboardPromptSource[];
  shots: StoryboardShot[];
};

export type StoryboardReference = {
  label: string;
  name: string;
  type: string;
  note: string;
  usage: string;
  path: string | null;
};

export type StoryboardPrompt = {
  file: string;
  full: string;
  shots: { no: string; text: string }[];
};

// ACT: 同一段可能有多份提示词（Seedance / H3-ComfyUI），各自对应一版生成视频，画布按份分组展示。
export type StoryboardPromptSource = {
  file: string;
  title: string;
  text: string;
  references: StoryboardReference[];
  video: { name: string; path: string; exists: boolean } | null;
};

export type StoryboardSnapshot = {
  segments: StoryboardSegment[];
  pending: string[];
};

export type StoryboardAssetEntry = {
  id: string;
  name: string;
  type: string;
  file: string | null;
  // ACT: 一个主体可能对应多张素材图（如角色四视图 + 定妆照），看板按主体分支逐张展示。
  files: string[];
  refs: { segment: string; number: string; no: string }[];
  note: string;
  source: "storyboard" | "manifest";
};

export type StoryboardAssets = {
  assets: StoryboardAssetEntry[];
  unused: string[];
};

async function exists(path: string) {
  return lstat(path).then(entry => entry.isFile(), (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  });
}

async function listFiles(directory: string) {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
    throw error;
  });
  return entries.filter(entry => entry.isFile()).map(entry => entry.name);
}

// ACT: 资产按 PRD 分类存放在 资产/角色|场景|道具 子目录，返回相对 资产/ 的路径。
async function listFilesDeep(directory: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
    throw error;
  });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listFilesDeep(join(directory, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

async function listAssetImages(root: string) {
  const assetRoot = await resolveWorkspacePath(root, assetDirectory, true);
  return (await listFilesDeep(assetRoot.path))
    .filter(file => imageExtensions.has(extname(file).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }));
}

// ACT: assets.json 是资产清单（id/name/type/files/refs/note），缺失或损坏时回退为纯目录扫描。
async function readAssetManifest(root: string) {
  const text = await readFile(join(root, assetDirectory, assetManifest), "utf8").catch(() => null);
  if (!text) return [] as Record<string, unknown>[];
  try {
    const parsed = JSON.parse(text) as { assets?: unknown };
    return Array.isArray(parsed.assets)
      ? parsed.assets.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      : [];
  } catch {
    return [];
  }
}

function manifestRefs(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map(no => {
    const [segment = "", shot = ""] = no.split("-");
    return { segment, number: shot.replace(/^SH/, ""), no };
  });
}

function readText(value: unknown) {
  return typeof value === "string" ? value : "";
}

function safeName(value: string) {
  return value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_");
}

// ACT: 项目约定整数段号补两位（01.mp4 … 17.mp4），带小数的段号保持原样（18.5.mp4）。
function videoName(number: string) {
  return `${number.includes(".") ? number : number.padStart(2, "0")}.mp4`;
}

// ACT: 分镜表只提供视觉字段，图片提示词按固定顺序拼接；后续接入独立提示词文件时替换此处。
function composePrompt(shot: Record<string, unknown>) {
  return [
    ["视觉", readText(shot.visual)],
    ["动作", readText(shot.action)],
    ["服装", readText(shot.wardrobe)],
    ["道具", readText(shot.prop)],
    ["光线", readText(shot.light)],
    ["色彩", readText(shot.color)],
  ].filter(([, value]) => value).map(([label, value]) => `【${label}】${value}`).join("\n");
}

// ACT: 文件名里空格/下划线混用（清单写 女1_王嫣_四视图.png，磁盘是 女1 王嫣_四视图.png），匹配前统一去掉分隔符与 Markdown 转义。
function normalizeFileName(value: string) {
  return value.toLowerCase().replace(/[\s_\-\\]/g, "");
}

// ACT: 稿件里的 08\_云天娇\_53-54集.png 是 Markdown 转义写法，展示与匹配前先还原。
function unescapeMarkdown(value: string) {
  return value.replace(/\\(.)/g, "$1");
}

// ACT: 提示词归属按三道判据依次放宽：文件名含场景号 → 正文含本段任一镜号 → 目录内仅一份 md；命中后按 Seedance/H3 排序。
async function findPromptFiles(root: string, files: string[], scene: string, shotNos: string[]) {
  const candidates = files.filter(file => extname(file).toLowerCase() === ".md");
  if (!candidates.length) return [];
  const sceneKey = normalizeFileName(scene);
  const byName = candidates.filter(file => sceneKey && normalizeFileName(file).includes(sceneKey));
  // ACT: 文件名不带场景号的稿件（如 08_06b 前缀）靠正文里出现的镜号认领，不依赖命名约定；文件名已命中时不再逐个读正文。
  const byContent: string[] = [];
  if (!byName.length) {
    for (const file of candidates) {
      const text = await readFile(join(root, promptDirectory, file), "utf8").catch(() => "");
      if (text && shotNos.some(no => no && text.includes(no))) byContent.push(file);
    }
  }
  const matched = byName.length ? byName : byContent;
  const selected = matched.length ? matched : candidates.length === 1 ? candidates : [];
  // ACT: Seedance 为主提示词，H3/ComfyUI 次之；与 01.mp4、01_1.mp4 的顺序对应。
  const priority = (file: string) => /seedance/i.test(file) ? 0 : /h3|comfyui/i.test(file) ? 1 : 2;
  return [...selected].sort((a, b) => priority(a) - priority(b) || a.localeCompare(b, "zh-CN", { numeric: true }));
}

// ACT: 素材清单两种写法：Seedance 用 @人物1，H3 用 `<Subject 1>`；两列表也可用，缺列按空串补齐。
function parseReferences(text: string, assetByNorm: Map<string, string>, assetByBase: Map<string, string>) {
  return text.split(/\r?\n/)
    .filter(line => /^\|\s*`?[@<]/.test(line))
    .map(line => line.split("|").slice(1, -1).map(cell => cell.trim()))
    .filter(cells => cells.length >= 2 && imageExtensions.has(extname(cells[1]!).toLowerCase()))
    .map(([label = "", name = "", type = "", note = "", usage = ""]) => ({
      label: label.replace(/`/g, ""),
      name: unescapeMarkdown(name),
      type,
      note,
      usage,
      path: resolveReference(name, assetByNorm, assetByBase),
    }));
}

// ACT: 生成目录里属于本段的视频：01.mp4、01_1.mp4…按自然序，与提示词顺序一一对应。
function segmentVideos(files: string[], number: string) {
  const prefix = number.includes(".") ? number : number.padStart(2, "0");
  const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([_-].*)?$`);
  return files
    .filter(file => videoExtensions.has(extname(file).toLowerCase()))
    .filter(file => pattern.test(basename(file, extname(file))))
    // ACT: 01.mp4 是第一版，01_1.mp4 是第二版；localeCompare 会把 01_1 排到 01 前面，这里按后缀数字排序。
    .sort((a, b) => {
      const rank = (file: string) => {
        const base = basename(file, extname(file));
        if (base === prefix) return 0;
        const rest = base.slice(prefix.length).replace(/^[_-]/, "");
        const value = Number(rest);
        return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
      };
      return rank(a) - rank(b) || a.localeCompare(b);
    });
}

// ACT: 一份稿件常按【风格】【主体描述】【时间轴】分段写多个代码块，取含【时间轴】且最长的那块作为正文，避免被【风格】块抢先。
function pickPromptBody(text: string) {
  const blocks = [...text.matchAll(/```(?:text|md|markdown)?[^\n]*\r?\n([\s\S]*?)```/gi)].map(match => match[1]!.trim()).filter(Boolean);
  const timelines = blocks.filter(block => block.includes("【时间轴】"));
  return (timelines.length ? timelines : blocks).sort((a, b) => b.length - a.length)[0] ?? "";
}

// ACT: 解析提示词正文；只解析代码块内容，代码块外的素材清单给人看，不进正文。
function parsePromptSource(text: string, assetByNorm: Map<string, string>, assetByBase: Map<string, string>) {
  const full = pickPromptBody(text);
  if (!full || !full.includes("【时间轴】")) return null;
  const timeline = /【时间轴】([\s\S]*?)(?=\n【|$)/.exec(full)?.[1] ?? "";
  const blocks = new Map<number, string>();
  for (const part of timeline.split(/(?=^\[镜\d+\])/m).map(item => item.trim()).filter(Boolean)) {
    const matched = /^\[镜(\d+)\]\s*([^\n]*)\r?\n?([\s\S]*)$/.exec(part);
    if (!matched) continue;
    blocks.set(Number(matched[1]), [`[镜${matched[1]}] ${matched[2].trim()}`.trim(), matched[3].trim()].filter(Boolean).join("\n"));
  }
  // ACT: 两列素材表（占位 + 文件名）同样可用，非图片行（如音色 mp3）只保留文件名、不给路径。
  const references = text.split(/\r?\n/)
    .filter(line => /^\|\s*`?[@<]/.test(line))
    .map(line => line.split("|").slice(1, -1).map(cell => cell.trim()))
    .filter(cells => cells.length >= 2)
    .map(([label = "", name = "", type = "", note = "", usage = ""]) => ({
      label: label.replace(/`/g, ""),
      name: unescapeMarkdown(name),
      type,
      note,
      usage,
      path: imageExtensions.has(extname(unescapeMarkdown(name)).toLowerCase()) ? resolveReference(name, assetByNorm, assetByBase) : null,
    }));
  return { full, blocks, blocksList: [...blocks.keys()], references };
}

// ACT: 资产名匹配带四级回退：去掉目录前缀后按原名、去扩展名、去数字前缀（稿件写 08_ 前缀、资产库没有）逐级尝试。
function findAsset(name: string, assetByNorm: Map<string, string>, assetByBase: Map<string, string>) {
  const fileName = unescapeMarkdown(name).split(/[/\\]/).pop() ?? "";
  const full = normalizeFileName(fileName);
  const base = full.replace(/\.[^.]+$/, "");
  for (const key of [full, base, full.replace(/^\d+/, ""), base.replace(/^\d+/, "")]) {
    if (!key) continue;
    const file = assetByNorm.get(key) ?? assetByBase.get(key);
    if (file) return file;
  }
  return null;
}

function resolveReference(name: string, assetByNorm: Map<string, string>, assetByBase: Map<string, string>) {
  const file = findAsset(name, assetByNorm, assetByBase);
  return file ? `${assetDirectory}/${file}` : null;
}

// ACT: 坏稿也要出现在分段列表里，只解析失败的分段带一条 p0 问题，其余字段留空。
function failedSegment(folder: string, number: string, source: string, message: string): StoryboardSegment {
  return {
    id: folder,
    number,
    shotCount: 0,
    imageCount: 0,
    frameCount: 0,
    source,
    parseError: message,
    issues: [{
      id: `${folder}|parse-error|-|文件|${source}`,
      code: "parse-error",
      shotNo: "",
      field: "文件",
      severity: "p0",
      source: "auto",
      desc: message,
      fix: "检查 JSON 语法与 shots 数组，修正后重新导出",
    }],
    orphanPrompts: [],
    video: { name: videoName(number), path: `${videoDirectory}/${videoName(number)}`, exists: false },
    references: [],
    prompt: null,
    prompts: [],
    shots: [],
  };
}

async function readSegment(root: string, folder: string, number: string, assets: Map<string, string>, assetByNorm: Map<string, string>, assetByBase: Map<string, string>, promptFileList: string[], videoFiles: string[]): Promise<StoryboardSegment | null> {
  const source = join(root, storyboardDirectory, folder, "分镜脚本.json");
  const text = await readFile(source, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (text === null) return null;
  const relativeSource = `${storyboardDirectory}/${folder}/分镜脚本.json`;
  let parsed: { shots?: unknown } | null;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return failedSegment(folder, number, relativeSource, `JSON 解析失败：${error instanceof Error ? error.message : "格式错误"}`);
  }
  if (!parsed || typeof parsed !== "object") return failedSegment(folder, number, relativeSource, "文件内容不是对象");
  if (!Array.isArray(parsed.shots)) return failedSegment(folder, number, relativeSource, "缺少 shots 数组");
  const shots = parsed.shots as Record<string, unknown>[];
  const scene = /^SC\d+/.exec(readText(shots[0]?.no))?.[0] ?? "";
  const matchedPromptFiles = await findPromptFiles(root, promptFileList, scene, shots.map(shot => readText(shot.no)));
  const promptFile = matchedPromptFiles[0] ?? null;
  const promptText = promptFile ? await readFile(join(root, promptDirectory, promptFile), "utf8").catch(() => null) : null;
  const parsedPrompt = promptText ? parsePromptSource(promptText, assetByNorm, assetByBase) : null;
  const videos = segmentVideos(videoFiles, number);
  const prompts: StoryboardPromptSource[] = await Promise.all(matchedPromptFiles.map(async (file, index) => {
    const raw = await readFile(join(root, promptDirectory, file), "utf8").catch(() => "");
    const body = pickPromptBody(raw);
    const matched = videos[index];
    return {
      file: `${promptDirectory}/${file}`,
      title: basename(file, extname(file)),
      text: body || raw.trim(),
      references: parseReferences(raw, assetByNorm, assetByBase),
      video: matched ? { name: matched, path: `${videoDirectory}/${matched}`, exists: true } : null,
    };
  }));
  const name = videos[0] ?? videoName(number);
  const videoPath = join(root, videoDirectory, name);
  const frameRoot = await resolveWorkspacePath(root, `${keyframeDirectory}/${folder}`, true);
  const frameFiles = new Set(await listFiles(frameRoot.path));
  const prompt = parsedPrompt && promptFile
    ? {
      file: `${promptDirectory}/${promptFile}`,
      full: parsedPrompt.full,
      shots: shots.map((shot, index) => ({ no: readText(shot.no), text: parsedPrompt.blocks.get(index + 1) ?? "" })),
    }
    : null;
  const segment: StoryboardSegment = {
    id: folder,
    number,
    shotCount: shots.length,
    imageCount: 0,
    frameCount: 0,
    source: relativeSource,
    issues: [],
    orphanPrompts: [],
    video: { name, path: `${videoDirectory}/${name}`, exists: await exists(videoPath) },
    references: parsedPrompt?.references.map(item => ({ ...item, path: resolveReference(item.name, assetByNorm, assetByBase) })) ?? [],
    prompt,
    prompts,
    shots: shots.map(shot => {
      const asset = readText(shot.asset);
      // ACT: asset 先按“文件名去扩展名”精确匹配，再按归一化名兜底（分镜表写 女1_王嫣、资产文件叫 女1 王嫣.png）。
      const imageFile = asset ? assets.get(asset.toLowerCase()) ?? findAsset(asset, assetByNorm, assetByBase) : undefined;
      const image = imageFile ? { name: basename(imageFile), path: `${assetDirectory}/${imageFile}` } : null;
      const frameName = `${safeName(asset)}.png`;
      const frame = asset && frameFiles.has(frameName) ? { name: frameName, path: `${keyframeDirectory}/${folder}/${frameName}` } : null;
      return {
        no: readText(shot.no),
        scene: readText(shot.scene),
        size: readText(shot.size),
        angle: readText(shot.angle),
        pos: readText(shot.pos),
        move: readText(shot.move),
        lens: readText(shot.lens),
        dur: readText(shot.dur),
        visual: readText(shot.visual),
        action: readText(shot.action),
        line: readText(shot.line),
        sfx: readText(shot.sfx),
        trans: readText(shot.trans),
        light: readText(shot.light),
        color: readText(shot.color),
        prop: readText(shot.prop),
        wardrobe: readText(shot.wardrobe),
        vfx: readText(shot.vfx),
        beat: readText(shot.beat),
        risk: readText(shot.risk),
        asset,
        prompt: composePrompt(shot),
        image,
        frame,
      };
    }),
  };
  segment.imageCount = segment.shots.filter(shot => shot.image).length;
  segment.frameCount = segment.shots.filter(shot => shot.frame).length;
  const review = reviewSegment({
    segmentId: folder,
    shots: segment.shots,
    prompt: prompt && parsedPrompt ? { ...prompt, blocks: parsedPrompt.blocksList } : null,
    references: segment.references,
  });
  segment.issues = review.issues;
  segment.orphanPrompts = review.orphanPrompts;
  return segment;
}

// ACT: 逐镜关键帧从段视频按镜时长中点截取；帧比视频新则跳过，视频替换后自动重抽。
const extracting = new Set<string>();
const keyframeFailures = new Set<string>();
let ffmpegBinary: string | null = null;
let ffmpegLookup: Promise<string | null> | null = null;
let ffmpegRetryAt = 0;

// ACT: 未安装 FFmpeg 时静默跳过抽帧，30 秒后再查一次，避免每次扫描都探测工具链。
async function resolveFfmpeg() {
  if (ffmpegBinary) return ffmpegBinary;
  if (Date.now() < ffmpegRetryAt) return null;
  ffmpegLookup ??= getStatus().then(({ tools }) => {
    if (tools.ffmpeg.error || !tools.ffmpeg.path) {
      ffmpegRetryAt = Date.now() + 30000;
      return null;
    }
    ffmpegBinary = tools.ffmpeg.path;
    return ffmpegBinary;
  }).catch(() => {
    ffmpegRetryAt = Date.now() + 30000;
    return null;
  }).finally(() => { ffmpegLookup = null; });
  return ffmpegLookup;
}

async function captureFrame(binary: string, video: string, at: number, target: string) {
  const child = Bun.spawn([binary, "-y", "-loglevel", "error", "-ss", at.toFixed(3), "-i", video, "-frames:v", "1", "-q:v", "2", target], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    windowsHide: true,
  });
  const [message, code] = await Promise.all([child.stderr.text(), child.exited]);
  if (code === 0) return true;
  const frame = await lstat(target).catch(() => null);
  if (frame?.isFile() && frame.size === 0) await unlink(target).catch(() => undefined);
  console.warn(`关键帧截取失败（${code}）：${message.trim() || "ffmpeg 未输出错误信息"}`);
  return false;
}

async function extractKeyframes(root: string, segment: StoryboardSegment) {
  if (!segment.video.exists) return;
  const shots = segment.shots.filter(shot => shot.asset);
  if (!shots.length) return;
  const guard = `${root}|${segment.id}`;
  if (extracting.has(guard)) return;
  const video = join(root, segment.video.path);
  const info = await lstat(video).catch(() => null);
  if (!info?.isFile()) return;
  if (keyframeFailures.has(`${video}|${info.mtimeMs}`)) return;
  const binary = await resolveFfmpeg();
  if (!binary) return;

  extracting.add(guard);
  try {
    const directory = join(root, keyframeDirectory, segment.id);
    let start = 0;
    let failed = false;
    for (const shot of shots) {
      const duration = Number.parseFloat(shot.dur);
      const length = Number.isFinite(duration) && duration > 0 ? duration : 0;
      const at = start + length / 2;
      start += length;
      const target = join(directory, `${safeName(shot.asset)}.png`);
      const frame = await lstat(target).catch(() => null);
      if (frame?.isFile() && frame.size > 0 && frame.mtimeMs >= info.mtimeMs) continue;
      await mkdir(directory, { recursive: true });
      if (!(await captureFrame(binary, video, at, target))) failed = true;
    }
    if (failed) keyframeFailures.add(`${video}|${info.mtimeMs}`);
  } finally {
    extracting.delete(guard);
  }
}

export async function scanStoryboard(root: string): Promise<StoryboardSnapshot> {
  const storyboardRoot = await resolveWorkspacePath(root, storyboardDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  });
  // ACT: 项目可能只有 资产/ 还没有 分镜表/，缺目录时按没有分段处理而不是报 ENOENT。
  const folders = storyboardRoot === null ? [] : await readdir(storyboardRoot.path, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
    throw error;
  });
  const assetRoot = await resolveWorkspacePath(root, assetDirectory, true);
  const assetFiles = (await listFilesDeep(assetRoot.path)).filter(file => imageExtensions.has(extname(file).toLowerCase()));
  const assets = new Map(assetFiles.map(file => [basename(file, extname(file)).toLowerCase(), file]));
  const assetByNorm = new Map(assetFiles.map(file => [normalizeFileName(basename(file)), file]));
  // ACT: 去掉扩展名的归一化索引，供分镜表的 asset 字段与稿件素材清单回退匹配。
  const assetByBase = new Map(assetFiles.map(file => [normalizeFileName(basename(file, extname(file))), file]));
  const promptRoot = await resolveWorkspacePath(root, promptDirectory, true);
  const promptFiles = await listFilesDeep(promptRoot.path);
  const videoFiles = await listFiles((await resolveWorkspacePath(root, videoDirectory, true)).path);
  const discovered = folders.flatMap(entry => {
    const matched = entry.isDirectory() ? segmentNamePattern.exec(entry.name) : null;
    return matched ? [{ folder: entry.name, number: matched[1] }] : [];
  }).sort((a, b) => Number(a.number) - Number(b.number));
  const segments = await Promise.all(discovered.map(item => readSegment(root, item.folder, item.number, assets, assetByNorm, assetByBase, promptFiles, videoFiles)));
  const pending = (await listFiles((await resolveWorkspacePath(root, pendingDirectory, true)).path))
    .filter(name => videoExtensions.has(extname(name).toLowerCase()));
  const snapshot: StoryboardSnapshot = { segments: segments.filter((segment): segment is StoryboardSegment => segment !== null), pending };
  for (const segment of snapshot.segments) {
    void extractKeyframes(root, segment).catch(error => console.warn("关键帧抽帧失败：", error));
  }
  return snapshot;
}

// ACT: 资产看板合并两个来源：分镜的 asset 字段 + 资产/assets.json 清单；图片按相对路径递归匹配。
export async function scanStoryboardAssets(root: string): Promise<StoryboardAssets> {
  const { segments } = await scanStoryboard(root);
  const files = await listAssetImages(root);
  const fileSet = new Set(files);
  const entries = new Map<string, StoryboardAssetEntry>();
  const referenced = new Set<string>();

  for (const segment of segments) {
    for (const shot of segment.shots) {
      // ACT: 只有 资产/ 中真实存在的图片才算资产条目；关键帧预览不进资产看板。
      if (!shot.asset || !shot.image) continue;
      const key = shot.asset.toLowerCase();
      const entry = entries.get(key) ?? { id: shot.asset, name: "", type: "", file: null, files: [], refs: [], note: "", source: "storyboard" as const };
      const relative = shot.image.path.startsWith(`${assetDirectory}/`) ? shot.image.path.slice(assetDirectory.length + 1) : null;
      if (relative) {
        entry.file = relative;
        if (!entry.files.includes(relative)) entry.files.push(relative);
        referenced.add(relative);
      }
      entry.refs.push({ segment: segment.id, number: segment.number, no: shot.no });
      entries.set(key, entry);
    }
  }

  for (const item of await readAssetManifest(root)) {
    const id = readText(item.id) || readText(item.name);
    if (!id) continue;
    const declared = (Array.isArray(item.files) ? item.files : []).filter((file): file is string => typeof file === "string" && file.trim() !== "");
    const existing = declared.filter(file => fileSet.has(file));
    existing.forEach(file => referenced.add(file));
    const key = id.toLowerCase();
    const entry = entries.get(key);
    if (entry) {
      entry.name ||= readText(item.name);
      entry.type ||= readText(item.type);
      entry.note ||= readText(item.note);
      for (const file of existing) if (!entry.files.includes(file)) entry.files.push(file);
      entry.file ??= existing[0] ?? null;
      continue;
    }
    const baseFile = files.find(file => basename(file, extname(file)).toLowerCase() === key);
    if (baseFile) referenced.add(baseFile);
    const own = [...new Set([...existing, ...(baseFile ? [baseFile] : [])])];
    entries.set(key, {
      id,
      name: readText(item.name),
      type: readText(item.type),
      file: own[0] ?? null,
      files: own,
      refs: manifestRefs(item.refs),
      note: readText(item.note),
      source: "manifest",
    });
  }

  return {
    assets: [...entries.values()].sort((a, b) => a.id.localeCompare(b.id, "zh-CN", { numeric: true })),
    unused: files.filter(file => !referenced.has(file)),
  };
}

// ACT: 外部生成器边写边放入待归位；连续两次扫描大小与时间不变才归位，避免改名半截文件。
type PendingFile = { size: number; mtime: number };
const watched = new Map<string, Map<string, PendingFile>>();
let watching = false;

// ACT: 资产目录变化经 SSE 推给页面；轮询留在服务端，Windows 与网络盘都可靠。
type AssetWatcher = { listeners: Set<() => void>; signature: string | null };
const assetWatchers = new Map<string, AssetWatcher>();

export function onStoryboardAssetsChange(root: string, listener: () => void) {
  const watcher = assetWatchers.get(root) ?? { listeners: new Set<() => void>(), signature: null };
  watcher.listeners.add(listener);
  assetWatchers.set(root, watcher);
  return () => {
    watcher.listeners.delete(listener);
    if (!watcher.listeners.size) assetWatchers.delete(root);
  };
}

// ACT: 文件名 + 大小 + 修改时间足以识别新增、删除与改图；待归位里的视频也算变化来源。
async function assetSignature(root: string) {
  const assetRoot = await resolveWorkspacePath(root, assetDirectory, true);
  const files = await listFilesDeep(assetRoot.path);
  const parts: string[] = [];
  for (const file of files) {
    const info = await lstat(join(assetRoot.path, file)).catch(() => null);
    parts.push(info?.isFile() ? `${file}:${info.size}:${Math.round(info.mtimeMs)}` : `${file}:0`);
  }
  const pendingRoot = await resolveWorkspacePath(root, pendingDirectory, true);
  const pending = (await listFiles(pendingRoot.path)).sort();
  return `${parts.join("|")}##${pending.join("|")}`;
}

async function pollAssets(root: string) {
  const watcher = assetWatchers.get(root);
  if (!watcher) return;
  const signature = await assetSignature(root);
  if (watcher.signature === signature) return;
  const baseline = watcher.signature === null;
  watcher.signature = signature;
  // ACT: 首轮只记录基线，避免页面刚连上就误报一次变更。
  if (baseline) return;
  for (const listener of watcher.listeners) {
    try { listener(); } catch (error) { console.warn("资产变更通知失败：", error); }
  }
}

export function watchStoryboard(root: string) {
  if (watched.has(root)) return;
  watched.set(root, new Map());
  void mkdir(join(root, pendingDirectory), { recursive: true }).catch(error => console.warn("创建待归位目录失败：", error));
  if (watching) return;
  watching = true;
  // ACT: 2 秒轮询代替文件监听，Windows 与网络盘均可靠；工作区数量很少时开销可忽略。
  setInterval(() => {
    for (const directory of watched.keys()) {
      settlePending(directory).catch(error => console.warn("分镜视频归位失败：", error));
      void pollAssets(directory).catch(error => console.warn("资产目录监听失败：", error));
    }
  }, 2000).unref();
}

async function settlePending(root: string) {
  const seen = watched.get(root);
  if (!seen) return;
  const pendingRoot = join(root, pendingDirectory);
  const names = (await listFiles(pendingRoot)).filter(name => videoExtensions.has(extname(name).toLowerCase()));
  for (const name of names) {
    const path = join(pendingRoot, name);
    const info = await lstat(path).catch(() => null);
    if (!info?.isFile()) continue;
    const last = seen.get(name);
    seen.set(name, { size: info.size, mtime: info.mtimeMs });
    if (!last || last.size !== info.size || last.mtime !== info.mtimeMs) continue;
    const target = await nextMissingTarget(root);
    if (!target) continue;
    const release = lockWorkspaceFiles([path, target.path]);
    try {
      await renameWorkspaceFile(path, target.path);
      seen.delete(name);
      console.log(`分镜视频已归位：${name} -> ${target.path}`);
    } finally {
      release();
    }
  }
  for (const name of seen.keys()) if (!names.includes(name)) seen.delete(name);
}

async function nextMissingTarget(root: string) {
  const storyboardRoot = await resolveWorkspacePath(root, storyboardDirectory);
  const folders = await readdir(storyboardRoot.path, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
    throw error;
  });
  const numbers = folders.flatMap(entry => {
    const matched = entry.isDirectory() ? segmentNamePattern.exec(entry.name) : null;
    return matched ? [matched[1]] : [];
  }).sort((a, b) => Number(a) - Number(b));
  for (const number of numbers) {
    const path = join(root, videoDirectory, videoName(number));
    if (!(await exists(path))) {
      await mkdir(join(root, videoDirectory), { recursive: true });
      return { number, path };
    }
  }
  return null;
}
