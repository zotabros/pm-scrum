import axios from "axios";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ProjectDigest } from "./types.js";
import { logger } from "./logger.js";

const CACHE_PATH = resolve(process.cwd(), ".cache/llm-notes.json");

interface CacheShape {
  [key: string]: { date: string; note: string };
}

function readCache(): CacheShape {
  if (!existsSync(CACHE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CACHE_PATH, "utf8")) as CacheShape;
  } catch {
    return {};
  }
}

function writeCache(data: CacheShape): void {
  mkdirSync(resolve(process.cwd(), ".cache"), { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2));
}

export interface LlmOptions {
  apiKey: string;
  model: string;
  language: string;
  baseUrl?: string;
}

const DEFAULT_LLM_BASE_URL = "https://api.anthropic.com/v1";

/**
 * Call an LLM chat endpoint and return the plain text response.
 * - When `opts.baseUrl` is unset → use Anthropic Messages API (`/messages`).
 * - When `opts.baseUrl` is set → use OpenAI-compatible Chat Completions
 *   (`/chat/completions`) with Bearer auth. Required for self-hosted
 *   proxies (LiteLLM and similar).
 */
async function callChat(
  opts: LlmOptions,
  prompt: string,
  maxTokens: number,
): Promise<string> {
  const base = (opts.baseUrl ?? DEFAULT_LLM_BASE_URL).replace(/\/+$/, "");
  const useOpenAi = !!opts.baseUrl;
  const url = useOpenAi ? `${base}/chat/completions` : `${base}/messages`;
  const body = useOpenAi
    ? {
        model: opts.model,
        max_tokens: maxTokens,
        stream: false,
        messages: [{ role: "user", content: prompt }],
      }
    : {
        model: opts.model,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      };
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (useOpenAi) {
    headers["Authorization"] = `Bearer ${opts.apiKey}`;
  } else {
    headers["x-api-key"] = opts.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  }
  const { data } = await axios.post(url, body, { headers, timeout: 60_000 });
  if (useOpenAi) {
    return String(data?.choices?.[0]?.message?.content ?? "").trim();
  }
  return String(data?.content?.[0]?.text ?? "").trim();
}

export async function sprintHealthNote(
  opts: LlmOptions,
  digest: ProjectDigest,
  runDate: string,
): Promise<string | null> {
  const cacheKey = `${digest.sprint.id}-${runDate}`;
  const cache = readCache();
  if (cache[cacheKey]) return cache[cacheKey].note;

  const blocked = digest.todo.filter((t) => t.blocked).length;
  const overdue = digest.todo.filter(
    (t) => t.duedate && new Date(t.duedate).getTime() < Date.now(),
  ).length;

  const prompt = `Sprint "${digest.sprint.name}" day ${digest.dayNumber}/${digest.totalDays}, done ${digest.counts.done}/${digest.counts.total}. Blocked: ${blocked}. Overdue: ${overdue}. Đưa ra 1-2 câu nhận định tiến độ và 1 gợi ý ngắn cho daily standup. Ngôn ngữ: ${opts.language}. Không markdown, không emoji.`;

  try {
    const note = await callChat(opts, prompt, 200);
    if (note) {
      cache[cacheKey] = { date: runDate, note };
      writeCache(cache);
    }
    return note || null;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "llm sprintHealthNote failed");
    return null;
  }
}

const BRIEF_CACHE_PATH = resolve(process.cwd(), ".cache/llm-brief.json");

interface BriefCacheShape {
  [key: string]: {
    date: string;
    notes: { items: string[] };
  };
}

function readBriefCache(): BriefCacheShape {
  if (!existsSync(BRIEF_CACHE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(BRIEF_CACHE_PATH, "utf8")) as BriefCacheShape;
  } catch {
    return {};
  }
}

function writeBriefCache(data: BriefCacheShape): void {
  mkdirSync(resolve(process.cwd(), ".cache"), { recursive: true });
  writeFileSync(BRIEF_CACHE_PATH, JSON.stringify(data, null, 2));
}

export interface DailyBriefContext {
  unassignedCount: number;
  sprintEndCountdown: string;
  topPerformers: Array<{ name: string; role?: string | null; hours: number; tasks: number; hasHours: boolean }>;
  stuckTasks: Array<{ key: string; summary: string; owner: string; ownerRole?: string | null; days: number }>;
  burnRate?: {
    dayNumber: number;
    totalDays: number;
    remainingDays: number;
    doneRate: number;
    requiredRate: number;
    projectedDone: number;
    gap: number;
    status: "on-track" | "at-risk" | "behind";
  } | null;
  bugStats?: {
    total: number;
    done: number;
    inProgress: number;
    todo: number;
    ratio: number;
    newSinceSprintStart: number;
  } | null;
}

