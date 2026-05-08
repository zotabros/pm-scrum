import { loadEnv } from "../src/config.js";
import { createJiraClient } from "../src/jira/client.js";
import { searchJql } from "../src/jira/issues.js";
import { expandSprintIssuesWithSubtasks } from "../src/aggregate.js";

async function main() {
  const env = loadEnv();
  const client = createJiraClient(env);
  const sprintId = Number(process.argv[2] ?? 47);

  const sprintIssues = await searchJql(client, `sprint = ${sprintId}`);
  const expanded = await expandSprintIssuesWithSubtasks(client, sprintIssues);

  const done = expanded.filter(
    (i) => !(i.fields.subtasks && i.fields.subtasks.length > 0) &&
      i.fields.status.statusCategory.key === "done",
  );

  const rows = done
    .map((i) => ({
      key: i.key,
      rd: i.fields.resolutiondate ?? null,
      status: i.fields.status.name,
    }))
    .sort((a, b) => (a.rd ?? "").localeCompare(b.rd ?? ""));

  process.stdout.write(`Total done (leaf): ${done.length}\n`);
  for (const r of rows) {
    process.stdout.write(`${r.rd ?? "(no rd)"}  ${r.key}  [${r.status}]\n`);
  }
}

main().catch((err) => {
  process.stderr.write(String(err) + "\n");
  process.exit(1);
});
