// ACT: 审阅状态与人工意见只存在本机，按工作目录隔离；单人单机够用，跨设备同步再迁服务端。
export type ReviewStatus = "unread" | "read" | "flagged" | "confirmed";
export type IssueSeverity = "p0" | "p1" | "p2";

export type ManualIssue = {
  id: string;
  code: "manual";
  segmentId: string;
  shotNo: string;
  field: string;
  severity: IssueSeverity;
  source: "manual";
  desc: string;
  fix: string;
  createdAt: number;
};

export type ReviewState = {
  shots: Record<string, { status: ReviewStatus }>;
  manual: ManualIssue[];
  ignored: Record<string, string>;
};

const storagePrefix = "toonflow.storyboard.review.";

export function emptyReview(): ReviewState {
  return { shots: {}, manual: [], ignored: {} };
}

export function loadReview(directory: string): ReviewState {
  if (!directory) return emptyReview();
  try {
    const parsed = JSON.parse(localStorage.getItem(storagePrefix + directory) ?? "null") as Partial<ReviewState> | null;
    if (!parsed || typeof parsed !== "object") return emptyReview();
    return {
      shots: parsed.shots && typeof parsed.shots === "object" ? parsed.shots : {},
      manual: Array.isArray(parsed.manual) ? parsed.manual : [],
      ignored: parsed.ignored && typeof parsed.ignored === "object" ? parsed.ignored : {},
    };
  } catch {
    return emptyReview();
  }
}

export function saveReview(directory: string, state: ReviewState) {
  if (!directory) return;
  try {
    localStorage.setItem(storagePrefix + directory, JSON.stringify(state));
  } catch {
    // ACT: 审阅数据很小，配额异常时静默跳过，不阻断分镜浏览。
  }
}
