import { loadEnv } from "../src/config.js";
import { createJiraClient } from "../src/jira/client.js";
import { findActiveSprintForProject } from "../src/jira/discover.js";

async function main() {
  const env = loadEnv();
  const c = createJiraClient(env);
  const s = await findActiveSprintForProject(c, "WL");
  process.stdout.write(JSON.stringify(s, null, 2) + "\n");
}

main().catch((err) => {
  process.stderr.write(String(err) + "\n");
  process.exit(1);
});
