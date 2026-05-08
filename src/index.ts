import axios from "axios";
import { parseArgs } from "node:util";
import { loadConfig, loadEnv, resolveJiraCreds, type Config, type Env } from "./config.js";
import { logger } from "./logger.js";
import { getWindow, isWeekday } from "./window.js";
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
import { computeLeaderboard, formatDigest, splitMessage } from "./format.js";
import { sendTelegramMessage, sendTelegramPhoto } from "./telegram.js";
import { safeBuildBurndownPng } from "./burndown.js";
import { sprintHealthNote } from "./llm.js";
import { reload as reloadSubscriptions, getChats } from "./storage/subscriptions.js";
import type { ProjectDigest, JiraSprint } from "./types.js";

interface Cli {
  dryRun: boolean;
  project?: string;
  date?: string;
}

function parseCli(): Cli {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      project: { type: "string" },
      date: { type: "string" },
    },
    allowPositionals: false,
  });
  return {
    dryRun: Boolean(values["dry-run"]),
    project: values.project,
    date: values.date,
  };
}

interface ResolvedProject {
  key: string;
  chatIds: string[];
  sprint: JiraSprint;
  projectName: string;
  jiraInstance?: string;
}

async function resolveProjectSprintList(
  env: Env,
  config: Config,
  filterKey?: string,
): Promise<ResolvedProject[]> {
  const configured = new Map(
    config.projects.map((p) => [p.key, { jiraInstance: p.jira_instance }]),
  );
  const candidates: Array<{ key: string; name: string; jiraInstance?: string }> = [];

  if (config.auto_discover_all) {
    // Auto-discover only walks the default instance. Per-instance discovery
    // would require iterating every instance referenced in config — YAGNI.
    const defaultClient = createJiraClient(resolveJiraCreds(env));
    const all = await listProjects(defaultClient);
    for (const p of all) candidates.push({ key: p.key, name: p.name });
  } else {
    for (const p of config.projects) {
      candidates.push({ key: p.key, name: p.key, jiraInstance: p.jira_instance });
    }
  }

  const out: ResolvedProject[] = [];
  for (const c of candidates) {
    if (filterKey && c.key !== filterKey) continue;
    const cfg = configured.get(c.key);
    const instance = c.jiraInstance ?? cfg?.jiraInstance;
    const chatIds = getChats(c.key);
    if (chatIds.length === 0) {
      logger.info({ project: c.key }, "no subscribers, skipping");
      continue;
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

async function buildDigest(
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

  // Pre-fetch changelogs for every leaf issue we'll need hours for, then
  // detect which Saturdays the team actually worked from status-change
  // activity. Done before per-task computation so all paths see the same set.
  const leafKeys = expandedIssues
    .filter((i) => !(i.fields.subtasks && i.fields.subtasks.length > 0))
    .map((i) => i.key);
  const changelogCache = await prefetchChangelogs(client, leafKeys);
  const workingSaturdays = detectWorkingSaturdays(
    changelogCache.values(),
    config.timezone,
  );
  if (workingSaturdays.size > 0) {
    logger.info({ project: project.key, workingSaturdays: [...workingSaturdays] }, "working Saturdays detected");
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

async function pingHealthcheck(url?: string): Promise<void> {
  if (!url) return;
  try {
    await axios.get(url, { timeout: 5_000 });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "healthcheck ping failed");
  }
}

async function main(): Promise<void> {
  const cli = parseCli();
  const env = loadEnv();
  const config = loadConfig();
  const now = cli.date ? new Date(`${cli.date}T09:00:00+07:00`) : new Date();

  if (config.run_on_weekdays_only && !isWeekday(now, config.timezone)) {
    logger.info({ date: now.toISOString() }, "not a weekday, exiting");
    return;
  }

  const win = getWindow(now, config.timezone);
  const weekdayLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: config.timezone,
    weekday: "short",
  }).format(now);
  const runDate = new Intl.DateTimeFormat("en-CA", { timeZone: config.timezone }).format(now);

  const windowLabel = win.label === "weekend" ? "Cuối tuần" : "Hôm qua";
  const windowDateLabel =
    win.label === "weekend" ? `${win.sinceLabel} → ${win.untilLabel}` : win.untilLabel;

  logger.info({ runDate, weekdayLabel, window: win.label }, "starting run");

  reloadSubscriptions();
  const projects = await resolveProjectSprintList(env, config, cli.project);
  logger.info({ count: projects.length }, "projects with active sprints");

  let successCount = 0;
  for (const p of projects) {
    try {
      const { digest, burndownPng } = await buildDigest(env, config, p, now);
      const message = formatDigest({
        digest,
        runDate,
        weekdayLabel,
        windowLabel,
        windowDateLabel,
      });
      if (cli.dryRun) {
        process.stdout.write(
          `\n===== ${p.key} -> [${p.chatIds.join(", ")}] =====\n${message}\n`,
        );
        if (burndownPng) {
          process.stdout.write(`[burndown png: ${burndownPng.byteLength} bytes]\n`);
        }
      } else {
        for (const chatId of p.chatIds) {
          try {
            for (const chunk of splitMessage(message)) {
              await sendTelegramMessage({ botToken: env.TELEGRAM_BOT_TOKEN }, chatId, chunk);
            }
            if (burndownPng) {
              try {
                await sendTelegramPhoto(
                  { botToken: env.TELEGRAM_BOT_TOKEN },
                  chatId,
                  burndownPng,
                  `burndown-${p.key}.png`,
                );
              } catch (err) {
                logger.warn(
                  { project: p.key, chatId, err: (err as Error).message },
                  "burndown photo send failed",
                );
              }
            }
          } catch (err) {
            logger.error(
              { project: p.key, chatId, err: (err as Error).message },
              "send to chat failed",
            );
          }
        }
      }
      successCount += 1;
      logger.info(
        { project: p.key, issues: digest.counts.total, chats: p.chatIds.length },
        "delivered",
      );
    } catch (err) {
      logger.error(
        { project: p.key, err: (err as Error).message },
        "failed to build/send digest",
      );
    }
  }

  await pingHealthcheck(env.HEALTHCHECK_URL);
  logger.info({ successCount, total: projects.length }, "run complete");
  if (successCount === 0 && projects.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  logger.error({ err: (err as Error).stack ?? (err as Error).message }, "fatal");
  process.exit(1);
});
