import type { Config, Env } from "../config.js";
import type {
  InlineKeyboardMarkup,
  TelegramMessage,
} from "../types.js";
import { sendTelegramMessage, type TelegramOptions } from "../telegram.js";
import { getChatProject } from "../storage/subscriptions.js";
import { isAdmin, isAllowedChat, type AuthDeps } from "./auth.js";
import { logger } from "../logger.js";
import type { ProjectNameMap } from "./project-names.js";

export function displayName(
  config: Config,
  projectNames: ProjectNameMap,
  key: string,
): string {
  return (
    projectNames.get(key) ??
    config.projects.find((p) => p.key === key)?.name ??
    key
  );
}

export function buildProjectKeyboard(
  config: Config,
  projectNames: ProjectNameMap,
  chatId: string,
): InlineKeyboardMarkup {
  const current = getChatProject(chatId);
  const buttons = config.projects.map((p) => ({
    text: `${current === p.key ? "✅" : "⚪"} ${displayName(config, projectNames, p.key)}`,
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
  projectNames: ProjectNameMap;
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
  const keyboard = buildProjectKeyboard(deps.config, deps.projectNames, chatId);
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
  const greeting = [
    "👋 Xin chào mọi người, mình là Bảo Bảo đây! 🌱",
    "",
    'Sự <b>"trưởng thành AGILE"</b> đến từ chính thói quen hàng ngày của team mình:',
    "",
    "<b>Nhìn lại - Điều chỉnh - Tiến lên.</b>",
    "",
    "Mình sẽ đóng vai trò người đồng hành, giúp team duy trì nhịp độ report đều đặn và đầy đủ nhé. Tụi mình ưu tiên làm đúng, làm chất và cùng nhau trưởng thành qua mỗi nhé 🚀",
  ];
  if (isUserAdmin) {
    greeting.push("", "Chọn dự án bên dưới để Bảo Bảo gửi report hàng ngày nhé!");
  }

  const text = greeting.join("\n");
  if (isUserAdmin && deps.config.projects.length > 0) {
    const keyboard = buildProjectKeyboard(deps.config, deps.projectNames, chatId);
    await sendTelegramMessage(deps.tg, chatId, text, {
      reply_markup: keyboard,
      parse_mode: "HTML",
    });
  } else {
    await sendTelegramMessage(deps.tg, chatId, text, { parse_mode: "HTML" });
  }
}
