import { Router } from "express";
import u from "@/utils";
import { error, success } from "@/lib/responseFormat";
import { isLocalWorkspaceRequest } from "@/utils/workspace";

export default Router().get("/", async (req, res) => {
  if (!isLocalWorkspaceRequest(req)) return res.status(403).json(error("仅允许本机操作", null, 403));
  res.json(success(await u.comfyuiLocal.status()));
});
