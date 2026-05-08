import type { AxiosInstance } from "axios";
import type { JiraChangelogEntry, JiraIssue } from "../types.js";

const FIELDS = [
  "summary",
  "status",
  "assignee",
  "priority",
  "duedate",
  "issuetype",
  "updated",
  "resolutiondate",
  "labels",
  "subtasks",
];

export async function searchJql(
  client: AxiosInstance,
  jql: string,
  fields: string[] = FIELDS,
): Promise<JiraIssue[]> {
  const out: JiraIssue[] = [];
  let nextPageToken: string | undefined;
  for (;;) {
    const body: Record<string, unknown> = { jql, fields, maxResults: 100 };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const { data } = await client.post("/rest/api/3/search/jql", body);
    out.push(...(data.issues as JiraIssue[]));
    nextPageToken = data.nextPageToken;
    if (!nextPageToken || (data.isLast ?? false)) break;
  }
  return out;
}

export async function getIssueChangelog(
  client: AxiosInstance,
  issueKey: string,
): Promise<JiraChangelogEntry[]> {
  const out: JiraChangelogEntry[] = [];
  let startAt = 0;
  const max = 100;
  for (;;) {
    const { data } = await client.get(`/rest/api/3/issue/${issueKey}/changelog`, {
      params: { startAt, maxResults: max },
    });
    out.push(...(data.values as JiraChangelogEntry[]));
    if (data.isLast || out.length >= data.total) break;
    startAt += max;
  }
  return out;
}

export interface StatusMeta {
  name: string;
  category: "new" | "indeterminate" | "done";
}

export async function loadStatusCategoryMap(
  client: AxiosInstance,
): Promise<Map<string, StatusMeta>> {
  const { data } = await client.get("/rest/api/3/status");
  const map = new Map<string, StatusMeta>();
  for (const s of data as Array<{ name: string; statusCategory: { key: string } }>) {
    map.set(s.name, {
      name: s.name,
      category: (s.statusCategory.key as StatusMeta["category"]) ?? "new",
    });
  }
  return map;
}
