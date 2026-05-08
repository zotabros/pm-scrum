import type { LeaderboardEntry, ProjectDigest, SprintDigestTask } from "./types.js";
import { startOfDayInTz } from "./window.js";

const MDV2_SPECIAL = /[_*\[\]()~`>#+\-=|{}.!\\]/g;

export function escapeMd(text: string): string {
  return text.replace(MDV2_SPECIAL, (c) => `\\${c}`);
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
  const agg = new Map<string, { name: string; hours: number; tasks: number; hasHours: boolean }>();
  for (const t of tasks) {
    const key = primaryBucketKey(t);
    if (key === "nolabel") continue;
    const cur = agg.get(key) ?? { name: displayNameForKey(key), hours: 0, tasks: 0, hasHours: false };
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
