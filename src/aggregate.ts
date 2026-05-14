import type { AxiosInstance } from "axios";
import type { JiraChangelogEntry, JiraIssue, JiraSprint, SprintDigestTask } from "./types.js";
import { getIssueChangelog, loadStatusCategoryMap, searchJql, type StatusMeta } from "./jira/issues.js";
import { logger } from "./logger.js";

function assigneeName(issue: JiraIssue): string {
  return issue.fields.assignee?.displayName ?? "Unassigned";
}

function isBlockedStatus(name: string): boolean {
  return /block/i.test(name);
}

function hasSubtasks(issue: JiraIssue): boolean {
  const subs = issue.fields.subtasks;
  return !!subs && subs.length > 0;
}

function computeSubtaskProgress(
  issue: JiraIssue,
): { done: number; total: number } | null {
  const subs = issue.fields.subtasks;
  if (!subs || subs.length === 0) return null;
  let done = 0;
  for (const s of subs) {
    if (s.fields.status.statusCategory.key === "done") done += 1;
  }
  return { done, total: subs.length };
}

/**
 * Parent issues with subtasks are tracked via their children: the children
 * carry the real assignee/label for credit. This returns an issue list where
 * every parent-with-subtasks is replaced by its subtasks (fetched via
 * `key in (...)` because `sprint = X` doesn't reliably return subtasks).
 */
export async function expandSprintIssuesWithSubtasks(
  client: AxiosInstance,
  sprintIssues: JiraIssue[],
): Promise<JiraIssue[]> {
  const parentsWithSubtasks = new Set<string>();
  const subtaskKeysToFetch = new Set<string>();
  const seen = new Set<string>();

  for (const issue of sprintIssues) {
    seen.add(issue.key);
    if (hasSubtasks(issue)) {
      parentsWithSubtasks.add(issue.key);
      for (const s of issue.fields.subtasks!) subtaskKeysToFetch.add(s.key);
    }
  }
  for (const k of [...subtaskKeysToFetch]) if (seen.has(k)) subtaskKeysToFetch.delete(k);

  const fetched: JiraIssue[] = [];
  if (subtaskKeysToFetch.size > 0) {
    const keys = [...subtaskKeysToFetch];
    for (let i = 0; i < keys.length; i += 100) {
      const chunk = keys.slice(i, i + 100);
      try {
        const res = await searchJql(client, `key in (${chunk.join(",")})`);
        fetched.push(...res);
      } catch (err) {
        logger.warn(
          { count: chunk.length, err: (err as Error).message },
          "subtask expansion fetch failed",
        );
      }
    }
  }

  const kept = sprintIssues.filter((i) => !parentsWithSubtasks.has(i.key));
  return [...kept, ...fetched];
}

function toTask(
  issue: JiraIssue,
  hours?: number | null,
  inProgressSince?: Date | null,
): SprintDigestTask {
  return {
    key: issue.key,
    summary: issue.fields.summary,
    assignee: assigneeName(issue),
    labels: issue.fields.labels ?? [],
    status: issue.fields.status.name,
    priority: issue.fields.priority?.name,
    duedate: issue.fields.duedate ?? null,
    blocked: isBlockedStatus(issue.fields.status.name),
    hoursInProgress: hours ?? null,
    inProgressSince: inProgressSince?.toISOString() ?? null,
    subtaskProgress: computeSubtaskProgress(issue),
    issueType: issue.fields.issuetype?.name,
    createdAt: issue.fields.created ?? null,
  };
}

/**
 * Walk through the changelog and sum every interval the issue spent in an
 * "In Progress" status category. Also reports the most recent transition into
 * In Progress that has not yet been left (`currentEnteredAt`); null if the
 * issue is not currently in progress.
 */
/**
 * Build a UTC Date for `yyyy-mm-dd hh:mm` in the given IANA timezone.
 * `hour` may be 24 to mean "start of next day" (advancing through DST safely).
 */
function tzInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(new Date(guess));
  const get = (t: string): number =>
    Number(parts.find((p) => p.type === t)?.value);
  const asUTC = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") === 24 ? 0 : get("hour"),
    get("minute"),
    get("second"),
  );
  return new Date(guess - (asUTC - guess));
}

