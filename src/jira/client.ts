import axios, { AxiosInstance, AxiosError } from "axios";
import { logger } from "../logger.js";
import type { JiraCreds } from "../config.js";

export function createJiraClient(creds: JiraCreds): AxiosInstance {
  const auth = Buffer.from(`${creds.email}:${creds.apiToken}`).toString("base64");
  const client = axios.create({
    baseURL: creds.baseUrl,
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    timeout: 30_000,
  });

  client.interceptors.response.use(
    (r) => r,
    async (err: AxiosError) => {
      const cfg = err.config as (typeof err.config & { _retry?: number }) | undefined;
      if (!cfg) throw err;
      cfg._retry = (cfg._retry ?? 0) + 1;
      const status = err.response?.status;
      const retriable = !err.response || (status !== undefined && status >= 500) || status === 429;
      if (retriable && cfg._retry <= 3) {
        const backoff = 500 * 2 ** (cfg._retry - 1);
        logger.warn({ status, attempt: cfg._retry, url: cfg.url }, "jira retry");
        await new Promise((r) => setTimeout(r, backoff));
        return client.request(cfg);
      }
      throw err;
    },
  );

  return client;
}
