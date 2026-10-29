import { Router } from "express";
import u from "@/utils";
import { error, success } from "@/lib/responseFormat";
import { isLocalWorkspaceRequest } from "@/utils/workspace";

export default Router().post("/", async (req, res) => {
  if (!isLocalWorkspaceRequest(req)) return res.status(403).json(error("仅允许本机操作", null, 403));
  const status = await u.comfyuiLocal.stop();
  res.json(success(status, status.message));
});
