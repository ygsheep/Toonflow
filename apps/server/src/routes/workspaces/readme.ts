import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

const router = Router();

export default router.post("/", validateFields({ directory: z.string().min(1).max(4096) }), async (req, res) => {
  const directory = await u.workspace.resolveWorkspace(req, req.body.directory as string);
  const created = await u.workspace.ensureWorkspaceReadme(directory);
  res.set("Cache-Control", "no-store").json(success({ created }));
});
