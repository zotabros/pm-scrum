import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { save, load, type SubscriptionsFile } from "../src/storage/subscriptions.js";

interface RawProject {
  key: string;
  telegram_chat_id?: string;
  jira_instance?: string;
}

async function main(): Promise<void> {
  const cfgPath = resolve(process.cwd(), "config.yaml");
  if (!existsSync(cfgPath)) {
    throw new Error(`config.yaml not found at ${cfgPath}`);
  }
  const raw = parseYaml(readFileSync(cfgPath, "utf8")) as { projects?: RawProject[] };
  const projects = raw.projects ?? [];

  const existing = load();
  const data: SubscriptionsFile = { version: 1, projects: { ...existing.projects } };
  let added = 0;
  let skipped = 0;
  for (const p of projects) {
    if (!p.telegram_chat_id) {
      skipped += 1;
      continue;
    }
    const list = data.projects[p.key] ?? [];
    if (!list.includes(p.telegram_chat_id)) {
      list.push(p.telegram_chat_id);
      added += 1;
    }
    data.projects[p.key] = list;
  }
  await save(data);
  console.log(
    `migration done: ${projects.length} project entries, ${added} chat ids added, ${skipped} skipped (no telegram_chat_id)`,
  );
  console.log(JSON.stringify(data, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
