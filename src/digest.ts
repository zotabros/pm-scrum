import type { Config, Env } from "./config.js";
import { resolveJiraCreds } from "./config.js";
import { logger } from "./logger.js";
import { getWindow, startOfDayInTz } from "./window.js";
import { createJiraClient } from "./jira/client.js";
import {
  findActiveSprintForProject,
  listProjects,
} from "./jira/discover.js";
import { searchJql } from "./jira/issues.js";
import {
  bucketSprintIssuesAt,
  detectWorkingSaturdays,
  enrichInProgressHours,
  expandSprintIssuesWithSubtasks,
  fetchCompletedInWindow,
  fetchSprintLeaderboardTasks,
  loadStatusCategoryMap,
  prefetchChangelogs,
  sprintDayInfo,
} from "./aggregate.js";
import { computeLeaderboard } from "./format.js";
import { safeBuildBurndownPng } from "./burndown.js";
import { sprintHealthNote } from "./llm.js";
import { getChats, listSubscribed } from "./storage/subscriptions.js";
import type { JiraIssue, JiraSprint, ProjectDigest } from "./types.js";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildBurndownCaption(leafIssues: JiraIssue[], now: Date): string {
  const unfinished = leafIssues.filter((i) => {
    const res = i.fields.resolutiondate;
    if (!res) return true;
    const t = new Date(res).getTime();
    return !Number.isFinite(t) || t > now.getTime();
  });
  if (unfinished.length === 0) {
    return "📊 <b>Đã hoàn thành toàn bộ task của sprint.</b>";
  }
  const counts = new Map<string, number>();
  for (const i of unfinished) {
    const type = i.fields.issuetype?.name?.trim() || "Khác";
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([type, n]) => `${n} x ${escapeHtml(type)}`);
  return `📊 <b>Còn lại: ${unfinished.length} task</b>\n${parts.join(" • ")}`;
}

export interface ResolvedProject {
  key: string;
  chatIds: string[];
  sprint: JiraSprint;
  projectName: string;
  jiraInstance?: string;
}

export interface ResolveOptions {
  filterKey?: string;
  /** When set, only include projects subscribed by this chat, and the resulting chatIds is just [filterChatId]. */
  filterChatId?: string;
  /** Optional override for the project display name. Falls back to config name, then key. */
  projectNames?: Map<string, string>;
}

export async function resolveProjectSprintList(
  env: Env,
  config: Config,
  opts: ResolveOptions = {},
): Promise<ResolvedProject[]> {
  const configured = new Map(
    config.projects.map((p) => [p.key, { jiraInstance: p.jira_instance }]),
  );
  const candidates: Array<{ key: string; name: string; jiraInstance?: string }> = [];

  if (config.auto_discover_all) {
    const defaultClient = createJiraClient(resolveJiraCreds(env));
    const all = await listProjects(defaultClient);
    for (const p of all) candidates.push({ key: p.key, name: p.name });
  } else {
    for (const p of config.projects) {
      candidates.push({
        key: p.key,
        name: opts.projectNames?.get(p.key) ?? p.name ?? p.key,
        jiraInstance: p.jira_instance,
      });
    }
  }

  const subscribedSet = opts.filterChatId
    ? listSubscribed(opts.filterChatId)
    : null;

  const out: ResolvedProject[] = [];
  for (const c of candidates) {
    if (opts.filterKey && c.key !== opts.filterKey) continue;
    const cfg = configured.get(c.key);
    const instance = c.jiraInstance ?? cfg?.jiraInstance;

    let chatIds: string[];
    if (subscribedSet) {
      if (!subscribedSet.has(c.key)) continue;
      chatIds = [opts.filterChatId!];
    } else {
      chatIds = getChats(c.key);
      if (chatIds.length === 0) {
        logger.info({ project: c.key }, "no subscribers, skipping");
        continue;
      }
    }

    const client = createJiraClient(resolveJiraCreds(env, instance));
    const sprint = await findActiveSprintForProject(client, c.key);
    if (!sprint) {
      logger.info({ project: c.key, jiraInstance: instance }, "no active sprint, skipping");
      continue;
    }
    out.push({ key: c.key, chatIds, sprint, projectName: c.name, jiraInstance: instance });
  }
  return out;
}

