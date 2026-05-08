import { loadEnv, loadConfig } from "../src/config.js";
import { createJiraClient } from "../src/jira/client.js";
import { findActiveSprintForProject } from "../src/jira/discover.js";
import { searchJql } from "../src/jira/issues.js";

async function main() {
  loadConfig();
  const env = loadEnv();
  const client = createJiraClient(env);
  const sprint = await findActiveSprintForProject(client, "WL");
  if (!sprint) return;
  const issues = await searchJql(client, `sprint = ${sprint.id}`);

  console.log("\n--- subtasks present in sprint query ---");
  for (const i of issues) {
    if (i.fields.issuetype?.subtask) {
      console.log(`  ${i.key}  status="${i.fields.status.name}" cat=${i.fields.status.statusCategory.key}  assignee=${i.fields.assignee?.displayName ?? "—"}  labels=[${(i.fields.labels ?? []).join("|")}]`);
    }
  }

  console.log("\n--- WL-727 / WL-947 subtask references ---");
  for (const key of ["WL-727", "WL-947"]) {
    const parent = issues.find((i) => i.key === key);
    if (!parent) continue;
    console.log(`${key} subtasks field:`);
    for (const s of parent.fields.subtasks ?? []) {
      console.log(`  ${s.key}  status="${s.fields.status.name}" cat=${s.fields.status.statusCategory.key}`);
    }
  }

  const probes = ["nga", "thanh", "qc", "qa"];
  console.log(`Total issues in sprint: ${issues.length}\n`);

  for (const probe of probes) {
    console.log(`\n=== probe "${probe}" ===`);
    const hits = issues.filter((i) => {
      const haystack = [
        i.fields.assignee?.displayName ?? "",
        ...(i.fields.labels ?? []),
        i.fields.summary,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(probe);
    });
    for (const i of hits) {
      const isSub = Boolean(i.fields.issuetype?.subtask);
      const hasSubs = (i.fields.subtasks?.length ?? 0) > 0;
      console.log(
        `  ${i.key}  status="${i.fields.status.name}" cat=${i.fields.status.statusCategory.key}  ${isSub ? "[subtask]" : hasSubs ? "[parent-with-subs]" : "[plain]"}  assignee=${i.fields.assignee?.displayName ?? "—"}  labels=[${(i.fields.labels ?? []).join("|")}]`,
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
