import { getChatMember, type TelegramOptions } from "../telegram.js";
import { logger } from "../logger.js";

const cache = new Map<string, { ok: boolean; expires: number }>();
const TTL_MS = 5 * 60 * 1000;

export interface AuthDeps {
  tg: TelegramOptions;
  whitelist: number[];
}

export async function isAuthorized(
  deps: AuthDeps,
  chatId: number,
  userId: number,
  chatType: string,
): Promise<boolean> {
  if (deps.whitelist.includes(userId)) return true;
  if (chatType === "private") return false; // private chats: only whitelist
  const cacheKey = `${chatId}:${userId}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.expires > Date.now()) return hit.ok;
  try {
    const member = await getChatMember(deps.tg, chatId, userId);
    const ok = member.status === "creator" || member.status === "administrator";
    cache.set(cacheKey, { ok, expires: Date.now() + TTL_MS });
    return ok;
  } catch (err) {
    logger.warn(
      { chatId, userId, err: (err as Error).message },
      "getChatMember failed",
    );
    return false;
  }
}
