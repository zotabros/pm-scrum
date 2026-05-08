import axios from "axios";
import { parseArgs } from "node:util";
import { loadConfig, loadEnv } from "./config.js";
import { logger } from "./logger.js";
import { getWindow, isWeekday } from "./window.js";
import { formatDigest, splitMessage } from "./format.js";
import { sendTelegramMessage, sendTelegramPhoto } from "./telegram.js";
import { reload as reloadSubscriptions } from "./storage/subscriptions.js";
import { buildDigest, resolveProjectSprintList } from "./digest.js";
import type { Env } from "./config.js";

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
  const env: Env = loadEnv();
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
  const projects = await resolveProjectSprintList(env, config, { filterKey: cli.project });
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
