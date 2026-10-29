import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().post("/", validateFields({
  directory: z.string().min(1).max(4096),
  sessionFile: z.string().regex(/^[\w-]+\.jsonl$/),
}), async (req, res) => {
  const { directory, sessionFile } = req.body;
  const cwd = await u.workspace.resolveWorkspace(req, directory);
  const { path } = await u.workspaceFile.resolveWorkspacePath(cwd, `.agent/sessions/${sessionFile}`);
  res.json(success(u.agent.stopActiveAgentSession(path)));
});
