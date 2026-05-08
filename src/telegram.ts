import axios, { AxiosError } from "axios";
import { logger } from "./logger.js";
import type { InlineKeyboardMarkup } from "./types.js";

export interface TelegramOptions {
  botToken: string;
}

type TgError = AxiosError<{
  description?: string;
  parameters?: { retry_after?: number };
}>;

async function callBotApi<T = unknown>(
  opts: TelegramOptions,
  method: string,
  body: Record<string, unknown>,
  timeoutMs = 20_000,
): Promise<T> {
  const url = `https://api.telegram.org/bot${opts.botToken}/${method}`;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const { data } = await axios.post(url, body, { timeout: timeoutMs });
      return data.result as T;
    } catch (err) {
      const axiosErr = err as TgError;
      const status = axiosErr.response?.status;
      const data = axiosErr.response?.data;
      if (status === 429 && data?.parameters?.retry_after) {
        const wait = data.parameters.retry_after * 1000;
        logger.warn({ method, wait }, "telegram 429, sleeping");
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (attempt < 3 && (!status || status >= 500)) {
        const backoff = 500 * 2 ** (attempt - 1);
        logger.warn({ method, attempt, status }, "telegram retry");
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      logger.error(
        { method, status, desc: data?.description, attempt },
        "telegram call failed",
      );
      throw err;
    }
  }
}

export async function sendTelegramMessage(
  opts: TelegramOptions,
  chatId: string,
  text: string,
  extra: { reply_markup?: InlineKeyboardMarkup; parse_mode?: string } = {},
): Promise<void> {
  await callBotApi(opts, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: extra.parse_mode ?? "MarkdownV2",
    disable_web_page_preview: true,
    reply_markup: extra.reply_markup,
  });
}

export async function sendTelegramPhoto(
  opts: TelegramOptions,
  chatId: string,
  photo: Buffer,
  filename = "burndown.png",
): Promise<void> {
  const url = `https://api.telegram.org/bot${opts.botToken}/sendPhoto`;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const form = new FormData();
    form.append("chat_id", chatId);
    form.append(
      "photo",
      new Blob([new Uint8Array(photo)], { type: "image/png" }),
      filename,
    );
    try {
      await axios.post(url, form, { timeout: 30_000 });
      return;
    } catch (err) {
      const axiosErr = err as TgError;
      const status = axiosErr.response?.status;
      const data = axiosErr.response?.data;
      if (status === 429 && data?.parameters?.retry_after) {
        const wait = data.parameters.retry_after * 1000;
        logger.warn({ chatId, wait }, "telegram 429 (photo), sleeping");
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (attempt < 3 && (!status || status >= 500)) {
        const backoff = 500 * 2 ** (attempt - 1);
        logger.warn({ chatId, attempt, status }, "telegram photo retry");
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      logger.error(
        { chatId, status, desc: data?.description, attempt },
        "telegram photo send failed",
      );
      throw err;
    }
  }
}

export async function getBotInfo(botToken: string): Promise<{ id: number; username: string }> {
  const { data } = await axios.get(`https://api.telegram.org/bot${botToken}/getMe`, {
    timeout: 10_000,
  });
  return { id: data.result.id, username: data.result.username };
}

export async function answerCallbackQuery(
  opts: TelegramOptions,
  callbackQueryId: string,
  text?: string,
  showAlert = false,
): Promise<void> {
  await callBotApi(opts, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
    show_alert: showAlert,
  });
}

export async function editMessageReplyMarkup(
  opts: TelegramOptions,
  chatId: number | string,
  messageId: number,
  replyMarkup: InlineKeyboardMarkup,
): Promise<void> {
  try {
    await callBotApi(opts, "editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: replyMarkup,
    });
  } catch (err) {
    const desc = (err as TgError).response?.data?.description ?? "";
    if (desc.includes("message is not modified")) return;
    throw err;
  }
}

export interface ChatMember {
  status: "creator" | "administrator" | "member" | "restricted" | "left" | "kicked";
  user: { id: number };
}

export async function getChatMember(
  opts: TelegramOptions,
  chatId: number | string,
  userId: number,
): Promise<ChatMember> {
  return callBotApi<ChatMember>(opts, "getChatMember", {
    chat_id: chatId,
    user_id: userId,
  });
}

export async function sendChatAction(
  opts: TelegramOptions,
  chatId: string,
  action:
    | "typing"
    | "upload_photo"
    | "upload_document" = "typing",
): Promise<void> {
  try {
    await callBotApi(opts, "sendChatAction", { chat_id: chatId, action }, 5_000);
  } catch {
    // best-effort; never fail the parent task because of a typing ping
  }
}

/**
 * Begin a typing indicator that auto-refreshes every 4s (Telegram clears it
 * after ~5s). Returns a stop() to clear the interval; the indicator fades on
 * its own once we stop pinging.
 */
export function startTypingIndicator(
  opts: TelegramOptions,
  chatId: string,
  action: "typing" | "upload_photo" = "typing",
): () => void {
  void sendChatAction(opts, chatId, action);
  const handle = setInterval(() => {
    void sendChatAction(opts, chatId, action);
  }, 4_000);
  return () => clearInterval(handle);
}

export async function setWebhook(
  opts: TelegramOptions,
  url: string,
  options: { drop_pending_updates?: boolean } = {},
): Promise<void> {
  await callBotApi(opts, "setWebhook", {
    url,
    drop_pending_updates: options.drop_pending_updates ?? false,
    allowed_updates: ["message", "callback_query"],
  });
}

export async function deleteWebhook(opts: TelegramOptions): Promise<void> {
  await callBotApi(opts, "deleteWebhook", {});
}

export async function getWebhookInfo(opts: TelegramOptions): Promise<{ url: string; pending_update_count: number }> {
  return callBotApi(opts, "getWebhookInfo", {});
}
