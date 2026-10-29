import { existsSync, statSync } from "@toonflow/file";
import { isAbsolute, join, resolve } from "node:path";
import conf from "@/utils/conf";

export type ComfyuiLocalStatus = {
  status: "stopped" | "starting" | "running" | "error";
  message: string;
  pid?: number;
  external: boolean;
  configured: boolean;
};

type ProcessState = Omit<ComfyuiLocalStatus, "configured" | "pid">;

const startTimeout = 180000;
const logLimit = 4000;

let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
let outputTail = "";
let state: ProcessState = { status: "stopped", message: "ComfyUI 未运行", external: false };
let queue: Promise<unknown> = Promise.resolve();

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readConfig() {
  const local = record(record(conf.get("settings", {})).comfyuiLocal);
  return {
    directory: typeof local.directory === "string" ? local.directory.trim() : "",
    python: typeof local.python === "string" ? local.python.trim() : "",
    autoStart: local.autoStart !== false,
  };
}

function serverTarget() {
  const configs = record(record(conf.get("settings", {})).mediaProviderConfigs);
  const value = record(configs.comfyui).serverUrl;
  let url: URL;
  try {
    url = new URL(typeof value === "string" && value.trim() ? value.trim() : "http://127.0.0.1:8188");
  } catch {
    url = new URL("http://127.0.0.1:8188");
  }
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  // ACT: 本地启动只监听回环地址；媒体模型配置成局域网地址时视为远端服务，不接管启动。
  const host = loopback ? "127.0.0.1" : url.hostname;
  return { origin: url.origin, host, port, local: loopback };
}

function localError(message: string) {
  return Object.assign(new Error(message), { status: 400 });
}

function findPythonIn(root: string) {
  for (const relative of process.platform === "win32" ? ["python.exe", "Scripts/python.exe"] : ["bin/python3", "bin/python"]) {
    const candidate = join(root, relative);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function resolvePython(value: string, directory: string) {
  // ACT: 留空时优先使用 ComfyUI 目录同级的 python / python_embeded（Windows 整合包），再交给 PATH。
  if (!value || !isAbsolute(value)) {
    const sibling = ["python", "python_embeded"]
      .map(name => findPythonIn(resolve(directory, "..", name)))
      .find(Boolean);
    return sibling ?? (value || "python");
  }
  if (!existsSync(value)) throw localError(`Python 环境不存在：${value}`);
  if (statSync(value).isFile()) return value;
  const inside = findPythonIn(value);
  if (inside) return inside;
  // ACT: 用户把 ComfyUI 目录填进 Python 环境时，回退到同级解释器目录，避免把目录当可执行文件。
  for (const name of ["python", "python_embeded"]) {
    const sibling = findPythonIn(resolve(value, "..", name));
    if (sibling) return sibling;
  }
  throw localError(`未在 ${value} 找到 Python 解释器，请选择虚拟环境目录或直接填写 python.exe 路径`);
}

function configuredPaths() {
  const config = readConfig();
  if (!config.directory) throw localError("请先在设置中填写 ComfyUI 目录");
  if (!isAbsolute(config.directory)) throw localError("ComfyUI 目录必须是绝对路径");
  const directory = resolve(config.directory);
  if (!existsSync(join(directory, "main.py"))) throw localError("ComfyUI 目录中未找到 main.py，请选择正确的安装目录");
  return { directory, python: resolvePython(config.python, directory) };
}

async function healthy() {
  try {
    const response = await fetch(`${serverTarget().origin}/system_stats`, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

function snapshot(): ComfyuiLocalStatus {
  return {
    ...state,
    configured: readConfig().directory !== "",
    pid: child && child.exitCode === null ? child.pid : undefined,
  };
}

function lastLine() {
  return outputTail.split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1) ?? "";
}

function drain(stream: ReadableStream<Uint8Array> | undefined) {
  if (!stream) return;
  void (async () => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        outputTail = (outputTail + decoder.decode(value, { stream: true })).slice(-logLimit);
      }
    } catch {
      // ACT: 进程退出时流可能已关闭，输出仅用于展示失败原因。
    }
  })();
}

function sleep(ms: number) {
  return new Promise<void>(resolvePromise => setTimeout(resolvePromise, ms));
}

function runExclusive<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task, task);
  queue = result.then(() => undefined, () => undefined);
  return result;
}

