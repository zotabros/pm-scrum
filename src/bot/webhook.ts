import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { logger } from "../logger.js";
import type { TelegramUpdate } from "../types.js";
import { handleProject, handleStart, type CommandDeps } from "./commands.js";
import { handleProjectToggle } from "./callbacks.js";
import { handleBrief, handleChart, handleReport } from "./report.js";

const MAX_BODY = 1_000_000;
const seenUpdates = new Set<number>();
const SEEN_LIMIT = 1000;

function rememberUpdate(id: number): boolean {
  if (seenUpdates.has(id)) return false;
  seenUpdates.add(id);
  if (seenUpdates.size > SEEN_LIMIT) {
    const first = seenUpdates.values().next().value;
    if (first !== undefined) seenUpdates.delete(first);
  }
  return true;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BODY) throw new Error("body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function commandName(text: string): string | null {
  if (!text.startsWith("/")) return null;
  const first = text.split(/\s+/)[0]!;
  // strip @botname suffix
  return first.split("@")[0]!.toLowerCase();
}

async function dispatch(deps: CommandDeps, update: TelegramUpdate): Promise<void> {
  if (update.message?.text) {
    const cmd = commandName(update.message.text);
    if (cmd === "/project") {
      await handleProject(deps, update.message);
    } else if (cmd === "/report") {
      await handleReport(deps, update.message);
    } else if (cmd === "/chart") {
      await handleChart(deps, update.message);
    } else if (cmd === "/brief") {
      await handleBrief(deps, update.message);
    } else if (cmd === "/start" || cmd === "/help") {
      await handleStart(deps, update.message);
    }
    return;
  }
  if (update.callback_query) {
    await handleProjectToggle(deps, update.callback_query);
  }
}

export interface WebhookServerOptions {
  port: number;
  secret: string;
  deps: CommandDeps;
}

export function startWebhookServer(opts: WebhookServerOptions): { close: () => Promise<void> } {
  const expectedPath = `/telegram/webhook/${opts.secret}`;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(req, res, opts, expectedPath);
  });
  server.listen(opts.port, () => {
    logger.info({ port: opts.port }, "webhook server listening");
  });
  return {
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: WebhookServerOptions,
  expectedPath: string,
): Promise<void> {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  if (req.method !== "POST" || req.url !== expectedPath) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  let body: string;
  try {
    body = await readBody(req);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "webhook body read failed");
    res.writeHead(413);
    res.end();
    return;
  }
  let update: TelegramUpdate;
  try {
    update = JSON.parse(body) as TelegramUpdate;
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  // Acknowledge immediately to avoid Telegram retries.
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
  if (!rememberUpdate(update.update_id)) {
    logger.debug({ update_id: update.update_id }, "duplicate update ignored");
    return;
  }
  try {
    await dispatch(opts.deps, update);
  } catch (err) {
    logger.error(
      { err: (err as Error).stack ?? (err as Error).message, update_id: update.update_id },
      "dispatch failed",
    );
  }
}
