/**
 * One-off: send the 4-message daily report for one project to one chat id.
 * 1. Sprint digest (formatDigest)
 * 2. Burndown chart photo (caption includes a compact "recent additions" block
 *    when there were new tasks in the last 24h)
 * 3. LLM "Điểm cần quan tâm" insight — skipped if disabled/empty
 *
 * Usage: tsx scripts/send-test-report.ts [CHAT_ID] [PROJECT_KEY]
 * Defaults: CHAT_ID=214364685, PROJECT_KEY=SCRUM
 */
import { loadConfig, loadEnv } from "../src/config.js";
import { reload } from "../src/storage/subscriptions.js";
import { buildDigest, resolveProjectSprintList } from "../src/digest.js";
import {
  computeBugStats,
  computeBurnRate,
  computeSprintEndCountdown,
  computeStuckTasks,
  computeUnassignedCount,
  formatDigest,
  formatLlmInsight,
  splitMessage,
  vietnameseWeekday,
} from "../src/format.js";
import { getWindow, startOfDayInTz } from "../src/window.js";
import { dailyBriefNotes } from "../src/llm.js";
import { sendTelegramMessage, sendTelegramPhoto } from "../src/telegram.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const config = loadConfig();
  reload();

  const chatId = process.argv[2] ?? "214364685";
  const projectKey = process.argv[3] ?? "SCRUM";

  const all = await resolveProjectSprintList(env, config, { filterKey: projectKey });
  if (all.length === 0) {
    process.stderr.write(`no active sprint for ${projectKey}\n`);
    process.exit(1);
  }
  const project = { ...all[0]!, chatIds: [chatId] };

  const tg = { botToken: env.TELEGRAM_BOT_TOKEN };
  const now = new Date();
  const runDate = new Intl.DateTimeFormat("en-CA", { timeZone: config.timezone }).format(now);
  const weekdayLabel = vietnameseWeekday(now, config.timezone);
  const win = getWindow(now, config.timezone);
  const windowLabel = win.label === "weekend" ? "Cuối tuần" : "Hôm qua";
  const windowDateLabel =
    win.label === "weekend" ? `${win.sinceLabel} → ${win.untilLabel}` : win.untilLabel;

  process.stderr.write(`building ${project.key} → chat ${chatId}\n`);
  const { digest, burndownPng, burndownCaption } = await buildDigest(
    env,
    config,
    project,
    now,
  );

  // Generate LLM "Điểm cần quan tâm" (briefNotes) for message 4.
  const apiKey = config.llm.api_key ?? env.ANTHROPIC_API_KEY;
  if (config.llm.enabled && apiKey) {
    const asOf = startOfDayInTz(now, config.timezone);
    const countdown = computeSprintEndCountdown(digest.sprint, now, config.timezone);
    const stuck = computeStuckTasks(digest, asOf);
    digest.briefNotes = await dailyBriefNotes(
      {
        apiKey,
        model: config.llm.model,
        language: config.llm.language,
        baseUrl: config.llm.base_url,
      },
      digest,
      runDate,
      {
        unassignedCount: computeUnassignedCount(digest),
        sprintEndCountdown: countdown?.label ?? "không có endDate",
        topPerformers: digest.leaderboard.slice(0, 5),
        stuckTasks: stuck.map((s) => ({
          key: s.task.key,
          summary: s.task.summary,
          owner: s.owner,
          ownerRole: s.ownerRole,
          days: s.days,
        })),
        burnRate: computeBurnRate(digest),
        bugStats: computeBugStats(digest),
      },
    );
  }

  // Msg 1: sprint digest
  const message = formatDigest({ digest, runDate, weekdayLabel, windowLabel, windowDateLabel });
  for (const chunk of splitMessage(message)) {
    await sendTelegramMessage(tg, chatId, chunk);
  }

  // Msg 2: burndown chart
  if (burndownPng) {
    await sendTelegramPhoto(tg, chatId, burndownPng, `burndown-${project.key}.png`, {
      caption: burndownCaption ?? undefined,
      parse_mode: "HTML",
    });
  }

  // Msg 3: LLM insight
  const insight = formatLlmInsight(digest.briefNotes);
  if (insight) {
    for (const chunk of splitMessage(insight)) {
      await sendTelegramMessage(tg, chatId, chunk);
    }
  }

  process.stderr.write(`done ${project.key}\n`);
}

main().catch((err) => {
  process.stderr.write(String((err as Error).stack ?? err) + "\n");
  process.exit(1);
});
