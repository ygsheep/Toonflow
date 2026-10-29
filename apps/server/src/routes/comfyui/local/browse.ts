import { readdir, stat } from "@toonflow/file";
import { Router } from "express";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { error, success } from "@/lib/responseFormat";
import { isLocalWorkspaceRequest } from "@/utils/workspace";

export default Router().get("/", async (req, res) => {
  if (!isLocalWorkspaceRequest(req)) return res.status(403).json(error("仅允许本机操作", null, 403));
  const value = typeof req.query.path === "string" ? req.query.path.trim() : "";
  // ACT: 浏览器没有原生目录选择器，本机接口只读列出子目录供设置页浏览；不新增写操作。
  if (!value) {
    if (process.platform !== "win32") return res.json(success({ directory: "/", parent: null, entries: [] }));
    const entries: { name: string; path: string }[] = [];
    for (let index = 0; index < 26; index += 1) {
      const path = `${String.fromCharCode(65 + index)}:\\`;
      const info = await stat(path).catch(() => null);
      if (info?.isDirectory()) entries.push({ name: path, path });
    }
    return res.json(success({ directory: "", parent: null, entries }));
  }
  if (!isAbsolute(value)) return res.status(400).json(error("路径必须是绝对路径", null, 400));
  const directory = resolve(value);
  const info = await stat(directory).catch(() => null);
  if (!info?.isDirectory()) return res.status(400).json(error("目录不存在", null, 400));
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter(item => item.isDirectory())
    .map(item => ({ name: item.name, path: join(directory, item.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
  const parent = dirname(directory);
  res.json(success({ directory, parent: parent === directory ? null : parent, entries }));
});