function localYmd(
  d: Date,
  timezone: string,
): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t: string): number =>
    Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

function localWeekday(
  y: number,
  m: number,
  d: number,
  timezone: string,
): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
  }).format(tzInstant(y, m, d, 12, 0, timezone));
}

function ymdKey(d: { y: number; m: number; d: number }): string {
  const mm = String(d.m).padStart(2, "0");
  const dd = String(d.d).padStart(2, "0");
  return `${d.y}-${mm}-${dd}`;
}

/**
 * Detect Saturdays the team actually worked, from Jira status-change activity.
 * A Saturday qualifies if ≥2 distinct authors performed status transitions
 * on that calendar day (in `timezone`). One person reshuffling cards alone
 * doesn't count.
 */
export function detectWorkingSaturdays(
  changelogs: Iterable<JiraChangelogEntry[]>,
  timezone: string,
): Set<string> {
  const authorsByDay = new Map<string, Set<string>>();
  for (const log of changelogs) {
    for (const entry of log) {
      if (!entry.items?.some((i) => i.field === "status")) continue;
      const at = new Date(entry.created);
      const ymd = localYmd(at, timezone);
      if (localWeekday(ymd.y, ymd.m, ymd.d, timezone) !== "Sat") continue;
      const key = ymdKey(ymd);
      const id = entry.author?.accountId || entry.author?.displayName || "?";
      if (!authorsByDay.has(key)) authorsByDay.set(key, new Set());
      authorsByDay.get(key)!.add(id);
    }
  }
  const out = new Set<string>();
  for (const [day, authors] of authorsByDay) {
    if (authors.size >= 2) out.add(day);
  }
  return out;
}

/**
 * Sum the milliseconds in [start, end] that fall inside the working windows
 * 09:00-12:30 and 13:30-18:00 of each calendar day in `timezone`.
 * 8 working hours per day; lunch 12:30-13:30 is excluded.
 * Multi-day intervals skip Sundays, and skip Saturdays unless the team
 * actually worked that Saturday (per `workingSaturdays`). Same-day intervals
 * always count so weekend work isn't silently dropped.
 */
function businessHoursMs(
  start: Date,
  end: Date,
  timezone: string,
  workingSaturdays: Set<string>,
): number {
  if (end.getTime() <= start.getTime()) return 0;
  const WINDOWS: ReadonlyArray<[number, number, number, number]> = [
    [9, 0, 12, 30],
    [13, 30, 18, 0],
  ];
  const startYmd = localYmd(start, timezone);
  const endYmd = localYmd(end, timezone);
  const sameDay =
    startYmd.y === endYmd.y && startYmd.m === endYmd.m && startYmd.d === endYmd.d;
  let total = 0;
  let cur = startYmd;
  for (let safety = 0; safety < 1000; safety++) {
    const wd = localWeekday(cur.y, cur.m, cur.d, timezone);
    const isSunday = wd === "Sun";
    const isSaturday = wd === "Sat";
    const satIsWorking = isSaturday && workingSaturdays.has(ymdKey(cur));
    const skipDay = !sameDay && (isSunday || (isSaturday && !satIsWorking));
    if (!skipDay) {
      for (const [sh, sm, eh, em] of WINDOWS) {
        const ws = tzInstant(cur.y, cur.m, cur.d, sh, sm, timezone).getTime();
        const we = tzInstant(cur.y, cur.m, cur.d, eh, em, timezone).getTime();
        const lo = Math.max(ws, start.getTime());
        const hi = Math.min(we, end.getTime());
        if (hi > lo) total += hi - lo;
      }
    }
    if (cur.y === endYmd.y && cur.m === endYmd.m && cur.d === endYmd.d) break;
    const nextMidnight = tzInstant(cur.y, cur.m, cur.d, 24, 0, timezone);
    cur = localYmd(nextMidnight, timezone);
  }
  return total;
}