export async function buildDigest(
  env: Env,
  config: Config,
  project: ResolvedProject,
  now: Date,
): Promise<{
  digest: ProjectDigest;
  burndownPng: Buffer | null;
  burndownCaption: string | null;
}> {
  const client = createJiraClient(resolveJiraCreds(env, project.jiraInstance));
  const win = getWindow(now, config.timezone);
  const statusMeta = await loadStatusCategoryMap(client);

  const sprintIssues = await searchJql(client, `sprint = ${project.sprint.id}`);
  const expandedIssues = await expandSprintIssuesWithSubtasks(client, sprintIssues);

  const leafKeys = expandedIssues
    .filter((i) => !(i.fields.subtasks && i.fields.subtasks.length > 0))
    .map((i) => i.key);
  const changelogCache = await prefetchChangelogs(client, leafKeys);

  // Snapshot cutoff: state as of 00:00 of `now`'s local day. Excludes today's
  // changes so a brief/report for date D reflects end-of-(D-1) state.
  const asOf = startOfDayInTz(now, config.timezone);
  const buckets = bucketSprintIssuesAt(expandedIssues, statusMeta, changelogCache, asOf);
  const workingSaturdays = detectWorkingSaturdays(
    changelogCache.values(),
    config.timezone,
  );
  if (workingSaturdays.size > 0) {
    logger.info(
      { project: project.key, workingSaturdays: [...workingSaturdays] },
      "working Saturdays detected",
    );
  }

  const completed = await fetchCompletedInWindow(
    client,
    expandedIssues,
    win.since,
    win.until,
    statusMeta,
    config.timezone,
    workingSaturdays,
    changelogCache,
  );
  await enrichInProgressHours(
    client,
    buckets.inProgress,
    statusMeta,
    asOf,
    config.timezone,
    workingSaturdays,
    changelogCache,
  );
  const leaderboardTasks = await fetchSprintLeaderboardTasks(
    client,
    expandedIssues,
    statusMeta,
    asOf,
    config.timezone,
    workingSaturdays,
    changelogCache,
    asOf,
  );

  const { day, total } = sprintDayInfo(project.sprint, now);

  const digest: ProjectDigest = {
    projectKey: project.key,
    projectName: project.projectName,
    sprint: project.sprint,
    dayNumber: day,
    totalDays: total,
    counts: {
      todo: buckets.todo.length,
      inProgress: buckets.inProgress.length,
      done: buckets.done.length,
      total: buckets.todo.length + buckets.inProgress.length + buckets.done.length,
    },
    completedInWindow: completed,
    todo: buckets.todo,
    inProgress: buckets.inProgress,
    doneAll: leaderboardTasks,
    leaderboard: computeLeaderboard(leaderboardTasks),
    windowSince: win.since,
    windowUntil: win.until,
    timezone: config.timezone,
  };

  const apiKey = config.llm.api_key ?? env.ANTHROPIC_API_KEY;
  if (config.llm.enabled && apiKey) {
    const runDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: config.timezone,
    }).format(now);
    digest.llmNote = await sprintHealthNote(
      {
        apiKey,
        model: config.llm.model,
        language: config.llm.language,
        baseUrl: config.llm.base_url,
      },
      digest,
      runDate,
    );
  }

  const leafIssues = expandedIssues.filter(
    (i) => !(i.fields.subtasks && i.fields.subtasks.length > 0),
  );
  const burndownTitle = `Burndown — ${project.projectName} — ${project.sprint.name}`;
  const burndownPng = await safeBuildBurndownPng(
    project.sprint,
    leafIssues,
    now,
    config.timezone,
    workingSaturdays,
    burndownTitle,
  );

  const burndownCaption = burndownPng ? buildBurndownCaption(leafIssues, now) : null;

  return { digest, burndownPng, burndownCaption };
}
