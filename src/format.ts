import type { JiraSprint, LeaderboardEntry, ProjectDigest, SprintDigestTask } from "./types.js";
import { startOfDayInTz } from "./window.js";

const MDV2_SPECIAL = /[_*\[\]()~`>#+\-=|{}.!\\]/g;

export function escapeMd(text: string): string {
  return text.replace(MDV2_SPECIAL, (c) => `\\${c}`);
}

/**
 * Escape MarkdownV2 special chars but preserve `**bold**` segments by
 * converting them to Telegram's single-asterisk bold form. Used for LLM
 * output where we want keyword highlights without letting LLM produce
 * arbitrary markdown.
 */
export function escapeMdWithBold(text: string): string {
  const out: string[] = [];
  const re = /\*\*([^*\n]+)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out.push(escapeMd(text.slice(last, m.index)));
    out.push("*" + escapeMd(m[1]!) + "*");
    last = m.index + m[0].length;
  }
  out.push(escapeMd(text.slice(last)));
  return out.join("");
}

const NO_LABEL = "Không gắn label";
const NO_LABEL_COMPLETED = "Người hùng thầm lặng";
const TEAM_PREFIX_RE = /^(be|fe|qa|qc|dev|ba|pm|po|sm)-/i;

function prettifyLabel(raw: string): string {
  const stripped = raw.replace(TEAM_PREFIX_RE, "");
  return stripped
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

const ROLE_NAMES: Record<string, string> = {
  be: "Backend",
  fe: "Frontend",
  qa: "QA",
  qc: "QC",
  dev: "Dev",
  ba: "BA",
  pm: "PM",
  po: "PO",
  sm: "SM",
};

/** Extract role label (e.g., "Backend", "QC") from a raw label like `qc-huu-hoan`. */
export function roleFromLabel(raw: string): string | null {
  const m = TEAM_PREFIX_RE.exec(raw);
  if (!m) return null;
  const key = m[1]!.toLowerCase();
  return ROLE_NAMES[key] ?? key.toUpperCase();
}

/** Get role for a task by looking at its first label. */
export function roleForTask(t: SprintDigestTask): string | null {
  if (t.labels.length === 0) return null;
  return roleFromLabel(t.labels[0]!);
}

/** Get role for a leaderboard entry name by reverse-mapping name → label across tasks. */
export function roleForName(name: string, allTasks: SprintDigestTask[]): string | null {
  for (const t of allTasks) {
    for (const l of t.labels) {
      const stripped = l.replace(TEAM_PREFIX_RE, "");
      const pretty = stripped
        .split("-")
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
      if (pretty === name) return roleFromLabel(l);
    }
  }
  return null;
}

function subtaskMeta(t: SprintDigestTask): string | null {
  if (!t.subtaskProgress || t.subtaskProgress.total === 0) return null;
  return `📎 ${t.subtaskProgress.done}/${t.subtaskProgress.total} subtasks`;
}

function taskLine(icon: string, t: SprintDigestTask, extra: string[] = []): string {
  const meta = [...extra];
  const sub = subtaskMeta(t);
  if (sub) meta.push(sub);
  const tail = meta.length > 0 ? ` \\(${escapeMd(meta.join(" · "))}\\)` : "";
  return `${icon} \`${escapeMd(t.key)}\` ${escapeMd(t.summary)}${tail}`;
}

function renderCompletedTask(t: SprintDigestTask): string {
  const meta =
    t.hoursInProgress == null
      ? "⚠️ Không chuyển In Progress"
      : `⏱ ${t.hoursInProgress}h`;
  return taskLine("🟢", t, [meta]);
}

/**
 * A task's bucket keys:
 * - If it has labels → one key per label (prefixed "label:")
 * - Else → "nolabel"
 */
function bucketKeys(t: SprintDigestTask): string[] {
  if (t.labels.length > 0) return t.labels.map((l) => `label:${l}`);
  return ["nolabel"];
}

function displayNameForKey(key: string): string {
  if (key === "nolabel") return NO_LABEL;
  return prettifyLabel(key.slice("label:".length));
}

function keyTypeRank(key: string): number {
  return key.startsWith("label:") ? 0 : 1; // nolabel last
}