export function computeInProgressMetrics(
  changelog: JiraChangelogEntry[],
  _statusMeta: Map<string, StatusMeta>,
  finishedAt: Date,
  timezone: string,
  workingSaturdays: Set<string> = new Set(),
): { hours: number | null; currentEnteredAt: Date | null } {
  const transitions = changelog
    .flatMap((h) =>
      h.items
        .filter((i) => i.field === "status")
        .map((i) => ({ at: new Date(h.created), from: i.fromString, to: i.toString })),
    )
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  if (transitions.length === 0) return { hours: null, currentEnteredAt: null };

  let totalMs = 0;
  let enterAt: Date | null = null;
  let everInProgress = false;

  const isInProgressName = (name: string | null): boolean =>
    !!name && /in.?progress|đang.?(xử.?lý|làm)/i.test(name);

  for (const t of transitions) {
    if (isInProgressName(t.to)) {
      if (enterAt === null) enterAt = t.at;
      everInProgress = true;
    } else if (enterAt !== null) {
      totalMs += businessHoursMs(enterAt, t.at, timezone, workingSaturdays);
      enterAt = null;
    }
  }

  const currentEnteredAt = enterAt;
  if (enterAt !== null) {
    totalMs += businessHoursMs(enterAt, finishedAt, timezone, workingSaturdays);
  }

  if (!everInProgress) return { hours: null, currentEnteredAt: null };
  const hours =
    totalMs <= 0 ? 0 : Math.max(1, Math.round(totalMs / 3_600_000));
  return { hours, currentEnteredAt };
}

/**
 * Fetch changelogs for the given issue keys (with cache). Allows callers to
 * reuse the same changelog data across detection + per-task hour computation.
 */
export async function prefetchChangelogs(
  client: AxiosInstance,
  keys: string[],
  cache: Map<string, JiraChangelogEntry[]> = new Map(),
): Promise<Map<string, JiraChangelogEntry[]>> {
  for (const key of keys) {
    if (cache.has(key)) continue;
    try {
      cache.set(key, await getIssueChangelog(client, key));
    } catch (err) {
      logger.warn({ key, err: (err as Error).message }, "changelog prefetch failed");
      cache.set(key, []);
    }
  }
  return cache;
}

export async function fetchCompletedInWindow(
  client: AxiosInstance,
  expandedIssues: JiraIssue[],
  since: Date,
  until: Date,
  statusMeta: Map<string, StatusMeta>,
  timezone: string,
  workingSaturdays: Set<string> = new Set(),
  changelogCache?: Map<string, JiraChangelogEntry[]>,
): Promise<SprintDigestTask[]> {
  const candidates = expandedIssues.filter((i) => {
    if (hasSubtasks(i)) return false;
    const rd = i.fields.resolutiondate;
    if (!rd) return false;
    const at = new Date(rd);
    if (!(at >= since && at <= until)) return false;
    // Always sanity-check via status category (current). A task with a
    // resolutiondate but currently re-opened can be filtered out cheaply.
    if (i.fields.status.statusCategory.key !== "done") return false;
    return true;
  });

  const tasks: SprintDigestTask[] = [];
  for (const issue of candidates) {
    let hours: number | null = null;
    try {
      const changelog =
        changelogCache?.get(issue.key) ?? (await getIssueChangelog(client, issue.key));
      const finishedAt = issue.fields.resolutiondate
        ? new Date(issue.fields.resolutiondate)
        : until;
      hours = computeInProgressMetrics(
        changelog,
        statusMeta,
        finishedAt,
        timezone,
        workingSaturdays,
      ).hours;
    } catch (err) {
      logger.warn({ key: issue.key, err: (err as Error).message }, "changelog fetch failed");
    }
    tasks.push(toTask(issue, hours));
  }

  const labelKey = (t: SprintDigestTask) => (t.labels[0] ?? "").toLowerCase();
  tasks.sort((a, b) => labelKey(a).localeCompare(labelKey(b)) || a.key.localeCompare(b.key));
  return tasks;
}

/**
 * Compute how long each in-progress task has been sitting in "In Progress"
 * (wall-clock), mutating `hoursInProgress` on the task in place.
 */
