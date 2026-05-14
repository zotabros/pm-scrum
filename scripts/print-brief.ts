import { loadConfig, loadEnv } from "../src/config.js";
import { reload } from "../src/storage/subscriptions.js";
import { buildDigest, resolveProjectSprintList } from "../src/digest.js";
import {
  computeBugStats,
  computeBurnRate,
  computeSprintEndCountdown,
  computeStuckTasks,
  computeUnassignedCount,
  escapeMd,
  formatCompletedSection,
  formatDailyBrief,
  formatLlmInsight,
} from "../src/format.js";
import { getWindow, startOfDayInTz } from "../src/window.js";
import { dailyBriefNotes } from "../src/llm.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const config = loadConfig();
  reload();

  const arg = process.argv[2];
  const projectFilter = arg && /^[A-Z]+$/.test(arg) ? arg : undefined;

  const projects = await resolveProjectSprintList(env, config, {
    filterKey: projectFilter,
  });
  if (projects.length === 0) {
    process.stderr.write("no projects with active sprint\n");
    process.exit(1);
  }

  const now = new Date();
  const runDate = new Intl.DateTimeFormat("en-CA", { timeZone: config.timezone }).format(now);

  for (const p of projects) {
    const { digest } = await buildDigest(env, config, p, now);

    const apiKey = config.llm.api_key ?? env.ANTHROPIC_API_KEY;
    if (config.llm.enabled && apiKey) {
      const countdown = computeSprintEndCountdown(digest.sprint, now, config.timezone);
      const stuck = computeStuckTasks(digest, startOfDayInTz(now, config.timezone));
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

    const brief = formatDailyBrief({
      digest,
      runDate,
      now,
      timezone: config.timezone,
    });

    const win = getWindow(now, config.timezone);
    const windowLabel = win.label === "weekend" ? "Cuối tuần" : "Hôm qua";
    const windowDateLabel =
      win.label === "weekend" ? `${win.sinceLabel} → ${win.untilLabel}` : win.untilLabel;
    const completed = formatCompletedSection(digest, windowLabel, windowDateLabel);
    const message1 = completed ? `${brief}\n\n${completed}` : brief;
    const message3 = formatLlmInsight(digest.briefNotes);

    process.stdout.write(
      `\n===== ${p.key} (${p.projectName}) =====\n` +
        `\n--- MESSAGE 1 (brief + Đã hoàn thành) ---\n${message1}\n` +
        `\n--- MESSAGE 2 (burndown chart) ---\n[burndown PNG sent as photo — caption below]\n${escapeMd("(see /chart output)")}\n` +
        `\n--- MESSAGE 3 (LLM insight) ---\n${message3 || "[bỏ qua — LLM disabled hoặc lỗi]"}\n`,
    );
  }
}

main().catch((err) => {
  process.stderr.write(String((err as Error).stack ?? err) + "\n");
  process.exit(1);
});
