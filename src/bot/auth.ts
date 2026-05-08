import type { TelegramOptions } from "../telegram.js";

export interface AuthDeps {
  tg: TelegramOptions;
  whitelist: number[];
}

/**
 * True only if userId is listed in TELEGRAM_ADMIN_USER_IDS.
 * Used for any action that mutates state (subscribe/unsubscribe).
 */
export function isAdmin(deps: AuthDeps, userId: number): boolean {
  return deps.whitelist.includes(userId);
}

/**
 * Private chats are admin-only. Group/supergroup chats are open to members.
 */
export function isAllowedChat(
  deps: AuthDeps,
  chatType: string,
  userId: number,
): boolean {
  if (chatType === "private") return isAdmin(deps, userId);
  return true;
}
