import type { TelegramMessage } from "../types.js";
import {
  sendTelegramMessage,
  sendTelegramPhoto,
  startTypingIndicator,
} from "../telegram.js";
import { isAllowedChat } from "./auth.js";
import { logger } from "../logger.js";
import { getWindow } from "../window.js";
import { formatDigest, splitMessage } from "../format.js";
import { buildDigest, resolveProjectSprintList } from "../digest.js";
import { getChatProject } from "../storage/subscriptions.js";
import { displayName, type CommandDeps } from "./commands.js";

const DATE_RE = /^(\d{1,2})-(\d{1,2})(?:-(\d{4}))?$/;

/**
 * Parse a `dd-mm` or `dd-mm-yyyy` string in the configured timezone and return
 * a Date pinned to 09:00 +07:00 of that day (matching the CLI --date convention).
 * Returns null when the input is malformed or represents an invalid calendar date.
 */
export function parseReportDate(
  input: string | undefined,
  now: Date,
  timezone: string,
): Date | null {
  if (!input) {
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
    return new Date(`${today}T09:00:00+07:00`);
  }
  const m = DATE_RE.exec(input.trim());
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const yearPart = m[3];
  let year: number;
  if (yearPart) {
    year = Number(yearPart);
  } else {
    year = Number(
      new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric" }).format(now),
    );
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Validate calendar (e.g. reject 31-02)
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  const yyyy = String(year).padStart(4, "0");
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return new Date(`${yyyy}-${mm}-${dd}T09:00:00+07:00`);
}

function extractDateArg(text: string): string | undefined {
  const parts = text.trim().split(/\s+/);
  return parts.length > 1 ? parts[1] : undefined;
}

export async function handleChart(
  deps: CommandDeps,
  msg: TelegramMessage,
): Promise<void> {
  if (!msg.from || !msg.text) return;
  const chatId = String(msg.chat.id);

  if (!isAllowedChat(deps.auth, msg.chat.type, msg.from.id)) {
    await sendTelegramMessage(
      deps.tg,
      chatId,
      "Bảo Bảo không hỗ trợ chat riêng. Vui lòng thêm Bảo Bảo vào nhóm để sử dụng.",
      { parse_mode: "HTML" },
    );
    return;
  }

  const dateArg = extractDateArg(msg.text);
  const now = parseReportDate(dateArg, new Date(), deps.config.timezone);
  if (!now) {
    await sendTelegramMessage(
      deps.tg,
      chatId,
      "Định dạng ngày không hợp lệ. Hãy dùng <code>/chart</code>, <code>/chart dd-mm</code> hoặc <code>/chart dd-mm-yyyy</code>.",
      { parse_mode: "HTML" },
    );
    return;
  }

  const subscribedKey = getChatProject(chatId);
  if (!subscribedKey) {
    await sendTelegramMessage(
      deps.tg,
      chatId,
      "Nhóm này chưa đăng ký project nào. Hãy dùng /project để đăng ký.",
      { parse_mode: "HTML" },
    );
    return;
  }

  const projects = await resolveProjectSprintList(deps.env, deps.config, {
    filterChatId: chatId,
    projectNames: deps.projectNames,
  });

  if (projects.length === 0) {
    const projectLabel = displayName(deps.config, deps.projectNames, subscribedKey);
    await sendTelegramMessage(
      deps.tg,
      chatId,
      `Dự án <b>${projectLabel}</b> hiện không có sprint nào đang chạy trên Jira. Hãy kiểm tra trạng thái sprint hoặc dùng /project để đổi sang dự án khác.`,
      { parse_mode: "HTML" },
    );
    return;
  }

  logger.info({ chatId, projects: projects.map((p) => p.key) }, "/chart run");

  for (const p of projects) {
    const stopTyping = startTypingIndicator(deps.tg, chatId, "upload_photo");
    try {
      const { burndownPng, burndownCaption } = await buildDigest(deps.env, deps.config, p, now);
      if (!burndownPng) {
        await sendTelegramMessage(
          deps.tg,
          chatId,
          `Không có dữ liệu burndown cho <b>${p.projectName}</b> (sprint thiếu start/end date).`,
          { parse_mode: "HTML" },
        );
        continue;
      }
      await sendTelegramPhoto(
        deps.tg,
        chatId,
        burndownPng,
        `burndown-${p.key}.png`,
        { caption: burndownCaption ?? undefined, parse_mode: "HTML" },
      );
    } catch (err) {
      logger.error(
        { project: p.key, chatId, err: (err as Error).message },
        "/chart build failed",
      );
      await sendTelegramMessage(
        deps.tg,
        chatId,
        `Không tạo được chart cho <b>${p.key}</b>. Lỗi: ${(err as Error).message}`,
        { parse_mode: "HTML" },
      );
    } finally {
      stopTyping();
    }
  }
}

export async function handleReport(
  deps: CommandDeps,
  msg: TelegramMessage,
): Promise<void> {
  if (!msg.from || !msg.text) return;
  const chatId = String(msg.chat.id);

  if (!isAllowedChat(deps.auth, msg.chat.type, msg.from.id)) {
    await sendTelegramMessage(
      deps.tg,
      chatId,
      "Bảo Bảo không hỗ trợ chat riêng. Vui lòng thêm Bảo Bảo vào nhóm để sử dụng.",
      { parse_mode: "HTML" },
    );
    return;
  }

  const dateArg = extractDateArg(msg.text);
  const now = parseReportDate(dateArg, new Date(), deps.config.timezone);
  if (!now) {
    await sendTelegramMessage(
      deps.tg,
      chatId,
      "Định dạng ngày không hợp lệ. Hãy dùng <code>/report</code>, <code>/report dd-mm</code> hoặc <code>/report dd-mm-yyyy</code>.",
      { parse_mode: "HTML" },
    );
    return;
  }

  const subscribedKey = getChatProject(chatId);
  if (!subscribedKey) {
    await sendTelegramMessage(
      deps.tg,
      chatId,
      "Nhóm này chưa đăng ký project nào. Hãy dùng /project để đăng ký.",
      { parse_mode: "HTML" },
    );
    return;
  }

  const projects = await resolveProjectSprintList(deps.env, deps.config, {
    filterChatId: chatId,
    projectNames: deps.projectNames,
  });

  if (projects.length === 0) {
    const projectLabel = displayName(deps.config, deps.projectNames, subscribedKey);
    await sendTelegramMessage(
      deps.tg,
      chatId,
      `Dự án <b>${projectLabel}</b> hiện không có sprint nào đang chạy trên Jira. Hãy kiểm tra trạng thái sprint hoặc dùng /project để đổi sang dự án khác.`,
      { parse_mode: "HTML" },
    );
    return;
  }

  const win = getWindow(now, deps.config.timezone);
  const weekdayLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: deps.config.timezone,
    weekday: "short",
  }).format(now);
  const runDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: deps.config.timezone,
  }).format(now);
  const windowLabel = win.label === "weekend" ? "Cuối tuần" : "Hôm qua";
  const windowDateLabel =
    win.label === "weekend" ? `${win.sinceLabel} → ${win.untilLabel}` : win.untilLabel;

  logger.info({ chatId, runDate, projects: projects.map((p) => p.key) }, "/report run");

  const projectsLabel = projects.map((p) => `<b>${p.projectName}</b>`).join(", ");
  await sendTelegramMessage(
    deps.tg,
    chatId,
    `Bảo Bảo đang tạo report cho dự án ${projectsLabel}. Chờ Bảo Bảo xíu nhé...`,
    { parse_mode: "HTML" },
  );

  for (const p of projects) {
    const stopTyping = startTypingIndicator(deps.tg, chatId, "typing");
    try {
      const { digest, burndownPng, burndownCaption } = await buildDigest(
        deps.env,
        deps.config,
        p,
        now,
      );
      const message = formatDigest({
        digest,
        runDate,
        weekdayLabel,
        windowLabel,
        windowDateLabel,
      });
      for (const chunk of splitMessage(message)) {
        await sendTelegramMessage(deps.tg, chatId, chunk);
      }
      if (burndownPng) {
        const stopUploading = startTypingIndicator(deps.tg, chatId, "upload_photo");
        try {
          await sendTelegramPhoto(
            deps.tg,
            chatId,
            burndownPng,
            `burndown-${p.key}.png`,
            { caption: burndownCaption ?? undefined, parse_mode: "HTML" },
          );
        } catch (err) {
          logger.warn(
            { project: p.key, chatId, err: (err as Error).message },
            "burndown photo send failed",
          );
        } finally {
          stopUploading();
        }
      }
    } catch (err) {
      logger.error(
        { project: p.key, chatId, err: (err as Error).message },
        "/report build failed",
      );
      await sendTelegramMessage(
        deps.tg,
        chatId,
        `Không tạo được report cho <b>${p.key}</b>. Lỗi: ${(err as Error).message}`,
        { parse_mode: "HTML" },
      );
    } finally {
      stopTyping();
    }
  }
}
