import { loadEnv } from "../src/config.js";
import { setWebhook, deleteWebhook, getWebhookInfo } from "../src/telegram.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const arg = process.argv[2];
  if (!arg) {
    console.error("Usage: tsx scripts/set-webhook.ts <publicBaseUrl> | --delete | --info");
    process.exit(1);
  }
  const tg = { botToken: env.TELEGRAM_BOT_TOKEN };

  if (arg === "--info") {
    const info = await getWebhookInfo(tg);
    console.log(JSON.stringify(info, null, 2));
    return;
  }
  if (arg === "--delete") {
    await deleteWebhook(tg);
    console.log("webhook deleted");
    return;
  }
  if (!env.TELEGRAM_WEBHOOK_SECRET) {
    console.error("TELEGRAM_WEBHOOK_SECRET is required");
    process.exit(1);
  }
  const base = arg.replace(/\/$/, "");
  const url = `${base}/telegram/webhook/${env.TELEGRAM_WEBHOOK_SECRET}`;
  await setWebhook(tg, url, { drop_pending_updates: true });
  console.log(`webhook set to ${url}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
