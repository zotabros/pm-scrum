import type { Config, Env } from "../config.js";
import { resolveJiraCreds } from "../config.js";
import { createJiraClient } from "../jira/client.js";
import { listProjects } from "../jira/discover.js";
import { logger } from "../logger.js";

export type ProjectNameMap = Map<string, string>;

/**
 * Fetch friendly project names from Jira for every unique instance referenced
 * in config. Failures per instance are logged and skipped — callers must
 * fall back to config.name / key when a key is missing from the map.
 */
export async function loadProjectNames(
  env: Env,
  config: Config,
): Promise<ProjectNameMap> {
  const out: ProjectNameMap = new Map();
  const instances = new Set<string | undefined>();
  for (const p of config.projects) instances.add(p.jira_instance);
  if (config.auto_discover_all) instances.add(undefined);

  await Promise.all(
    [...instances].map(async (instance) => {
      try {
        const client = createJiraClient(resolveJiraCreds(env, instance));
        const projects = await listProjects(client);
        for (const p of projects) {
          if (!out.has(p.key)) out.set(p.key, p.name);
        }
      } catch (err) {
        logger.warn(
          { instance: instance ?? "default", err: (err as Error).message },
          "failed to fetch project names from Jira",
        );
      }
    }),
  );
  logger.info({ count: out.size }, "Jira project names cached");
  return out;
}

const REFRESH_MS = 6 * 60 * 60 * 1000;

/**
 * Mutate `target` in place with a fresh copy of the project name map.
 * Returns a stop() to cancel the refresh interval.
 */
export function startProjectNameRefresh(
  env: Env,
  config: Config,
  target: ProjectNameMap,
): () => void {
  const handle = setInterval(() => {
    void (async () => {
      const fresh = await loadProjectNames(env, config);
      target.clear();
      for (const [k, v] of fresh) target.set(k, v);
    })();
  }, REFRESH_MS);
  return () => clearInterval(handle);
}
