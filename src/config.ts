import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import "dotenv/config";

const ProjectSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1).optional(),
  jira_instance: z.string().min(1).optional(),
});

const ConfigSchema = z.object({
  timezone: z.string().default("Asia/Ho_Chi_Minh"),
  run_on_weekdays_only: z.boolean().default(true),
  auto_discover_all: z.boolean().default(false),
  projects: z.array(ProjectSchema).default([]),
  llm: z
    .object({
      enabled: z.boolean().default(false),
      model: z.string().default("claude-haiku-4-5-20251001"),
      language: z.string().default("vi"),
      base_url: z.string().url().optional(),
      api_key: z.string().min(1).optional(),
    })
    .default({ enabled: false, model: "claude-haiku-4-5-20251001", language: "vi" }),
  hours_calculation: z
    .object({ business_hours_only: z.boolean().default(false) })
    .default({ business_hours_only: false }),
});

export type Config = z.infer<typeof ConfigSchema>;

const EnvSchema = z.object({
  JIRA_BASE_URL: z.string().url(),
  JIRA_EMAIL: z.string().email(),
  JIRA_API_TOKEN: z.string().min(1),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  ANTHROPIC_API_KEY: z
    .string()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),
  HEALTHCHECK_URL: z
    .string()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined))
    .pipe(z.string().url().optional()),
  TELEGRAM_WEBHOOK_SECRET: z
    .string()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),
  TELEGRAM_WEBHOOK_PORT: z
    .string()
    .optional()
    .transform((v) => (v && v.length > 0 ? Number(v) : 8081))
    .pipe(z.number().int().min(1).max(65535)),
  TELEGRAM_ADMIN_USER_IDS: z
    .string()
    .optional()
    .transform((v) =>
      v && v.length > 0
        ? v
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
            .map((s) => Number(s))
            .filter((n) => Number.isFinite(n))
        : [],
    ),
});

export type Env = z.infer<typeof EnvSchema>;

export interface JiraCreds {
  baseUrl: string;
  email: string;
  apiToken: string;
}

/**
 * Resolve Jira credentials for a project. If `instance` is undefined or "default",
 * uses JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN. Otherwise reads
 * JIRA_<INSTANCE>_BASE_URL (required) and falls back to JIRA_EMAIL / JIRA_API_TOKEN
 * when JIRA_<INSTANCE>_EMAIL / JIRA_<INSTANCE>_API_TOKEN are not set — one Atlassian
 * account often has access to multiple sites with the same token.
 */
export function resolveJiraCreds(env: Env, instance?: string): JiraCreds {
  if (!instance || instance.toLowerCase() === "default") {
    return {
      baseUrl: env.JIRA_BASE_URL,
      email: env.JIRA_EMAIL,
      apiToken: env.JIRA_API_TOKEN,
    };
  }
  const prefix = `JIRA_${instance.toUpperCase()}`;
  const baseUrl = process.env[`${prefix}_BASE_URL`];
  if (!baseUrl) {
    throw new Error(
      `Missing env var ${prefix}_BASE_URL for Jira instance "${instance}"`,
    );
  }
  const email = process.env[`${prefix}_EMAIL`] || env.JIRA_EMAIL;
  const apiToken = process.env[`${prefix}_API_TOKEN`] || env.JIRA_API_TOKEN;
  return { baseUrl, email, apiToken };
}

export function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ");
    throw new Error(`Invalid environment variables: ${issues}`);
  }
  return parsed.data;
}

export function loadConfig(path = "config.yaml"): Config {
  const full = resolve(process.cwd(), path);
  if (!existsSync(full)) {
    throw new Error(`Config file not found: ${full} (copy config.yaml.example)`);
  }
  const raw = parseYaml(readFileSync(full, "utf8"));
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid config: ${parsed.error.message}`);
  }
  return parsed.data;
}
