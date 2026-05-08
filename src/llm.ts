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
    const { data } = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: opts.model,
        max_tokens: 200,
        messages: [{ role: "user", content: prompt }],
      },
      {
        headers: {
          "x-api-key": opts.apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        timeout: 30_000,
      },
    );
    const note = (data.content?.[0]?.text ?? "").trim();
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
