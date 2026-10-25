import { lstat, mkdir, readFile, readdir, unlink } from "@toonflow/file";
import { basename, extname, join } from "node:path";
import { lockWorkspaceFiles, renameWorkspaceFile, resolveWorkspacePath } from "@/utils/workspace/files";
import { getStatus } from "@/utils/ffmpeg";

const storyboardDirectory = "分镜表";
const assetDirectory = "资产";
// ACT: 逐镜关键帧由 ffmpeg 从段视频自动截取，放在 资产/关键帧/<段>/<素材编号>.png。
const keyframeDirectory = "关键帧";
const videoDirectory = "生成";
const pendingDirectory = "生成/待归位";
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
};

export type StoryboardSegment = {
  id: string;
  number: string;
  shotCount: number;
  imageCount: number;
  video: { name: string; path: string; exists: boolean };
  shots: StoryboardShot[];
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

async function readSegment(root: string, folder: string, number: string, assets: Map<string, string>, fileSet: Set<string>): Promise<StoryboardSegment | null> {
  const source = join(root, storyboardDirectory, folder, "分镜脚本.json");
  const text = await readFile(source, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (text === null) return null;
  let parsed: { shots?: unknown } | null;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed) return null;
  const shots = Array.isArray(parsed.shots) ? parsed.shots as Record<string, unknown>[] : [];
  const name = videoName(number);
  const videoPath = join(root, videoDirectory, name);
  const segment: StoryboardSegment = {
    id: folder,
    number,
    shotCount: shots.length,
    imageCount: 0,
    video: { name, path: `${videoDirectory}/${name}`, exists: await exists(videoPath) },
    shots: shots.map(shot => {
      const asset = readText(shot.asset);
      const keyframe = `${keyframeDirectory}/${folder}/${safeName(asset)}.png`;
      const imageFile = asset ? (fileSet.has(keyframe) ? keyframe : assets.get(asset.toLowerCase())) : undefined;
      const image = imageFile ? { name: basename(imageFile), path: `${assetDirectory}/${imageFile}` } : null;
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
      };
    }),
  };
  segment.imageCount = segment.shots.filter(shot => shot.image).length;
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
    const directory = join(root, assetDirectory, keyframeDirectory, segment.id);
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
  const fileSet = new Set(assetFiles);
  const discovered = folders.flatMap(entry => {
    const matched = entry.isDirectory() ? segmentNamePattern.exec(entry.name) : null;
    return matched ? [{ folder: entry.name, number: matched[1] }] : [];
  }).sort((a, b) => Number(a.number) - Number(b.number));
  const segments = await Promise.all(discovered.map(item => readSegment(root, item.folder, item.number, assets, fileSet)));
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
      if (!shot.asset) continue;
      const key = shot.asset.toLowerCase();
      const entry = entries.get(key) ?? { id: shot.asset, name: "", type: "", file: null, refs: [], note: "", source: "storyboard" as const };
      const relative = shot.image ? shot.image.path.slice(assetDirectory.length + 1) : null;
      if (relative) {
        entry.file = relative;
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
      entry.file ??= existing[0] ?? null;
      continue;
    }
    const baseFile = files.find(file => basename(file, extname(file)).toLowerCase() === key);
    if (baseFile) referenced.add(baseFile);
    entries.set(key, {
      id,
      name: readText(item.name),
      type: readText(item.type),
      file: existing[0] ?? baseFile ?? null,
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

export function watchStoryboard(root: string) {
  if (watched.has(root)) return;
  watched.set(root, new Map());
  void mkdir(join(root, pendingDirectory), { recursive: true }).catch(error => console.warn("创建待归位目录失败：", error));
  if (watching) return;
  watching = true;
  // ACT: 2 秒轮询代替文件监听，Windows 与网络盘均可靠；工作区数量很少时开销可忽略。
  setInterval(() => {
    for (const directory of watched.keys()) settlePending(directory).catch(error => console.warn("分镜视频归位失败：", error));
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
