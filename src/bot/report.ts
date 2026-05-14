import type { TelegramMessage } from "../types.js";
import {
  sendTelegramMessage,
  sendTelegramPhoto,
  startTypingIndicator,
} from "../telegram.js";
import { isAllowedChat } from "./auth.js";
import { logger } from "../logger.js";
import { getWindow, startOfDayInTz } from "../window.js";
import {
  computeBugStats,
  computeBurnRate,
  computeSprintEndCountdown,
  computeStuckTasks,
  computeUnassignedCount,
  formatCompletedSection,
  formatDailyBrief,
  formatLlmInsight,
  splitMessage,
} from "../format.js";
import { buildDigest, resolveProjectSprintList } from "../digest.js";
import { dailyBriefNotes } from "../llm.js";
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

export async function handleBrief(
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
      "Định dạng ngày không hợp lệ. Hãy dùng <code>/brief</code>, <code>/brief dd-mm</code> hoặc <code>/brief dd-mm-yyyy</code>.",
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

  const apiKey = deps.config.llm.api_key ?? deps.env.ANTHROPIC_API_KEY;
  if (!deps.config.llm.enabled || !apiKey) {
    await sendTelegramMessage(
      deps.tg,
      chatId,
      "LLM chưa được bật, không tạo được brief. Liên hệ admin để bật <code>llm.enabled</code> trong config.",
      { parse_mode: "HTML" },
    );
    return;
  }

  const runDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: deps.config.timezone,
  }).format(now);

  logger.info({ chatId, runDate, projects: projects.map((p) => p.key) }, "/brief run");

  const projectsLabel = projects.map((p) => `<b>${p.projectName}</b>`).join(", ");
  await sendTelegramMessage(
    deps.tg,
    chatId,
    `Bảo Bảo đang tạo Daily Brief cho dự án ${projectsLabel}. Chờ Bảo Bảo xíu nhé...`,
    { parse_mode: "HTML" },
  );

  for (const p of projects) {
    const stopTyping = startTypingIndicator(deps.tg, chatId, "typing");
    try {
      const { digest } = await buildDigest(deps.env, deps.config, p, now);
      const asOf = startOfDayInTz(now, deps.config.timezone);
      const countdown = computeSprintEndCountdown(digest.sprint, now, deps.config.timezone);
      const stuck = computeStuckTasks(digest, asOf);

      digest.briefNotes = await dailyBriefNotes(
        {
          apiKey,
          model: deps.config.llm.model,
          language: deps.config.llm.language,
          baseUrl: deps.config.llm.base_url,
        },
        digest,
        runDate,
        {
          unassignedCount: computeUnassignedCount(digest),
          sprintEndCountdown: countdown?.label ?? "không có endDate",
          topPerformers: digest.leaderboard.slice(0, 5),
          stuckTasks: stuck.map((s) => ({
            key: s.task.key,
            summary: s.task.summary,
            owner: s.owner,
            ownerRole: s.ownerRole,
            days: s.days,
          })),
          burnRate: computeBurnRate(digest),
          bugStats: computeBugStats(digest),
        },
      );

      const insight = formatLlmInsight(digest.briefNotes);
      if (insight) {
        for (const chunk of splitMessage(insight)) {
          await sendTelegramMessage(deps.tg, chatId, chunk);
        }
      } else {
        await sendTelegramMessage(
          deps.tg,
          chatId,
          `Không tạo được brief cho <b>${p.projectName}</b> (LLM trả lỗi).`,
          { parse_mode: "HTML" },
        );
      }
    } catch (err) {
      logger.error(
        { project: p.key, chatId, err: (err as Error).message },
        "/brief build failed",
      );
      await sendTelegramMessage(
        deps.tg,
        chatId,
        `Không tạo được brief cho <b>${p.key}</b>. Lỗi: ${(err as Error).message}`,
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

      // Optional LLM insight
      const apiKey = deps.config.llm.api_key ?? deps.env.ANTHROPIC_API_KEY;
      if (deps.config.llm.enabled && apiKey) {
        const asOf = startOfDayInTz(now, deps.config.timezone);
        const countdown = computeSprintEndCountdown(digest.sprint, now, deps.config.timezone);
        const stuck = computeStuckTasks(digest, asOf);
        digest.briefNotes = await dailyBriefNotes(
          {
            apiKey,
            model: deps.config.llm.model,
            language: deps.config.llm.language,
            baseUrl: deps.config.llm.base_url,
          },
          digest,
          runDate,
          {
            unassignedCount: computeUnassignedCount(digest),
            sprintEndCountdown: countdown?.label ?? "không có endDate",
            topPerformers: digest.leaderboard.slice(0, 5),
            stuckTasks: stuck.map((s) => ({
              key: s.task.key,
              summary: s.task.summary,
              owner: s.owner,
              ownerRole: s.ownerRole,
              days: s.days,
            })),
            burnRate: computeBurnRate(digest),
            bugStats: computeBugStats(digest),
          },
        );
      }

      // Message 1: brief + Đã hoàn thành
      const brief = formatDailyBrief({
        digest,
        runDate,
        now,
        timezone: deps.config.timezone,
      });
      const completed = formatCompletedSection(digest, windowLabel, windowDateLabel);
      const msg1 = completed ? `${brief}\n\n${completed}` : brief;
      for (const chunk of splitMessage(msg1)) {
        await sendTelegramMessage(deps.tg, chatId, chunk);
      }

      // Message 2: burndown photo
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

      // Message 3: LLM insight
      const insight = formatLlmInsight(digest.briefNotes);
      if (insight) {
        for (const chunk of splitMessage(insight)) {
          await sendTelegramMessage(deps.tg, chatId, chunk);
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
