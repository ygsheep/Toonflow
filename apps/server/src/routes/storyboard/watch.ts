import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";

export default Router().get("/", validateFields({ directory: z.string().min(1).max(4096) }, "query"), async (req, res) => {
  // ACT: 原生 EventSource 无自定义请求头；先用同源校验兜底，再临时补齐工作区标记复用统一路径校验。
  u.mcpControl.getAppOrigin(req);
  const header = req.headers["x-toonflow-workspace"];
  req.headers["x-toonflow-workspace"] = "1";
  let directory: string;
  try {
    directory = await u.workspace.resolveWorkspace(req, req.query.directory as string);
  } finally {
    if (header === undefined) delete req.headers["x-toonflow-workspace"];
    else req.headers["x-toonflow-workspace"] = header;
  }
  u.storyboard.watchStoryboard(directory);
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  res.write(": connected\n\n");
  let version = 0;
  const unsubscribe = u.storyboard.onStoryboardAssetsChange(directory, () => {
    if (!res.destroyed) res.write(`data: ${JSON.stringify({ type: "assets", version: ++version })}\n\n`);
  });
  const heartbeat = setInterval(() => {
    if (!res.destroyed) res.write(": keepalive\n\n");
  }, 20000);
  const socket = req.socket;
  const close = () => {
    clearInterval(heartbeat);
    unsubscribe();
    res.off("close", close);
    socket.off("close", close);
  };
  res.once("close", close);
  socket.once("close", close);
});
