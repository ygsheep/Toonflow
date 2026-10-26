// ACT: 审查规则集中在分镜模块内，扫描时顺带产出问题，面板轮询不需要额外接口。
export type ReviewSeverity = "p0" | "p1" | "p2";

export type StoryboardIssue = {
  id: string;
  code: string;
  shotNo: string;
  field: string;
  severity: ReviewSeverity;
  source: "auto";
  desc: string;
  fix: string;
};

type ReviewShot = {
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
  light: string;
  color: string;
  beat: string;
  asset: string;
  image: { name: string; path: string } | null;
};

type ReviewReference = { label: string; name: string; path: string | null };

type ReviewPrompt = {
  file: string;
  full: string;
  shots: { no: string; text: string }[];
  blocks: number[];
};

export type ReviewInput = {
  segmentId: string;
  shots: ReviewShot[];
  prompt: ReviewPrompt | null;
  references: ReviewReference[];
};

export type ReviewResult = { issues: StoryboardIssue[]; orphanPrompts: string[] };

// ACT: 必填字段按“缺了就无法拍摄”确定；台词、道具、服装、节拍属于条件字段，不做空值告警。
const requiredFields: [keyof ReviewShot, string][] = [
  ["no", "镜号"],
  ["scene", "场景"],
  ["size", "景别"],
  ["angle", "摄法"],
  ["pos", "机位"],
  ["move", "运镜"],
  ["lens", "焦段"],
  ["dur", "时长"],
  ["visual", "画面"],
  ["action", "动作"],
  ["light", "光线"],
  ["color", "色彩"],
];

const placeholderPattern = /^(—+|--+|待补|待定|tbd|todo|略|占位|无内容)$/i;
const shotNoPattern = /^([A-Z]{2}\d+)-SH(\d+)(?:[-_]([A-Z]\d*))?$/i;
const imageExtensionPattern = /\.(png|jpe?g|webp|gif)$/i;

// ACT: 分镜表用中文景别，PRD 用英文缩写分组；未知词不参与配比，只提示一次。
const sizeGroups: Record<string, string[]> = {
  特写: ["ECU", "INS", "CU", "大特写", "特写", "近景", "插入"],
  中景: ["MCU", "MS", "中近景", "中景"],
  中全景: ["MFS", "FS", "中全景", "全景"],
  远景: ["LS", "ELS", "远景", "大远景", "大全景"],
};

// ACT: 配比按镜数计算，PRD 未明确是否按时长；等口径确定后再切换。
const sizeRatioRanges: Record<string, [number, number]> = {
  特写: [35, 45],
  中景: [30, 40],
  中全景: [15, 25],
  远景: [0, 10],
};

function isPlaceholder(value: string) {
  return placeholderPattern.test(value.trim());
}

function isFilled(value: string) {
  return Boolean(value.trim()) && !isPlaceholder(value);
}

function sizeGroup(value: string) {
  const key = value.trim().replace(/\s+/g, "").toUpperCase();
  if (!key) return "";
  return Object.keys(sizeGroups).find(group => sizeGroups[group]!.includes(key)) ?? "unknown";
}

function shotPrefix(value: string) {
  const matched = /^([A-Z]{2}\d+)/i.exec(value.trim());
  return matched?.[1]?.toUpperCase() ?? "";
}

function shotSequence(value: string) {
  const matched = shotNoPattern.exec(value.trim());
  return matched ? { prefix: matched[1]!.toUpperCase(), sequence: Number(matched[2]) } : null;
}

function textLength(value: string) {
  return value.replace(/\s/g, "").length;
}

