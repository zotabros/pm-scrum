import { loadEnv } from "../src/config.js";
import { createJiraClient } from "../src/jira/client.js";
import { getIssueChangelog } from "../src/jira/issues.js";

async function main() {
  const env = loadEnv();
  const client = createJiraClient(env);
  const key = process.argv[2] ?? "WL-971";
  const changelog = await getIssueChangelog(client, key);

  const transitions = changelog
    .flatMap((h) =>
      h.items
        .filter((i) => i.field === "status")
        .map((i) => ({ at: h.created, from: i.fromString, to: i.toString })),
    )
    .sort((a, b) => a.at.localeCompare(b.at));

  process.stdout.write(`== ${key} status transitions (${transitions.length}) ==\n`);
  for (const t of transitions) {
    process.stdout.write(`${t.at}  ${t.from ?? "∅"} → ${t.to ?? "∅"}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(String(err) + "\n");
  process.exit(1);
});
