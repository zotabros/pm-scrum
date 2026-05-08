import type { TelegramCallbackQuery } from "../types.js";
import {
  answerCallbackQuery,
  editMessageReplyMarkup,
} from "../telegram.js";
import { toggle } from "../storage/subscriptions.js";
import { isAuthorized } from "./auth.js";
import { buildProjectKeyboard, type CommandDeps } from "./commands.js";
import { logger } from "../logger.js";

export async function handleProjectToggle(
  deps: CommandDeps,
  cb: TelegramCallbackQuery,
): Promise<void> {
  const data = cb.data ?? "";
  if (!data.startsWith("proj:")) return;
  const projectKey = data.slice("proj:".length);
  const message = cb.message;
  if (!message) {
    await answerCallbackQuery(deps.tg, cb.id, "Tin nhắn đã hết hạn");
    return;
  }
  const chatId = String(message.chat.id);

  const known = deps.config.projects.find((p) => p.key === projectKey);
  if (!known) {
    await answerCallbackQuery(deps.tg, cb.id, `Project ${projectKey} không tồn tại`, true);
    return;
  }

  const ok = await isAuthorized(deps.auth, message.chat.id, cb.from.id, message.chat.type);
  if (!ok) {
    await answerCallbackQuery(deps.tg, cb.id, "Bạn không có quyền", true);
    return;
  }

  const { subscribed } = await toggle(projectKey, chatId);
  const toast = subscribed
    ? `Đã đăng ký nhận report ${projectKey}`
    : `Đã huỷ đăng ký ${projectKey}`;
  await answerCallbackQuery(deps.tg, cb.id, toast);
  await editMessageReplyMarkup(
    deps.tg,
    message.chat.id,
    message.message_id,
    buildProjectKeyboard(deps.config, chatId),
  );
  logger.info({ chatId, projectKey, subscribed, user: cb.from.id }, "subscription toggled");
}
