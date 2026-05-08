import { loadConfig, loadEnv } from "./config.js";
import { logger } from "./logger.js";
import { reload } from "./storage/subscriptions.js";
import { startWebhookServer } from "./bot/webhook.js";
import type { CommandDeps } from "./bot/commands.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const config = loadConfig();
  if (!env.TELEGRAM_WEBHOOK_SECRET) {
    throw new Error("TELEGRAM_WEBHOOK_SECRET is required to run the bot server");
  }
  reload();
  const deps: CommandDeps = {
    tg: { botToken: env.TELEGRAM_BOT_TOKEN },
    config,
    auth: {
      tg: { botToken: env.TELEGRAM_BOT_TOKEN },
      whitelist: env.TELEGRAM_ADMIN_USER_IDS,
    },
  };
  const server = startWebhookServer({
    port: env.TELEGRAM_WEBHOOK_PORT,
    secret: env.TELEGRAM_WEBHOOK_SECRET,
    deps,
  });

  const shutdown = async (sig: string) => {
    logger.info({ sig }, "shutting down");
    try {
      await server.close();
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "close failed");
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error({ err: (err as Error).stack ?? (err as Error).message }, "fatal");
  process.exit(1);
});
