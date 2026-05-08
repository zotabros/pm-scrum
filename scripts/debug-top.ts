import { loadEnv, loadConfig } from "../src/config.js";
import { createJiraClient } from "../src/jira/client.js";
import { findActiveSprintForProject } from "../src/jira/discover.js";
import { searchJql, getIssueChangelog } from "../src/jira/issues.js";
import { loadStatusCategoryMap, computeInProgressHours, fetchSprintLeaderboardTasks } from "../src/aggregate.js";

async function main() {
  loadConfig();
  const env = loadEnv();
  const client = createJiraClient(env);
  const statusMeta = await loadStatusCategoryMap(client);
  const sprint = await findActiveSprintForProject(client, "WL");
  if (!sprint) return;
  const sprintIssues = await searchJql(client, `sprint = ${sprint.id}`);
  const tasks = await fetchSprintLeaderboardTasks(client, sprintIssues, statusMeta, new Date());

  // Build parent map for fetching subtask details
  const allKeys = new Set(tasks.map((t) => t.key));
  const fetched = await searchJql(client, `key in (${[...allKeys].join(",")})`);
  const byKey = new Map(fetched.map((f) => [f.key, f]));

  const targets = ["Minh Thanh", "QC", "BE team", "Ngô Huy Hoàng", "Ngoc Diep"];
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/gi, "");
  const TPRE = /^(be|fe|qa|qc|dev|ba|pm|po|sm)-/i;

  for (const target of targets) {
    const tnorm = norm(target);
    console.log(`\n========== ${target} ==========`);
    const matches = tasks.filter((t) => {
      if (t.labels.length > 0) {
        const first = t.labels[0].replace(TPRE, "");
        return norm(first).includes(tnorm) || norm(t.labels[0]).includes(tnorm);
      }
      return norm(t.assignee).includes(tnorm);
    });

    let total = 0;
    for (const t of matches) {
      const issue = byKey.get(t.key)!;
      const cl = await getIssueChangelog(client, t.key);
      const finishedAt = issue.fields.resolutiondate ? new Date(issue.fields.resolutiondate) : new Date();
      const h = computeInProgressHours(cl, statusMeta, finishedAt);
      total += h ?? 0;
      console.log(`\n${t.key}  ${h}h   "${issue.fields.summary.slice(0, 60)}"`);
      console.log(`  labels=[${t.labels.join("|")}]  assignee=${t.assignee}  resolved=${issue.fields.resolutiondate ?? "—"}`);
      const trans = cl
        .flatMap((h: any) => h.items.filter((it: any) => it.field === "status").map((it: any) => ({ at: h.created, from: it.fromString, to: it.toString })))
        .sort((a: any, b: any) => new Date(a.at).getTime() - new Date(b.at).getTime());
      for (const tr of trans) {
        const cat = statusMeta.get(tr.to ?? "")?.category ?? "?";
        console.log(`   ${tr.at}  ${tr.from} → ${tr.to}  [${cat}]`);
      }
    }
    console.log(`\nTOTAL ${target}: ${total}h across ${matches.length} tasks`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
