import type { Config, Env } from "../config.js";
import type {
  InlineKeyboardMarkup,
  TelegramMessage,
} from "../types.js";
import { sendTelegramMessage, type TelegramOptions } from "../telegram.js";
import { listSubscribed } from "../storage/subscriptions.js";
import { isAuthorized, type AuthDeps } from "./auth.js";
import { logger } from "../logger.js";

export function buildProjectKeyboard(
  config: Config,
  chatId: string,
): InlineKeyboardMarkup {
  const subs = listSubscribed(chatId);
  const buttons = config.projects.map((p) => ({
    text: `${subs.has(p.key) ? "✅" : "⚪"} ${p.key}`,
    callback_data: `proj:${p.key}`,
  }));
  // 2 columns for compactness
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

export async function handleProject(
  deps: CommandDeps,
  msg: TelegramMessage,
): Promise<void> {
  if (!msg.from) return;
  const chatId = String(msg.chat.id);
  const ok = await isAuthorized(deps.auth, msg.chat.id, msg.from.id, msg.chat.type);
  if (!ok) {
    await sendTelegramMessage(
      deps.tg,
      chatId,
      "Bạn không có quyền sử dụng lệnh này.",
      { parse_mode: "HTML" },
    );
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
    "Chọn project để đăng ký / huỷ đăng ký nhận report cho nhóm này:",
    { reply_markup: keyboard, parse_mode: "HTML" },
  );
  logger.info({ chatId, user: msg.from.id }, "/project menu sent");
}

export async function handleStart(
  deps: CommandDeps,
  msg: TelegramMessage,
): Promise<void> {
  const chatId = String(msg.chat.id);
  await sendTelegramMessage(
    deps.tg,
    chatId,
    "Bảo Bảo xin chào.\n• /project — chọn project để nhận report định kỳ cho nhóm này\n• /report [dd-mm|dd-mm-yyyy] — xem report ngay (mặc định: hôm nay)",
    { parse_mode: "HTML" },
  );
}
