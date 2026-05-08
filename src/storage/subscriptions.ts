import { existsSync, readFileSync } from "node:fs";
import { writeFile, rename, mkdir, copyFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { logger } from "../logger.js";

export interface SubscriptionsFile {
  version: 1;
  projects: Record<string, string[]>;
}

const DEFAULT_PATH = resolve(process.cwd(), "data/subscriptions.json");

let cache: SubscriptionsFile | null = null;
let writeChain: Promise<void> = Promise.resolve();

function emptyFile(): SubscriptionsFile {
  return { version: 1, projects: {} };
}

export function load(path = DEFAULT_PATH): SubscriptionsFile {
  if (cache) return cache;
  if (!existsSync(path)) {
    cache = emptyFile();
    return cache;
  }
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as SubscriptionsFile;
  if (!parsed || typeof parsed !== "object" || !parsed.projects) {
    throw new Error(`Malformed subscriptions file: ${path}`);
  }
  cache = { version: 1, projects: parsed.projects };
  return cache;
}

export function reload(path = DEFAULT_PATH): SubscriptionsFile {
  cache = null;
  return load(path);
}

async function persist(data: SubscriptionsFile, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  if (existsSync(path)) {
    try {
      await copyFile(path, `${path}.bak`);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "subscriptions backup failed");
    }
  }
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, path);
}

function enqueue(task: () => Promise<void>): Promise<void> {
  writeChain = writeChain.then(task, task);
  return writeChain;
}

export async function save(
  data: SubscriptionsFile,
  path = DEFAULT_PATH,
): Promise<void> {
  cache = data;
  await enqueue(() => persist(data, path));
}

export function getChats(projectKey: string): string[] {
  const data = load();
  return data.projects[projectKey] ?? [];
}

export function listSubscribed(chatId: string): Set<string> {
  const data = load();
  const out = new Set<string>();
  for (const [key, chats] of Object.entries(data.projects)) {
    if (chats.includes(chatId)) out.add(key);
  }
  return out;
}

/**
 * Exclusive toggle: each chat can subscribe to at most one project.
 *
 * - If the chat is already in `projectKey`, unsubscribe.
 * - Otherwise, remove the chat from every other project and subscribe to `projectKey`.
 *
 * Returns `previous` so the UI can describe the transition (e.g. "switched from A to B").
 */
export async function toggle(
  projectKey: string,
  chatId: string,
  path = DEFAULT_PATH,
): Promise<{ subscribed: boolean; previous: string | null }> {
  const data = load(path);
  const previous = findChatProject(data, chatId);

  if (previous === projectKey) {
    data.projects[projectKey] = (data.projects[projectKey] ?? []).filter(
      (id) => id !== chatId,
    );
    await save(data, path);
    return { subscribed: false, previous };
  }

  for (const [key, chats] of Object.entries(data.projects)) {
    data.projects[key] = chats.filter((id) => id !== chatId);
  }
  const target = data.projects[projectKey] ?? [];
  target.push(chatId);
  data.projects[projectKey] = target;
  await save(data, path);
  return { subscribed: true, previous };
}

function findChatProject(data: SubscriptionsFile, chatId: string): string | null {
  for (const [key, chats] of Object.entries(data.projects)) {
    if (chats.includes(chatId)) return key;
  }
  return null;
}

/** Project the chat is currently subscribed to, or null. */
export function getChatProject(chatId: string): string | null {
  return findChatProject(load(), chatId);
}

export function allChats(): Map<string, Set<string>> {
  const data = load();
  const out = new Map<string, Set<string>>();
  for (const [key, chats] of Object.entries(data.projects)) {
    out.set(key, new Set(chats));
  }
  return out;
}