export function reviewSegment(input: ReviewInput): ReviewResult {
  const issues: StoryboardIssue[] = [];
  const orphanPrompts: string[] = [];
  const { segmentId, shots, prompt, references } = input;

  const push = (code: string, shotNo: string, field: string, severity: ReviewSeverity, desc: string, fix: string, discriminator = "") => {
    // ACT: id 用段 + 规则 + 镜号 + 字段 + 判别项，忽略记录才能跨轮询稳定命中。
    issues.push({ id: [segmentId, code, shotNo || "-", field, discriminator].join("|"), code, shotNo, field, severity, source: "auto", desc, fix });
  };

  for (const shot of shots) {
    for (const [key, label] of requiredFields) {
      if (isFilled(String(shot[key] ?? ""))) continue;
      push("required-empty", shot.no, label, "p0", `${label}未填写或仍是占位内容`, `补写${label}，不要留待补/略/—`);
    }

    const duration = Number.parseFloat(shot.dur);
    if (!Number.isFinite(duration) || duration <= 0) {
      push("duration-invalid", shot.no, "时长", "p0", `时长「${shot.dur || "空"}」无法计算`, "填写 0.5–4 秒的数字，可带 s 后缀");
    } else if (duration < 0.5 || duration > 4) {
      push("duration-range", shot.no, "时长", "p1", `单镜 ${duration}s 超出 0.5–4s`, "拆分或合并镜头，把单镜控制在 0.5–4 秒");
    }

    if (isFilled(shot.line) && Number.isFinite(duration) && duration > 0) {
      const length = textLength(shot.line);
      const needed = length / 5;
      if (needed > duration * 0.9) {
        push("line-too-long", shot.no, "台词", "p1", `台词 ${length} 字约需 ${needed.toFixed(1)}s，镜头只有 ${duration}s`, `删减台词或把时长加到 ${Math.ceil(needed / 0.9 * 2) / 2}s 以上`);
      }
    }

    if (shot.asset && !shot.image) {
      push("asset-missing", shot.no, "素材", "p1", `素材「${shot.asset}」在 资产/ 中没有图片`, "补图到 资产/ 或修正素材编号", shot.asset);
    }
  }

  // 镜号：重复、跳号、倒序、场次前缀不一致。
  const seen = new Map<string, number>();
  let previous: { prefix: string; sequence: number; no: string } | null = null;
  shots.forEach((shot, index) => {
    if (shot.no) {
      const first = seen.get(shot.no);
      if (first === undefined) seen.set(shot.no, index);
      else push("shot-duplicate", shot.no, "镜号", "p0", `镜号重复，首次出现在第 ${first + 1} 镜`, "改为唯一镜号并同步提示词", shot.no);
    }

    const parsed = shotSequence(shot.no);
    if (!parsed) {
      if (shot.no) push("shot-invalid", shot.no, "镜号", "p1", "镜号不符合 SCxx-SHxxx 规则", "改成 SC03-SH155 这类可排序镜号", shot.no);
      previous = null;
    } else {
      if (previous && previous.prefix === parsed.prefix) {
        if (parsed.sequence <= previous.sequence) {
          push("shot-order", shot.no, "镜号", "p1", `镜号排在 ${previous.no} 之后但序号更小`, "按场内镜序重排", shot.no);
        } else if (parsed.sequence > previous.sequence + 1) {
          push("shot-gap", shot.no, "镜号", "p1", `${previous.no} 与 ${shot.no} 之间缺 ${parsed.sequence - previous.sequence - 1} 个镜号`, "确认是否漏镜，补齐缺失镜号", shot.no);
        }
      }
      previous = { ...parsed, no: shot.no };
    }

    const sceneCode = shotPrefix(shot.scene);
    const noCode = parsed?.prefix ?? shotPrefix(shot.no);
    if (sceneCode && noCode && sceneCode !== noCode) {
      push("scene-mismatch", shot.no, "场景", "p1", `场景「${shot.scene}」与镜号前缀 ${noCode} 不一致`, "统一场次编号或修正镜号", sceneCode);
    }
  });

  // 连续同景别 / 同节拍超过 4 镜时合并成一条，避免每镜都报。
  const streak = (field: "size" | "beat", label: string) => {
    let currentValue = "";
    let start = 0;
    let length = 0;
    const flush = (end: number) => {
      if (length > 4 && currentValue) {
        const last = shots[end]!;
        push(`${field}-streak`, last.no, label, "p2", `连续 ${length} 镜使用相同${label}「${currentValue}」`, `在中间插入变化，避免连续 ${length} 镜同${label}`);
      }
    };
    shots.forEach((shot, index) => {
      const value = isFilled(shot[field]) ? shot[field].trim() : "";
      if (value === currentValue) {
        length++;
        return;
      }
      flush(index - 1);
      currentValue = value;
      start = index;
      length = 1;
    });
    flush(shots.length - 1);
  };
  streak("size", "景别");
  streak("beat", "节拍");

  // 景别配比：样本太少时不评判，未知词单独提示。
  const counts = new Map<string, number>();
  const unknown = new Set<string>();
  for (const shot of shots) {
    if (!isFilled(shot.size)) continue;
    const group = sizeGroup(shot.size);
    if (group === "unknown") unknown.add(shot.size.trim());
    else counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  if (unknown.size) push("size-unknown", "", "景别", "p2", `景别词表外：${[...unknown].join("、")}`, "改用特写/近景/中景/中近景/全景/远景等标准词", [...unknown].join("、"));
  const known = [...counts.values()].reduce((sum, value) => sum + value, 0);
  if (known >= 10) {
    for (const [group, [min, max]] of Object.entries(sizeRatioRanges)) {
      const percent = (counts.get(group) ?? 0) / known * 100;
      if (percent < min || percent > max) {
        push("size-ratio", "", "景别", "p2", `${group}组占 ${percent.toFixed(0)}%，目标 ${min}–${max}%`, "调整景别配比，让节奏更接近目标区间", group);
      }
    }
  }

  // 提示词：稿件缺失、未覆盖某镜、镜号越界、场次错位。
  if (!prompt) {
    push("prompt-missing", "", "提示词", "p1", "未找到匹配的提示词稿件", "在 提示词/ 放置带场次号或镜号的提示词文件", "file");
  } else {
    const scoped = new RegExp(`SC(\\d+)`, "i").exec(prompt.file)?.[1];
    const first = shotPrefix(shots[0]?.no ?? "");
    if (scoped && first && `SC${scoped}`.toUpperCase() !== first) {
      push("prompt-scene-mismatch", "", "提示词", "p2", `稿件文件名场次 SC${scoped} 与本段 ${first} 不一致`, "确认稿件归属，或按场次重命名", prompt.file);
    }
    const covered = new Set(prompt.blocks.filter(value => value >= 1 && value <= shots.length));
    shots.forEach((shot, index) => {
      const text = prompt.shots[index]?.text ?? "";
      if (covered.has(index + 1) && isFilled(text)) return;
      push("prompt-shot-missing", shot.no, "提示词", "p1", "该镜在稿件中没有对应内容，当前显示字段拼接提示词", "在稿件时间轴补上这一镜的 [镜N] 内容", String(index + 1));
    });
    for (const block of prompt.blocks) {
      if (block >= 1 && block <= shots.length) continue;
      orphanPrompts.push(`[镜${block}]`);
      push("prompt-orphan", "", "提示词", "p1", `稿件中的 [镜${block}] 超出本段 ${shots.length} 镜`, "删除多余块或补齐分镜", String(block));
    }
  }

  // 槽位：图片找不到、同一文件多个名字、清单项疑似未被正文引用。
  const byPath = new Map<string, string[]>();
  for (const reference of references) {
    if (imageExtensionPattern.test(reference.name) && !reference.path) {
      push("slot-missing", "", "槽位", "p1", `${reference.label} 的 ${reference.name} 在 资产/ 中找不到`, "补图或修正素材清单里的文件名", reference.label);
    }
    if (reference.path) {
      byPath.set(reference.path, [...byPath.get(reference.path) ?? [], reference.label]);
    }
    if (reference.path && prompt && !isReferenced(reference, prompt.full)) {
      push("slot-unused", "", "槽位", "p2", `${reference.label} 可能未被提示词正文引用`, "确认正文是否漏引用该素材，未用到则从清单移除", reference.label);
      // ACT: 正文可能用等价缩写，这条只做提醒，不做阻断。
    }
  }
  for (const [path, labels] of byPath) {
    if (labels.length < 2) continue;
    push("slot-duplicate", "", "槽位", "p2", `${labels.join("、")} 指向同一文件 ${path}`, "合并重复槽位，保留一个名字", path);
  }

  return { issues, orphanPrompts };
}

function isReferenced(reference: ReviewReference, full: string) {
  const label = reference.label.trim();
  const base = reference.name.split(/[/\\]/).pop()?.replace(/\.[^.]+$/, "") ?? "";
  return Boolean(label && full.includes(label)) || Boolean(base && full.includes(base));
}