export async function enrichInProgressHours(
  client: AxiosInstance,
  tasks: SprintDigestTask[],
  statusMeta: Map<string, StatusMeta>,
  now: Date,
  timezone: string,
  workingSaturdays: Set<string> = new Set(),
  changelogCache?: Map<string, JiraChangelogEntry[]>,
): Promise<void> {
  for (const t of tasks) {
    try {
      const changelog =
        changelogCache?.get(t.key) ?? (await getIssueChangelog(client, t.key));
      const m = computeInProgressMetrics(changelog, statusMeta, now, timezone, workingSaturdays);
      t.hoursInProgress = m.hours;
      t.inProgressSince = m.currentEnteredAt?.toISOString() ?? null;
    } catch (err) {
      logger.warn(
        { key: t.key, err: (err as Error).message },
        "in-progress changelog fetch failed",
      );
    }
  }
}

/**
 * Build leaderboard input across the entire sprint: every done issue, except
 * parents that have subtasks (those are credited via their subtasks instead).
 *
 * The `sprint = X` JQL does not necessarily return subtasks, so we pull them
 * via a separate `key in (...)` query for any parent that has subtasks.
 */
export async function fetchSprintLeaderboardTasks(
  client: AxiosInstance,
  expandedIssues: JiraIssue[],
  statusMeta: Map<string, StatusMeta>,
  fallbackFinishedAt: Date,
  timezone: string,
  workingSaturdays: Set<string> = new Set(),
  changelogCache?: Map<string, JiraChangelogEntry[]>,
  asOf?: Date,
): Promise<SprintDigestTask[]> {
  const candidates = expandedIssues.filter((i) => {
    if (hasSubtasks(i)) return false;
    if (asOf) {
      const rd = i.fields.resolutiondate
        ? new Date(i.fields.resolutiondate).getTime()
        : null;
      if (rd === null || rd > asOf.getTime()) return false;
      const createdAt = i.fields.created ? new Date(i.fields.created) : null;
      const histStatus = statusAt(
        changelogCache?.get(i.key) ?? [],
        i.fields.status.name,
        createdAt,
        asOf,
      );
      return histStatus !== null && categoryFor(histStatus, statusMeta) === "done";
    }
    return i.fields.status.statusCategory.key === "done";
  });

  const out: SprintDigestTask[] = [];
  for (const issue of candidates) {
    let hours: number | null = null;
    try {
      const changelog =
        changelogCache?.get(issue.key) ?? (await getIssueChangelog(client, issue.key));
      const finishedAt = issue.fields.resolutiondate
        ? new Date(issue.fields.resolutiondate)
        : fallbackFinishedAt;
      hours = computeInProgressMetrics(
        changelog,
        statusMeta,
        finishedAt,
        timezone,
        workingSaturdays,
      ).hours;
    } catch (err) {
      logger.warn(
        { key: issue.key, err: (err as Error).message },
        "leaderboard changelog fetch failed",
      );
    }
    out.push(toTask(issue, hours));
  }
  return out;
}

export interface SprintBuckets {
  todo: SprintDigestTask[];
  inProgress: SprintDigestTask[];
  done: SprintDigestTask[];
}

/**
 * Reconstruct an issue's status name as of `asOf`, using its changelog.
 * Returns `null` if the issue was created strictly after `asOf` (didn't exist yet).
 *
 * Algorithm: sort status transitions by time. Walk forward; the last
 * transition whose `created < asOf` gives the historical status (`toString`).
 * If no transitions occurred before `asOf`, the status equals the `fromString`
 * of the earliest transition (= original status). If there are no status
 * transitions at all, the issue has been in `currentStatus` since creation.
 */
export function statusAt(
  changelog: JiraChangelogEntry[],
  currentStatus: string,
  createdAt: Date | null,
  asOf: Date,
): string | null {
  if (createdAt && createdAt.getTime() > asOf.getTime()) return null;
  const transitions = changelog
    .flatMap((h) =>
      h.items
        .filter((i) => i.field === "status")
        .map((i) => ({
          at: new Date(h.created),
          from: i.fromString,
          to: i.toString,
        })),
    )
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  if (transitions.length === 0) return currentStatus;
  let last: { from: string | null; to: string | null } | null = null;
  for (const t of transitions) {
    if (t.at.getTime() < asOf.getTime()) last = t;
    else break;
  }
  if (last) return last.to ?? currentStatus;
  return transitions[0]!.from ?? currentStatus;
}

