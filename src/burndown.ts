import axios from "axios";
import type { JiraIssue, JiraSprint } from "./types.js";
import { logger } from "./logger.js";

export interface BurndownPoint {
  label: string;
  ideal: number;
  actual: number | null;
}

function tzInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(guess));
  const get = (t: string): number =>
    Number(parts.find((p) => p.type === t)?.value);
  const asUTC = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") === 24 ? 0 : get("hour"),
    get("minute"),
    get("second"),
  );
  return new Date(guess - (asUTC - guess));
}

function localYmd(d: Date, timezone: string): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t: string): number =>
    Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

function localWeekday(y: number, m: number, d: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
  }).format(tzInstant(y, m, d, 12, 0, timezone));
}

function ymdKey(d: { y: number; m: number; d: number }): string {
  return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
}

function isWorkingDay(
  y: number,
  m: number,
  d: number,
  timezone: string,
  workingSaturdays: Set<string>,
): boolean {
  const wd = localWeekday(y, m, d, timezone);
  if (wd === "Sun") return false;
  if (wd === "Sat") return workingSaturdays.has(ymdKey({ y, m, d }));
  return true;
}

export function computeBurndown(
  sprint: JiraSprint,
  leafIssues: JiraIssue[],
  now: Date,
  timezone: string,
  workingSaturdays: Set<string>,
): BurndownPoint[] {
  if (!sprint.startDate || !sprint.endDate) return [];

  const startYmd = localYmd(new Date(sprint.startDate), timezone);
  const endYmd = localYmd(new Date(sprint.endDate), timezone);
  const todayYmd = localYmd(now, timezone);
  const todayKey = ymdKey(todayYmd);

  // Build list of working days (calendar) in [start, end]
  const days: Array<{ y: number; m: number; d: number; key: string }> = [];
  let cur = startYmd;
  for (let safety = 0; safety < 200; safety++) {
    if (isWorkingDay(cur.y, cur.m, cur.d, timezone, workingSaturdays)) {
      days.push({ ...cur, key: ymdKey(cur) });
    }
    if (cur.y === endYmd.y && cur.m === endYmd.m && cur.d === endYmd.d) break;
    const next = tzInstant(cur.y, cur.m, cur.d, 24, 0, timezone);
    cur = localYmd(next, timezone);
  }
  if (days.length === 0) return [];

  const total = leafIssues.length;
  const N = days.length;
  const sprintStartMs = new Date(sprint.startDate).getTime();
  const nowMs = now.getTime();
  const points: BurndownPoint[] = [];

  points.push({
    label: "Bắt đầu",
    ideal: total,
    actual: sprintStartMs <= nowMs ? total : null,
  });

  for (let i = 0; i < N; i++) {
    const day = days[i]!;
    const ideal = total - (total * (i + 1)) / N;
    const eod = tzInstant(day.y, day.m, day.d, 24, 0, timezone).getTime();
    const isToday = day.key === todayKey;

    let actual: number | null = null;
    if (!isToday && eod <= nowMs) {
      let doneCount = 0;
      for (const issue of leafIssues) {
        const res = issue.fields.resolutiondate;
        if (!res) continue;
        const t = new Date(res).getTime();
        if (Number.isFinite(t) && t <= eod) doneCount += 1;
      }
      actual = total - doneCount;
    }

    points.push({
      label: `${String(day.d).padStart(2, "0")}/${String(day.m).padStart(2, "0")}`,
      ideal: Math.max(0, Math.round(ideal * 10) / 10),
      actual,
    });
  }

  return points;
}

export async function renderBurndownPng(
  points: BurndownPoint[],
  title: string,
): Promise<Buffer> {
  const chart = {
    type: "line",
    data: {
      labels: points.map((p) => p.label),
      datasets: [
        {
          label: "Ideal",
          data: points.map((p) => p.ideal),
          borderColor: "rgb(150,150,150)",
          borderDash: [6, 4],
          fill: false,
          pointRadius: 0,
        },
        {
          label: "Actual",
          data: points.map((p) => p.actual),
          borderColor: "rgb(220,53,69)",
          backgroundColor: "rgba(220,53,69,0.15)",
          fill: false,
          spanGaps: false,
          pointRadius: 3,
        },
      ],
    },
    options: {
      title: { display: true, text: title, fontSize: 16 },
      legend: { position: "bottom" },
      scales: {
        yAxes: [
          {
            ticks: {
              beginAtZero: true,
              precision: 0,
              max: points[0]?.ideal,
            },
            scaleLabel: { display: true, labelString: "Tasks remaining" },
          },
        ],
        xAxes: [{ scaleLabel: { display: true, labelString: "Sprint day" } }],
      },
    },
  };

  const res = await axios.post(
    "https://quickchart.io/chart",
    {
      chart,
      width: 900,
      height: 480,
      backgroundColor: "white",
      format: "png",
      version: "2.9.4",
    },
    { responseType: "arraybuffer", timeout: 20_000 },
  );
  return Buffer.from(res.data as ArrayBuffer);
}

export async function safeBuildBurndownPng(
  sprint: JiraSprint,
  leafIssues: JiraIssue[],
  now: Date,
  timezone: string,
  workingSaturdays: Set<string>,
  title: string,
): Promise<Buffer | null> {
  try {
    const points = computeBurndown(sprint, leafIssues, now, timezone, workingSaturdays);
    if (points.length === 0) return null;
    return await renderBurndownPng(points, title);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "burndown render failed");
    return null;
  }
}
