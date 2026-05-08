import type { Config, Env } from "../config.js";
import type {
  InlineKeyboardMarkup,
  TelegramMessage,
} from "../types.js";
import { sendTelegramMessage, type TelegramOptions } from "../telegram.js";
import { getChatProject } from "../storage/subscriptions.js";
import { isAdmin, isAllowedChat, type AuthDeps } from "./auth.js";
import { logger } from "../logger.js";

export function buildProjectKeyboard(
  config: Config,
  chatId: string,
): InlineKeyboardMarkup {
  const current = getChatProject(chatId);
  const buttons = config.projects.map((p) => ({
    text: `${current === p.key ? "✅" : "⚪"} ${p.key}`,
    callback_data: `proj:${p.key}`,
  }));
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }
  return { inline_keyboard: rows };
}

export interface CommandDeps {
  tg: TelegramOptions;
  config: Config;
  auth: AuthDeps;
  env: Env;
}

const PRIVATE_NOT_SUPPORTED =
  "Bảo Bảo không hỗ trợ chat riêng. Vui lòng thêm Bảo Bảo vào nhóm để sử dụng.";
const ADMIN_ONLY =
  "Tính năng này chỉ dành cho admin được cấu hình trong hệ thống.";

export async function handleProject(
  deps: CommandDeps,
  msg: TelegramMessage,
): Promise<void> {
  if (!msg.from) return;
  const chatId = String(msg.chat.id);
  if (!isAdmin(deps.auth, msg.from.id)) {
    await sendTelegramMessage(deps.tg, chatId, ADMIN_ONLY, { parse_mode: "HTML" });
    return;
  }
  if (deps.config.projects.length === 0) {
    await sendTelegramMessage(deps.tg, chatId, "Chưa có project nào được cấu hình.", {
      parse_mode: "HTML",
    });
    return;
  }
  const keyboard = buildProjectKeyboard(deps.config, chatId);
  await sendTelegramMessage(
    deps.tg,
    chatId,
    "Chọn 1 project để nhận report cho nhóm này (mỗi nhóm chỉ nhận 1 project tại 1 thời điểm). Bấm lại project đang chọn để huỷ.",
    { reply_markup: keyboard, parse_mode: "HTML" },
  );
  logger.info({ chatId, user: msg.from.id }, "/project menu sent");
}

export async function handleStart(
  deps: CommandDeps,
  msg: TelegramMessage,
): Promise<void> {
  if (!msg.from) return;
  const chatId = String(msg.chat.id);
  if (!isAllowedChat(deps.auth, msg.chat.type, msg.from.id)) {
    await sendTelegramMessage(deps.tg, chatId, PRIVATE_NOT_SUPPORTED, {
      parse_mode: "HTML",
    });
    return;
  }
  const isUserAdmin = isAdmin(deps.auth, msg.from.id);
  const lines = [
    "Bảo Bảo xin chào.",
    "• /report [dd-mm|dd-mm-yyyy] — xem report ngay cho nhóm này (mặc định: hôm nay)",
  ];
  if (isUserAdmin) {
    lines.push("• /project — (admin) chọn project để nhóm này nhận report định kỳ");
  }
  await sendTelegramMessage(deps.tg, chatId, lines.join("\n"), { parse_mode: "HTML" });
}
