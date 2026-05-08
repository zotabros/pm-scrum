import type { AxiosInstance } from "axios";
import type { JiraBoard, JiraProject, JiraSprint } from "../types.js";
import { logger } from "../logger.js";

export async function listProjects(client: AxiosInstance): Promise<JiraProject[]> {
  const out: JiraProject[] = [];
  let startAt = 0;
  const max = 50;
  for (;;) {
    const { data } = await client.get("/rest/api/3/project/search", {
      params: { startAt, maxResults: max },
    });
    out.push(...(data.values as JiraProject[]));
    if (data.isLast || out.length >= data.total) break;
    startAt += max;
  }
  return out;
}

export async function listBoardsForProject(
  client: AxiosInstance,
  projectKey: string,
): Promise<JiraBoard[]> {
  const out: JiraBoard[] = [];
  let startAt = 0;
  const max = 50;
  for (;;) {
    const { data } = await client.get("/rest/agile/1.0/board", {
      params: { projectKeyOrId: projectKey, startAt, maxResults: max },
    });
    out.push(...(data.values as JiraBoard[]));
    if (data.isLast || out.length >= data.total) break;
    startAt += max;
  }
  return out;
}

export async function getActiveSprint(
  client: AxiosInstance,
  boardId: number,
): Promise<JiraSprint | null> {
  try {
    const { data } = await client.get(`/rest/agile/1.0/board/${boardId}/sprint`, {
      params: { state: "active", maxResults: 50 },
    });
    const sprints = data.values as JiraSprint[];
    if (sprints.length === 0) return null;
    return { ...sprints[0]!, boardId };
  } catch (err: unknown) {
    logger.warn({ boardId, err: (err as Error).message }, "getActiveSprint failed");
    return null;
  }
}

export async function findActiveSprintForProject(
  client: AxiosInstance,
  projectKey: string,
): Promise<JiraSprint | null> {
  const boards = await listBoardsForProject(client, projectKey);
  for (const board of boards) {
    const sprint = await getActiveSprint(client, board.id);
    if (sprint) return sprint;
  }
  return null;
}