function clampList(items: unknown, maxItems: number, maxLen = 800): string[] {
  if (!Array.isArray(items)) return [];
  return items
    .filter((s): s is string => typeof s === "string")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, maxItems)
    .map((s) => (s.length > maxLen ? s.slice(0, maxLen) : s));
}

export async function dailyBriefNotes(
  opts: LlmOptions,
  digest: ProjectDigest,
  runDate: string,
  ctx: DailyBriefContext,
): Promise<{ items: string[] } | null> {
  const cacheKey = `${digest.sprint.id}-${runDate}`;
  const cache = readBriefCache();
  if (cache[cacheKey]) return cache[cacheKey].notes;

  const leaderboard = ctx.topPerformers
    .slice(0, 5)
    .map(
      (e, i) =>
        `${i + 1}. ${e.name}${e.role ? ` [${e.role}]` : ""} — ${e.hasHours ? `${e.hours}h, ` : ""}${e.tasks} tasks`,
    )
    .join("\n");
  const stuckList =
    ctx.stuckTasks.length === 0
      ? "(không có)"
      : ctx.stuckTasks
          .slice(0, 10)
          .map(
            (t) =>
              `${t.key} — ${t.days} ngày — ${t.owner}${t.ownerRole ? ` [${t.ownerRole}]` : ""}`,
          )
          .join("\n");

  const prompt = `Bạn đóng vai Scrum Master kỳ cựu, đang chuẩn bị nội dung cho buổi Daily Meeting của team. Mục tiêu duy nhất: nhận diện những vấn đề ĐÃ, ĐANG, hoặc CÓ THỂ ảnh hưởng đến việc hoàn thành Sprint Goal, để đưa ra Daily.

Dữ liệu sprint hiện tại (chụp tại đầu ngày):
- Sprint: ${digest.sprint.name} — ngày ${digest.dayNumber}/${digest.totalDays}
- Tiến độ: ${digest.counts.done}/${digest.counts.total} task đã xong, ${digest.counts.inProgress} đang làm, ${digest.counts.todo} chưa bắt đầu
- Task chưa có người nhận: ${ctx.unassignedCount}
- Thời gian còn lại trước khi sprint kết thúc: ${ctx.sprintEndCountdown}
- Top 5 thành viên đóng góp nhiều giờ làm việc nhất sprint (chỉ là tham khảo, KHÔNG dùng để so sánh năng suất — có thành viên là part-time, làm nhiều dự án song song):
${leaderboard || "(chưa có)"}
- Task đang kẹt (đã vào trạng thái Đang làm trên 1 ngày, tính tới đầu ngày hôm nay):
${stuckList}
- Tốc độ và dự báo (dựa trên số task done từ đầu sprint):
${
  ctx.burnRate
    ? [
        `  + Đã đi qua ${ctx.burnRate.dayNumber}/${ctx.burnRate.totalDays} ngày, còn ${ctx.burnRate.remainingDays} ngày.`,
        `  + Tốc độ trung bình: ${ctx.burnRate.doneRate.toFixed(2)} task/ngày.`,
        `  + Để hoàn thành 100% cần đạt: ${ctx.burnRate.requiredRate.toFixed(2)} task/ngày.`,
        `  + Nếu giữ tốc độ hiện tại, dự kiến done được ~${Math.round(ctx.burnRate.projectedDone)} / ${digest.counts.total} task lúc kết thúc sprint.`,
        ctx.burnRate.gap > 0
          ? `  + Dự báo THIẾU ~${Math.round(ctx.burnRate.gap)} task (status: ${ctx.burnRate.status}).`
          : `  + Dự báo DƯ ${Math.round(-ctx.burnRate.gap)} task buffer (status: ${ctx.burnRate.status}).`,
      ].join("\n")
    : "  (không đủ dữ liệu)"
}
- Tình hình bug trong sprint:
${
  ctx.bugStats
    ? [
        `  + Tổng bug: ${ctx.bugStats.total} (chiếm ${(ctx.bugStats.ratio * 100).toFixed(1)}% tổng task của sprint).`,
        `  + Đã xong: ${ctx.bugStats.done} · Đang làm: ${ctx.bugStats.inProgress} · Chưa bắt đầu: ${ctx.bugStats.todo}.`,
        `  + Bug được tạo SAU khi sprint bắt đầu: ${ctx.bugStats.newSinceSprintStart} (bug phát sinh trong sprint, không nằm trong kế hoạch ban đầu).`,
      ].join("\n")
    : "  (không có dữ liệu)"
}

Yêu cầu output JSON đúng format (không thêm chữ nào ngoài JSON):
{
  "items": ["bullet 1", "bullet 2", ...]
}

Cách viết:
- "items" (3-6 mục): mỗi mục VỪA là một nhận định / phát hiện cảnh báo (insight), VỪA kèm hành động cụ thể cần làm trong Daily hôm nay. Không tách riêng phần phân tích và phần hành động. Một mục = một chủ đề trọn vẹn.
- Mỗi mục bắt đầu bằng 1 trong các emoji: 📊 (đánh giá tổng thể tốc độ/dự báo), 🚨 (rủi ro cao cần xử ngay), ⚠️ (cảnh báo bug / chất lượng), ❓ (cần hỏi rõ trong daily), ⚡️ (thúc đẩy hoàn thành), 🎯 (nhắc lại Sprint Goal nếu cần re-prioritize).
- ƯU TIÊN nội dung:
  1. 📊 Mục đầu tiên BẮT BUỘC: đánh giá tốc độ — so tốc độ hiện tại với tốc độ cần, dự báo bằng con số cụ thể (done bao nhiêu / tổng, thiếu mấy task). Nói rõ on-track / at-risk / behind và đề xuất hành động (giảm scope, tăng tốc, dồn lực vào task nào…).
  2. ⚠️ Nếu tỉ lệ bug cao hoặc bug phát sinh sau khi sprint bắt đầu nhiều → raise cảnh báo về chất lượng, đề xuất review code/test trước khi nhận thêm task mới.
  3. 🚨 / ❓ Các task kẹt: gọi tên người, gọi tên task, hỏi blocker, đề xuất hành động — KHÔNG tách riêng "Người X đang kẹt" và "Hỏi người X" thành 2 mục, gộp lại 1 mục.
  4. ⚡️ Task chưa bắt đầu quan trọng / sát deadline.
- KHÔNG so sánh thuần số giờ giữa thành viên (có người không full-time). Chỉ raise khi 1 người ôm nhiều task kẹt cùng lúc.
- KHÔNG nhắc lại cùng 1 người / 1 task ở nhiều mục. Mỗi chủ đề chỉ xuất hiện 1 lần.
- KHÔNG đề xuất người role này hỗ trợ trực tiếp task của role khác (vd: Backend không thể test thay QC, QC không thể code thay Backend, Frontend không thay được Backend...). Mỗi role được hiển thị trong ngoặc vuông sau tên, ví dụ "Hữu Hoàn [QC]" — phải tôn trọng giới hạn role khi đưa gợi ý. Cross-role assistance chỉ chấp nhận khi là PM/SM/PO hỗ trợ điều phối, không phải thay tay làm việc.

Phong cách:
- Viết tiếng Việt tự nhiên. Hạn chế tối đa tiếng Anh; chỉ dùng các từ đã quen thuộc với dev Việt: sprint, daily, demo, deadline, bug, deploy, API. Tránh: "bottleneck", "rebalance", "escalate", "decompose", "pickup", "blocker", "pace", "rhythm", "miss", "stuck", "todo", "resource", "review" — hãy thay bằng từ thuần Việt ("nghẽn", "phân lại việc", "đẩy lên cấp trên", "chia nhỏ", "nhận thêm", "vướng mắc", "tốc độ", "trễ", "kẹt", "chưa bắt đầu", "nhân lực", "xem lại").
- Không markdown (không **, _, \`, []).
- Tập trung vào hành động cụ thể, không nói chung chung kiểu "cần ưu tiên hoá công việc".
`;

  try {
    const raw = await callChat(opts, prompt, 3000);
    const jsonStart = raw.indexOf("{");
    const jsonEnd = raw.lastIndexOf("}");
    if (jsonStart < 0 || jsonEnd <= jsonStart) {
      logger.warn({ raw: raw.slice(0, 200) }, "llm dailyBriefNotes: no JSON");
      return null;
    }
    const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1)) as {
      items?: unknown;
    };
    const notes = {
      items: clampList(parsed.items, 6),
    };
    if (notes.items.length === 0) return null;
    cache[cacheKey] = { date: runDate, notes };
    writeBriefCache(cache);
    return notes;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "llm dailyBriefNotes failed");
    return null;
  }
}
