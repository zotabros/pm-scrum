import type { Config, Env } from "./config.js";
import { resolveJiraCreds } from "./config.js";
import { logger } from "./logger.js";
import { getWindow } from "./window.js";
import { createJiraClient } from "./jira/client.js";
import {
  findActiveSprintForProject,
  listProjects,
} from "./jira/discover.js";
import { searchJql } from "./jira/issues.js";
import {
  bucketSprintIssues,
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
import type { JiraSprint, ProjectDigest } from "./types.js";

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
): Promise<{ digest: ProjectDigest; burndownPng: Buffer | null }> {
  const client = createJiraClient(resolveJiraCreds(env, project.jiraInstance));
  const win = getWindow(now, config.timezone);
  const statusMeta = await loadStatusCategoryMap(client);

  const sprintIssues = await searchJql(client, `sprint = ${project.sprint.id}`);
  const expandedIssues = await expandSprintIssuesWithSubtasks(client, sprintIssues);
  const buckets = bucketSprintIssues(expandedIssues);

  const leafKeys = expandedIssues
    .filter((i) => !(i.fields.subtasks && i.fields.subtasks.length > 0))
    .map((i) => i.key);
  const changelogCache = await prefetchChangelogs(client, leafKeys);
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
    now,
    config.timezone,
    workingSaturdays,
    changelogCache,
  );
  const leaderboardTasks = await fetchSprintLeaderboardTasks(
    client,
    expandedIssues,
    statusMeta,
    win.until,
    config.timezone,
    workingSaturdays,
    changelogCache,
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
    leaderboard: computeLeaderboard(leaderboardTasks),
    windowSince: win.since,
    windowUntil: win.until,
    timezone: config.timezone,
  };

  if (config.llm.enabled && env.ANTHROPIC_API_KEY) {
    const runDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: config.timezone,
    }).format(now);
    digest.llmNote = await sprintHealthNote(
      {
        apiKey: env.ANTHROPIC_API_KEY,
        model: config.llm.model,
        language: config.llm.language,
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

  return { digest, burndownPng };
}