async function waitForRunning(proc: Bun.Subprocess<"ignore", "pipe", "pipe">) {
  const deadline = Date.now() + startTimeout;
  while (Date.now() < deadline) {
    if (child !== proc || proc.exitCode !== null) return;
    if (await healthy()) {
      if (child !== proc) return;
      state = { status: "running", message: "ComfyUI 运行中", external: false };
      return;
    }
    await sleep(1000);
  }
  if (child === proc) state = { status: "error", message: "ComfyUI 启动超时，请检查 ComfyUI 控制台输出", external: false };
}

async function startInternal() {
  if (await healthy()) {
    const external = !(child && child.exitCode === null);
    state = { status: "running", message: external ? "检测到已在运行的 ComfyUI" : "ComfyUI 运行中", external };
    return snapshot();
  }
  if (child && child.exitCode === null) return snapshot();

  const { directory, python } = configuredPaths();
  const target = serverTarget();
  if (!target.local) throw localError("媒体模型中的 ComfyUI 服务地址不是本机地址，无法启动本地 ComfyUI");
  outputTail = "";
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    env.PYTHONUNBUFFERED = "1";
    // ACT: 整合包依赖装在自带 python 内，禁用用户 site-packages，避免同名包版本冲突（如 av）。
    env.PYTHONNOUSERSITE = "1";
    proc = Bun.spawn([python, join(directory, "main.py"), "--listen", target.host, "--port", String(target.port), "--enable-manager"], {
      cwd: directory,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
      env,
    });
  } catch (error) {
    const message = error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT"
      ? `未找到 Python 解释器：${python}，请检查 Python 环境设置`
      : error instanceof Error ? error.message : "无法启动 ComfyUI";
    state = { status: "error", message, external: false };
    throw localError(message);
  }
  child = proc;
  state = { status: "starting", message: "正在启动 ComfyUI", external: false };
  drain(proc.stdout);
  drain(proc.stderr);
  void proc.exited.then(code => {
    if (child !== proc) return;
    child = undefined;
    const detail = lastLine();
    state = {
      status: code === 0 ? "stopped" : "error",
      message: code === 0 ? "ComfyUI 已退出" : `ComfyUI 启动失败（退出码 ${code}）${detail ? `：${detail}` : ""}`,
      external: false,
    };
  });
  void waitForRunning(proc);
  return snapshot();
}

async function stopInternal() {
  const proc = child;
  if (!proc || proc.exitCode !== null) {
    child = undefined;
    if (await healthy()) throw localError("ComfyUI 由外部进程启动，无法从应用内停止");
    state = { status: "stopped", message: "ComfyUI 未运行", external: false };
    return snapshot();
  }
  child = undefined;
  proc.kill();
  await Promise.race([proc.exited, sleep(5000)]);
  // ACT: Windows 上第一次终止可能只结束主进程，超时后再强制结束。
  if (proc.exitCode === null) proc.kill(9);
  await Promise.race([proc.exited, sleep(2000)]);
  // ACT: 端口释放可能晚于进程退出，重启前等待健康检查失败，避免误判为外部实例。
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && await healthy()) await sleep(500);
  state = { status: "stopped", message: "ComfyUI 已停止", external: false };
  return snapshot();
}

export async function status() {
  const running = await healthy();
  if (running) {
    const external = !(child && child.exitCode === null);
    state = { status: "running", message: external ? "检测到已在运行的 ComfyUI" : "ComfyUI 运行中", external };
  } else if ((!child || child.exitCode !== null) && state.status !== "starting" && state.status !== "error") {
    state = { status: "stopped", message: "ComfyUI 未运行", external: false };
  }
  return snapshot();
}

export function start() {
  return runExclusive(startInternal);
}

export function stop() {
  return runExclusive(stopInternal);
}

export function restart() {
  return runExclusive(async () => {
    await stopInternal();
    return startInternal();
  });
}

export function autoStart() {
  const config = readConfig();
  if (!config.autoStart || !config.directory || !serverTarget().local) return;
  void start().catch(error => console.warn("自动启动 ComfyUI 失败：", error instanceof Error ? error.message : error));
}

// ACT: ComfyUI 是当前进程的子进程，父进程退出时尽力结束，避免残留后台服务。
process.once("exit", () => {
  child?.kill();
});
