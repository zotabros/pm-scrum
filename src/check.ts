import { loadConfig, loadEnv, resolveJiraCreds } from "./config.js";
import { createJiraClient } from "./jira/client.js";
import { getBotInfo, sendTelegramMessage } from "./telegram.js";
import { logger } from "./logger.js";
import { reload, getChats } from "./storage/subscriptions.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const config = loadConfig();
  reload();

  logger.info("checking Jira auth...");
  const jira = createJiraClient(resolveJiraCreds(env));
  const { data: me } = await jira.get("/rest/api/3/myself");
  logger.info({ accountId: me.accountId, email: me.emailAddress }, "jira OK");

  logger.info("checking Telegram bot...");
  const bot = await getBotInfo(env.TELEGRAM_BOT_TOKEN);
  logger.info(bot, "telegram bot OK");

  logger.info("sending ping to first subscribed chat...");
  const first = config.projects.find((p) => getChats(p.key).length > 0);
  if (!first) {
    logger.warn("no projects with subscribers, skipping ping");
    return;
  }
  const chatId = getChats(first.key)[0]!;
  await sendTelegramMessage(
    { botToken: env.TELEGRAM_BOT_TOKEN },
    chatId,
    "✅ scrum\\-digest ready",
  );
  logger.info({ chatId }, "ping sent");
}

main().catch((err) => {
  logger.error({ err: (err as Error).message }, "check failed");
  process.exit(1);
});