function categoryFor(
  statusName: string,
  statusMeta: Map<string, StatusMeta>,
): "new" | "indeterminate" | "done" {
  return statusMeta.get(statusName)?.category ?? "new";
}

/**
 * Snapshot version of bucketSprintIssues: uses the changelog cache to figure
 * out each issue's status category as of `asOf`, instead of trusting the
 * current `fields.status`. Issues created after `asOf` are dropped entirely.
 */
export function bucketSprintIssuesAt(
  issues: JiraIssue[],
  statusMeta: Map<string, StatusMeta>,
  changelogCache: Map<string, JiraChangelogEntry[]>,
  asOf: Date,
): SprintBuckets {
  const todo: SprintDigestTask[] = [];
  const inProgress: SprintDigestTask[] = [];
  const done: SprintDigestTask[] = [];

  for (const issue of issues) {
    if (hasSubtasks(issue)) continue;
    const createdAt = issue.fields.created ? new Date(issue.fields.created) : null;
    const histStatus = statusAt(
      changelogCache.get(issue.key) ?? [],
      issue.fields.status.name,
      createdAt,
      asOf,
    );
    if (histStatus === null) continue;
    const cat = categoryFor(histStatus, statusMeta);
    const task = toTask(issue);
    task.status = histStatus;
    if (cat === "done") {
      const rd = issue.fields.resolutiondate
        ? new Date(issue.fields.resolutiondate).getTime()
        : null;
      // Only count as done if resolutiondate is also before asOf. A task can
      // currently have "Done" status name but with no resolution captured
      // before asOf (e.g. status name reused). Be conservative: require rd < asOf.
      if (rd !== null && rd <= asOf.getTime()) done.push(task);
      else inProgress.push(task); // treat as still active at asOf
    } else if (cat === "indeterminate") {
      inProgress.push(task);
    } else {
      todo.push(task);
    }
  }

  const labelKey = (t: SprintDigestTask) => (t.labels[0] ?? "").toLowerCase();
  const sorter = (a: SprintDigestTask, b: SprintDigestTask) =>
    Number(b.blocked) - Number(a.blocked) ||
    labelKey(a).localeCompare(labelKey(b)) ||
    a.key.localeCompare(b.key);
  todo.sort(sorter);
  inProgress.sort(sorter);

  return { todo, inProgress, done };
}

export function bucketSprintIssues(issues: JiraIssue[]): SprintBuckets {
  const todo: SprintDigestTask[] = [];
  const inProgress: SprintDigestTask[] = [];
  const done: SprintDigestTask[] = [];

  for (const issue of issues) {
    if (hasSubtasks(issue)) continue;
    const cat = issue.fields.status.statusCategory.key;
    const task = toTask(issue);
    if (cat === "done") done.push(task);
    else if (cat === "indeterminate") inProgress.push(task);
    else todo.push(task);
  }

  const labelKey = (t: SprintDigestTask) => (t.labels[0] ?? "").toLowerCase();
  const sorter = (a: SprintDigestTask, b: SprintDigestTask) =>
    Number(b.blocked) - Number(a.blocked) ||
    labelKey(a).localeCompare(labelKey(b)) ||
    a.key.localeCompare(b.key);
  todo.sort(sorter);
  inProgress.sort(sorter);

  return { todo, inProgress, done };
}

export function sprintDayInfo(sprint: JiraSprint, now: Date): { day: number; total: number } {
  if (!sprint.startDate || !sprint.endDate) return { day: 0, total: 0 };
  const start = new Date(sprint.startDate).getTime();
  const end = new Date(sprint.endDate).getTime();
  const total = Math.max(1, Math.ceil((end - start) / 86_400_000));
  const day = Math.max(1, Math.min(total, Math.ceil((now.getTime() - start) / 86_400_000)));
  return { day, total };
}

export { loadStatusCategoryMap };
