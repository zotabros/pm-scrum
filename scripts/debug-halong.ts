import { loadEnv, loadConfig } from "../src/config.js";
import { createJiraClient } from "../src/jira/client.js";
import { findActiveSprintForProject } from "../src/jira/discover.js";
import { searchJql, getIssueChangelog } from "../src/jira/issues.js";
import { loadStatusCategoryMap, computeInProgressHours } from "../src/aggregate.js";

async function main() {
  loadConfig();
  const env = loadEnv();
  const client = createJiraClient(env);
  const statusMeta = await loadStatusCategoryMap(client);
  const sprint = await findActiveSprintForProject(client, "WL");
  if (!sprint) {
    console.log("no sprint");
    return;
  }
  const issues = await searchJql(client, `sprint = ${sprint.id}`);

  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/gi, "");
  const target = "halong";

  const matches = issues.filter((i) => {
    if (i.fields.status.statusCategory.key !== "done") return false;
    if ((i.fields.subtasks?.length ?? 0) > 0) return false;
    const labels = i.fields.labels ?? [];
    if (labels.length > 0) return labels.some((l) => norm(l).includes(target));
    return norm(i.fields.assignee?.displayName ?? "").includes(target);
  });

  console.log(`Found ${matches.length} done tasks attributed to Ha Long via filter`);
  console.log("\n--- ALL done leaderboard candidates (no subtask parents) ---");
  for (const i of issues) {
    if (i.fields.status.statusCategory.key !== "done") continue;
    if ((i.fields.subtasks?.length ?? 0) > 0) continue;
    console.log(`  ${i.key}  labels=[${(i.fields.labels ?? []).join("|")}]  assignee=${i.fields.assignee?.displayName ?? "—"}`);
  }
  console.log("---\n");
  for (const issue of matches) {
    const cl = await getIssueChangelog(client, issue.key);
    const finishedAt = issue.fields.resolutiondate
      ? new Date(issue.fields.resolutiondate)
      : new Date();
    const hours = computeInProgressHours(cl, statusMeta, finishedAt);
    console.log(`\n=== ${issue.key}  → ${hours}h ===`);
    console.log(`  summary  : ${issue.fields.summary}`);
    console.log(`  assignee : ${issue.fields.assignee?.displayName ?? "—"}`);
    console.log(`  labels   : ${(issue.fields.labels ?? []).join(", ") || "—"}`);
    console.log(`  resolved : ${issue.fields.resolutiondate ?? "—"}`);
    const trans = cl
      .flatMap((h) =>
        h.items
          .filter((it) => it.field === "status")
          .map((it) => ({ at: h.created, from: it.fromString, to: it.toString })),
      )
      .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

    let enterAt: Date | null = null;
    for (const t of trans) {
      const cat = statusMeta.get(t.to ?? "")?.category ?? "?";
      console.log(`  ${t.at}  ${t.from} → ${t.to}  [${cat}]`);
      if (cat === "indeterminate") {
        if (!enterAt) enterAt = new Date(t.at);
      } else if (enterAt) {
        const dur = (new Date(t.at).getTime() - enterAt.getTime()) / 3_600_000;
        console.log(`     ↳ in-progress span: ${enterAt.toISOString()} → ${t.at}  = ${dur.toFixed(2)}h`);
        enterAt = null;
      }
    }
    if (enterAt) {
      const dur = (finishedAt.getTime() - enterAt.getTime()) / 3_600_000;
      console.log(`     ↳ in-progress span: ${enterAt.toISOString()} → ${finishedAt.toISOString()} (finishedAt) = ${dur.toFixed(2)}h`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