function collectKeys(...buckets: SprintDigestTask[][]): string[] {
  const set = new Set<string>();
  for (const bucket of buckets) {
    for (const t of bucket) for (const k of bucketKeys(t)) set.add(k);
  }
  return [...set].sort((a, b) => {
    const ra = keyTypeRank(a);
    const rb = keyTypeRank(b);
    if (ra !== rb) return ra - rb;
    return displayNameForKey(a).localeCompare(displayNameForKey(b));
  });
}

function filterByKey(tasks: SprintDigestTask[], key: string): SprintDigestTask[] {
  return tasks.filter((t) => bucketKeys(t).includes(key));
}

function primaryBucketKey(t: SprintDigestTask): string {
  if (t.labels.length > 0) return `label:${t.labels[0]}`;
  return "nolabel";
}

export function computeLeaderboard(tasks: SprintDigestTask[]): LeaderboardEntry[] {
  const agg = new Map<
    string,
    { name: string; role: string | null; hours: number; tasks: number; hasHours: boolean }
  >();
  for (const t of tasks) {
    const key = primaryBucketKey(t);
    if (key === "nolabel") continue;
    const cur =
      agg.get(key) ??
      {
        name: displayNameForKey(key),
        role: roleFromLabel(key.slice("label:".length)),
        hours: 0,
        tasks: 0,
        hasHours: false,
      };
    cur.tasks += 1;
    if (t.hoursInProgress != null) {
      cur.hours += t.hoursInProgress;
      cur.hasHours = true;
    }
    agg.set(key, cur);
  }
  const entries: LeaderboardEntry[] = [...agg.values()];
  entries.sort((a, b) => {
    if (a.hasHours !== b.hasHours) return a.hasHours ? -1 : 1;
    if (a.hasHours && b.hasHours && b.hours !== a.hours) return b.hours - a.hours;
    if (b.tasks !== a.tasks) return b.tasks - a.tasks;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

function renderLeaderboard(entries: LeaderboardEntry[]): string {
  if (entries.length === 0) return "";
  const lines: string[] = ["🏆 *Bảng xếp hạng*"];
  entries.forEach((e, i) => {
    const rank = `${i + 1}\\.`;
    const stat = e.hasHours
      ? `${e.hours}h \\(${e.tasks} task${e.tasks > 1 ? "s" : ""}\\)`
      : `${e.tasks} task${e.tasks > 1 ? "s" : ""}`;
    lines.push(`${rank} *${escapeMd(e.name)}* — ${stat}`);
  });
  return lines.join("\n");
}

function renderCompletedSection(
  displayName: string,
  completed: SprintDigestTask[],
): string {
  if (completed.length === 0) return "";
  const lines: string[] = [`👤 *${escapeMd(displayName)}*`];
  for (const t of completed) lines.push(renderCompletedTask(t));
  return lines.join("\n");
}

function renderStuckTask(t: SprintDigestTask, now: Date): string {
  const owner = displayNameForKey(primaryBucketKey(t));
  const since = t.inProgressSince ? new Date(t.inProgressSince) : null;
  const days = since
    ? Math.max(1, Math.floor((now.getTime() - since.getTime()) / 86_400_000))
    : null;
  const ageLabel = days != null ? `🕒 ${days} ngày` : null;
  const meta = ageLabel ? [ageLabel, `👤 ${owner}`] : [`👤 ${owner}`];
  return taskLine("🟡", t, meta);
}

export interface FormatInput {
  digest: ProjectDigest;
  runDate: string; // yyyy-mm-dd in tz
  weekdayLabel: string; // Mon..Fri
  windowLabel: string; // "Hôm qua" or "Cuối tuần (Fri–Sun)"
  windowDateLabel: string; // "2026-04-13" or "2026-04-10 → 2026-04-13"
}

const BUCKET_LABEL: Record<"done" | "inProgress" | "todo", string> = {
  done: "✅",
  inProgress: "🟡",
  todo: "⚪",
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Compact HTML summary of tasks added to the sprint in the last `hoursBack`
 * hours. Designed to be appended to the burndown photo caption (Telegram
 * caption limit is 1024 chars), so it groups added subtasks under their
 * parent and truncates aggressively.
 *
 * Returns "" if nothing new in the window.
 */
export function formatRecentAdditionsCaption(
  digest: ProjectDigest,
  now: Date,
  hoursBack = 24,
  maxParents = 5,
): string {
  const sc = digest.scopeCreep;
  if (!sc || sc.added.length === 0) return "";
  const cutoff = now.getTime() - hoursBack * 3_600_000;
  const recent = sc.added.filter((a) => {
    const t = new Date(a.addedAt).getTime();
    return Number.isFinite(t) && t >= cutoff && t <= now.getTime();
  });
  if (recent.length === 0) return "";

  type Group = {
    title: string;
    count: number;
    isStandalone: boolean;
  };
  const groups = new Map<string, Group>();
  for (const a of recent) {
    const parentKey = a.parentKey;
    const parentSummary = a.parentSummary;
    if (parentKey) {
      const k = parentKey;
      const g = groups.get(k);
      if (g) g.count += 1;
      else
        groups.set(k, {
          title: `${parentKey}${parentSummary ? ` · ${parentSummary}` : ""}`,
          count: 1,
          isStandalone: false,
        });
    } else {
      const k = a.task.key;
      groups.set(k, {
        title: `${a.task.key} · ${a.task.summary}`,
        count: 1,
        isStandalone: true,
      });
    }
  }
  const sorted = [...groups.values()].sort((a, b) => b.count - a.count);
  const shown = sorted.slice(0, maxParents);

  const trunc = (s: string, n = 60): string => (s.length <= n ? s : s.slice(0, n - 1) + "…");
  const lines = shown.map((g) => {
    const tail = g.isStandalone ? "" : ` (+${g.count} subtask${g.count > 1 ? "s" : ""})`;
    return `• ${escapeHtml(trunc(g.title))}${escapeHtml(tail)}`;
  });
  const more =
    sorted.length > shown.length ? `\n…và ${sorted.length - shown.length} task khác` : "";
  return `➕ <b>Mới bổ sung (${hoursBack}h):</b> ${recent.length} task\n${lines.join("\n")}${more}`;
}

export function formatDigest({
  digest,
  runDate,
  weekdayLabel,
  windowLabel,
  windowDateLabel,
}: FormatInput): string {
  const { done, total, inProgress, todo } = digest.counts;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const deltaCount = digest.completedInWindow.length;
  const deltaPct = total > 0 ? Math.round((deltaCount / total) * 100) : 0;
  const progressPct =
    deltaCount > 0 ? `${pct}% ↗ \\+${deltaPct}%` : `${pct}%`;

  const header = [
    `📊 *Daily Sprint Digest* — ${escapeMd(runDate)} \\(${escapeMd(weekdayLabel)}\\)`,
    `*Project:* ${escapeMd(digest.projectKey)} · *${escapeMd(digest.sprint.name)}* \\(Day ${digest.dayNumber}/${digest.totalDays}\\)`,
    `*Progress:* ${done}/${total} done \\(${progressPct}\\) · ${inProgress} in progress · ${todo} todo`,
  ].join("\n");

  const llm = digest.llmNote ? `\n\n🤖 _${escapeMd(digest.llmNote)}_` : "";

  const completedKeys = collectKeys(digest.completedInWindow);
  const completedNames = new Set(
    completedKeys.filter((k) => k !== "nolabel").map((k) => displayNameForKey(k)),
  );

  const completedBlocks: string[] = [];
  for (const key of completedKeys) {
    const c = filterByKey(digest.completedInWindow, key);
    const name = key === "nolabel" ? NO_LABEL_COMPLETED : displayNameForKey(key);
    const block = renderCompletedSection(name, c);
    if (block) completedBlocks.push(block);
  }
  const completedHeader = `✅ *Đã hoàn thành* \\(${escapeMd(windowLabel)} · ${escapeMd(windowDateLabel)}\\)`;
  const completedSection =
    completedBlocks.length > 0
      ? [completedHeader, ...completedBlocks].join("\n\n")
      : `${completedHeader}\n_Chưa có ai hoàn thành task_`;

  const memberNames = new Set<string>();
  for (const bucket of [digest.completedInWindow, digest.inProgress, digest.todo]) {
    for (const t of bucket) {
      for (const k of bucketKeys(t)) {
        if (k === "nolabel") continue;
        memberNames.add(displayNameForKey(k));
      }
    }
  }
  for (const e of digest.leaderboard) {
    if (e.name !== NO_LABEL) memberNames.add(e.name);
  }

  const inactiveNames = [...memberNames]
    .filter((n) => !completedNames.has(n))
    .sort((a, b) => a.localeCompare(b));
  const inactiveSection =
    inactiveNames.length > 0
      ? [
          `😴 *Chưa xong task nào*`,
          ...inactiveNames.map((n) => `• ${escapeMd(n)}`),
        ].join("\n")
      : "";

  const todayStart = startOfDayInTz(digest.windowUntil, digest.timezone);
  const stuckTasks = digest.inProgress.filter((t) => {
    if (!t.inProgressSince) return false;
    return new Date(t.inProgressSince).getTime() < todayStart.getTime();
  });
  stuckTasks.sort(
    (a, b) =>
      new Date(a.inProgressSince!).getTime() - new Date(b.inProgressSince!).getTime(),
  );
  const stuckSection =
    stuckTasks.length > 0
      ? [
          `⚠️ *In progress qua ngày* \\(chưa Done trong ngày vào In Progress\\)`,
          ...stuckTasks.map((t) => renderStuckTask(t, digest.windowUntil)),
        ].join("\n")
      : "";

  const parts: string[] = [header + llm, completedSection];
  if (inactiveSection) parts.push(inactiveSection);
  if (stuckSection) parts.push(stuckSection);

  const leaderboard = renderLeaderboard(digest.leaderboard);
  if (leaderboard) parts.push(leaderboard);

  return parts.join("\n\n");
}

const VI_WEEKDAYS: Record<string, string> = {
  Monday: "Thứ Hai",
  Tuesday: "Thứ Ba",
  Wednesday: "Thứ Tư",
  Thursday: "Thứ Năm",
  Friday: "Thứ Sáu",
  Saturday: "Thứ Bảy",
  Sunday: "Chủ Nhật",
};

export function vietnameseWeekday(now: Date, timezone: string): string {
  const long = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
  }).format(now);
  return VI_WEEKDAYS[long] ?? long;
}

function formatDmy(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("day")}/${get("month")}/${get("year")}`;
}

export function computeUnassignedCount(digest: ProjectDigest): number {
  const isUnassigned = (t: SprintDigestTask) => t.assignee === "Unassigned";
  return (
    digest.todo.filter(isUnassigned).length +
    digest.inProgress.filter(isUnassigned).length
  );
}

export interface SprintEndCountdown {
  label: string;          // "~1 ngày 2 tiếng" | "hôm nay" | "đã quá hạn"
  endDateLabel: string;   // "15/05/2026"
  diffMs: number;         // signed
}

export function computeSprintEndCountdown(
  sprint: JiraSprint,
  now: Date,
  timezone: string,
): SprintEndCountdown | null {
  if (!sprint.endDate) return null;
  const end = new Date(sprint.endDate);
  if (!Number.isFinite(end.getTime())) return null;
  const diffMs = end.getTime() - now.getTime();
  const endDateLabel = formatDmy(end, timezone);
  if (diffMs < 0) return { label: "đã quá hạn", endDateLabel, diffMs };
  const totalHours = Math.floor(diffMs / 3_600_000);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours - days * 24;
  let label: string;
  if (days === 0 && hours === 0) label = "dưới 1 tiếng";
  else if (days === 0) label = `~${hours} tiếng`;
  else if (hours === 0) label = `~${days} ngày`;
  else label = `~${days} ngày ${hours} tiếng`;
  return { label, endDateLabel, diffMs };
}

export interface BurnRate {
  dayNumber: number;
  totalDays: number;
  remainingDays: number;
  doneRate: number;        // task/day kể từ đầu sprint
  requiredRate: number;    // task/day cần để hoàn thành
  projectedDone: number;   // dự kiến done lúc sprint kết thúc nếu giữ tốc độ
  gap: number;             // total - projectedDone (>0 = thiếu, <0 = dư)
  status: "on-track" | "at-risk" | "behind";
}

export function computeBurnRate(digest: ProjectDigest): BurnRate | null {
  const { dayNumber, totalDays } = digest;
  const { done, total } = digest.counts;
  if (dayNumber < 1 || totalDays < 1 || total === 0) return null;
  // Forecast is volatile before sprint has accumulated enough signal. Trying
  // to extrapolate a daily rate from ~1 day of data produces nonsense like
  // "projected 48 / 26 tasks" and false on-track status. Require at least 3
  // days elapsed AND ≥25% of the sprint behind us before publishing a rate.
  if (dayNumber < 3 || dayNumber / totalDays < 0.25) return null;
  const remainingDays = Math.max(0, totalDays - dayNumber);
  const doneRate = done / dayNumber;
  const remainingTasks = total - done;
  const requiredRate = remainingDays > 0 ? remainingTasks / remainingDays : remainingTasks;
  // Cap projection at total — you can't complete more tasks than exist. Lets
  // gap reflect "tasks still uncompleted at this pace", never goes negative
  // far beyond zero from extrapolation noise.
  const projectedDone = Math.min(total, done + doneRate * remainingDays);
  const gap = total - projectedDone;
  const gapRatio = gap / total;
  let status: BurnRate["status"];
  if (gap <= 0) status = "on-track";
  else if (gapRatio < 0.1) status = "at-risk";
  else status = "behind";
  return {
    dayNumber,
    totalDays,
    remainingDays,
    doneRate,
    requiredRate,
    projectedDone,
    gap,
    status,
  };
}

export interface BugStats {
  total: number;        // tổng bug trong sprint
  done: number;         // bug đã xong
  inProgress: number;   // bug đang làm
  todo: number;         // bug chưa bắt đầu
  ratio: number;        // bug / tổng task của sprint (0..1)
  newSinceSprintStart: number; // bug được tạo sau sprint.startDate
}

function isBugType(t?: string): boolean {
  if (!t) return false;
  return /\b(bug|defect|lỗi)\b/i.test(t);
}

export function computeBugStats(digest: ProjectDigest): BugStats {
  const start = digest.sprint.startDate ? new Date(digest.sprint.startDate).getTime() : null;
  let done = 0;
  let inProgress = 0;
  let todo = 0;
  let newSinceSprintStart = 0;
  const bump = (
    bucket: SprintDigestTask[],
    counter: (n: number) => void,
  ): void => {
    for (const t of bucket) {
      if (!isBugType(t.issueType)) continue;
      counter(1);
      if (start && t.createdAt) {
        const c = new Date(t.createdAt).getTime();
        if (Number.isFinite(c) && c >= start) newSinceSprintStart += 1;
      }
    }
  };
  bump(digest.todo, () => (todo += 1));
  bump(digest.inProgress, () => (inProgress += 1));
  bump(digest.doneAll, () => (done += 1));
  const total = done + inProgress + todo;
  const ratio = digest.counts.total > 0 ? total / digest.counts.total : 0;
  return { total, done, inProgress, todo, ratio, newSinceSprintStart };
}

export interface StuckTask {
  task: SprintDigestTask;
  days: number;
  owner: string;
  ownerRole: string | null;
}

export function computeStuckTasks(digest: ProjectDigest, asOf: Date): StuckTask[] {
  const out: StuckTask[] = [];
  for (const t of digest.inProgress) {
    if (!t.inProgressSince) continue;
    const since = new Date(t.inProgressSince).getTime();
    if (!Number.isFinite(since)) continue;
    const diff = asOf.getTime() - since;
    if (diff < 86_400_000) continue;
    const days = Math.floor(diff / 86_400_000);
    const key = primaryBucketKey(t);
    out.push({
      task: t,
      days,
      owner: displayNameForKey(key),
      ownerRole: key.startsWith("label:") ? roleFromLabel(key.slice("label:".length)) : null,
    });
  }
  out.sort((a, b) => b.days - a.days || a.task.key.localeCompare(b.task.key));
  return out;
}

function renderStuckBriefLine(s: StuckTask): string {
  const meta = [`🕒 ${s.days} ngày`, `👤 ${s.owner}`];
  return taskLine("🟡", s.task, meta);
}

export interface DailyBriefInput {
  digest: ProjectDigest;
  runDate: string;   // "2026-05-14"
  now: Date;
  timezone: string;
}

export function formatDailyBrief({
  digest,
  runDate,
  now,
  timezone,
}: DailyBriefInput): string {
  const weekday = vietnameseWeekday(now, timezone);
  const dmy = formatDmy(now, timezone);
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      hour12: false,
    }).format(now),
  );
  const session = hour < 12 ? "Sáng" : hour < 18 ? "Chiều" : "Tối";

  const countdown = computeSprintEndCountdown(digest.sprint, now, timezone);
  const countdownInline = countdown
    ? countdown.diffMs < 0
      ? "⏰ Sprint đã quá hạn"
      : `⏰ Sprint kết thúc còn ${countdown.label}`
    : "";

  const headerLines = [
    `📊 *Daily Brief* — ${escapeMd(weekday)}, ${escapeMd(dmy)} \\(${escapeMd(session)}\\)`,
    `*${escapeMd(digest.projectName)}* · *${escapeMd(digest.sprint.name)}* \\| Ngày ${digest.dayNumber}/${digest.totalDays}${countdownInline ? ` \\| ${escapeMd(countdownInline)}` : ""}`,
  ];
  const header = headerLines.join("\n");

  const { done, total, inProgress, todo } = digest.counts;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const unassigned = computeUnassignedCount(digest);
  const metricsLines: string[] = [
    `🔢 *SỐ LIỆU NHANH*`,
    `• Tasks: ${done}/${total} done \\(${pct}%\\) · ${inProgress} in progress · ${todo} todo`,
    `• Unassigned: ${unassigned}${unassigned > 0 ? " ⚠️" : ""}`,
  ];
  if (countdown) {
    const cdLine =
      countdown.diffMs < 0
        ? `• Sprint kết thúc: đã quá hạn \\(${escapeMd(countdown.endDateLabel)}\\)`
        : `• Sprint kết thúc: ${escapeMd(countdown.label)} nữa \\(${escapeMd(countdown.endDateLabel)}\\)`;
    metricsLines.push(cdLine);
  }
  const metrics = metricsLines.join("\n");

  const topN = digest.leaderboard.slice(0, 5);
  const topLines: string[] = [];
  if (topN.length > 0) {
    topLines.push(`🏆 *TOP PERFORMER* \\(theo giờ in\\-progress\\)`);
    topN.forEach((e, i) => {
      const stat = e.hasHours
        ? `${e.hours}h \\(${e.tasks} task${e.tasks > 1 ? "s" : ""}\\)`
        : `${e.tasks} task${e.tasks > 1 ? "s" : ""}`;
      topLines.push(`${i + 1}\\. *${escapeMd(e.name)}* — ${stat}`);
    });
  }
  const topSection = topLines.join("\n");

  const asOf = startOfDayInTz(now, timezone);
  const stuck = computeStuckTasks(digest, asOf);
  const stuckSection =
    stuck.length > 0
      ? [
          `⚠️ *TASK STUCK* \\(In Progress \\> 1 ngày\\)`,
          ...stuck.map(renderStuckBriefLine),
        ].join("\n")
      : "";

  const parts: string[] = [header, metrics];
  if (topSection) parts.push(topSection);
  if (stuckSection) parts.push(stuckSection);
  void runDate;
  return parts.join("\n\n");
}

/** Standalone 🎯 ĐIỂM CẦN QUAN TÂM section. Returns "" when no notes. */
export function formatLlmInsight(
  notes: { items: string[] } | null | undefined,
): string {
  if (!notes || notes.items.length === 0) return "";
  const header = `🎯 *ĐIỂM CẦN QUAN TÂM*`;
  const body = notes.items.map((s) => escapeMdWithBold(s)).join("\n\n");
  return `${header}\n\n${body}`;
}

/** Standalone ✅ Đã hoàn thành section, extracted from former formatDigest logic. */
export function formatCompletedSection(
  digest: ProjectDigest,
  windowLabel: string,
  windowDateLabel: string,
): string {
  const completedKeys = collectKeys(digest.completedInWindow);
  const completedBlocks: string[] = [];
  for (const key of completedKeys) {
    const c = filterByKey(digest.completedInWindow, key);
    const name = key === "nolabel" ? NO_LABEL_COMPLETED : displayNameForKey(key);
    const block = renderCompletedSection(name, c);
    if (block) completedBlocks.push(block);
  }
  const header = `✅ *Đã hoàn thành* \\(${escapeMd(windowLabel)} · ${escapeMd(windowDateLabel)}\\)`;
  return completedBlocks.length > 0
    ? [header, ...completedBlocks].join("\n\n")
    : `${header}\n_Chưa có ai hoàn thành task_`;
}

/** Split a long MarkdownV2 message by double-newline into <=4096 char chunks. */
export function splitMessage(text: string, limit = 4000): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  const paragraphs = text.split("\n\n");
  let buf = "";
  for (const p of paragraphs) {
    const candidate = buf ? `${buf}\n\n${p}` : p;
    if (candidate.length > limit && buf) {
      chunks.push(buf);
      buf = p;
    } else {
      buf = candidate;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}
