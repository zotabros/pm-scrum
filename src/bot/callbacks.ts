import type { TelegramCallbackQuery } from "../types.js";
import {
  answerCallbackQuery,
  editMessageReplyMarkup,
} from "../telegram.js";
import { toggle } from "../storage/subscriptions.js";
import { isAdmin } from "./auth.js";
import { buildProjectKeyboard, displayName, type CommandDeps } from "./commands.js";
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

  if (!isAdmin(deps.auth, cb.from.id)) {
    await answerCallbackQuery(
      deps.tg,
      cb.id,
      "Chỉ admin mới được thay đổi đăng ký",
      true,
    );
    return;
  }

  const { subscribed, previous } = await toggle(projectKey, chatId);
  const nameOf = (k: string) => displayName(deps.config, deps.projectNames, k);
  let toast: string;
  if (!subscribed) {
    toast = `Đã huỷ đăng ký ${nameOf(projectKey)}`;
  } else if (previous && previous !== projectKey) {
    toast = `Đã chuyển từ ${nameOf(previous)} sang ${nameOf(projectKey)}`;
  } else {
    toast = `Đã đăng ký ${nameOf(projectKey)}`;
  }
  await answerCallbackQuery(deps.tg, cb.id, toast);
  await editMessageReplyMarkup(
    deps.tg,
    message.chat.id,
    message.message_id,
    buildProjectKeyboard(deps.config, deps.projectNames, chatId),
  );
  logger.info(
    { chatId, projectKey, subscribed, previous, user: cb.from.id },
    "subscription toggled",
  );
}
