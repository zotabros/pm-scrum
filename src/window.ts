/**
 * Compute the "recently completed" window for a given run date.
 * Monday runs cover Fri 00:00 → Mon 00:00. Tue–Fri cover previous 1 day.
 * All dates are interpreted at local midnight in the configured timezone.
 */
export interface Window {
  since: Date;
  until: Date;
  label: "weekend" | "yesterday";
  sinceLabel: string;
  untilLabel: string;
}

export function getWindow(now: Date, timezone: string): Window {
  const localDateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
  }).format(now);

  const daysBack = weekday === "Mon" ? 3 : 1;
  const todayAtTz = localMidnightInTz(localDateStr, timezone);
  const sinceAtTz = new Date(todayAtTz.getTime() - daysBack * 86_400_000);

  const fmt = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);

  return {
    since: sinceAtTz,
    until: todayAtTz,
    label: weekday === "Mon" ? "weekend" : "yesterday",
    sinceLabel: fmt(sinceAtTz),
    untilLabel: fmt(new Date(todayAtTz.getTime() - 86_400_000)),
  };
}

/**
 * Return the UTC Date corresponding to 00:00 of `now`'s calendar day in `timezone`.
 */
export function startOfDayInTz(now: Date, timezone: string): Date {
  const localDateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return localMidnightInTz(localDateStr, timezone);
}

/**
 * Build a UTC Date that corresponds to 00:00 of `yyyy-mm-dd` in the given IANA timezone.
 */
function localMidnightInTz(yyyyMmDd: string, timezone: string): Date {
  const parts = yyyyMmDd.split("-").map(Number);
  const y = parts[0]!;
  const m = parts[1]!;
  const d = parts[2]!;
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const offset = getTzOffsetMs(dtf, new Date(guess));
  return new Date(guess - offset);
}

function getTzOffsetMs(dtf: Intl.DateTimeFormat, date: Date): number {
  const parts = dtf.formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUTC = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return asUTC - date.getTime();
}

export function isWeekday(now: Date, timezone: string): boolean {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
  }).format(now);
  return ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(weekday);
}

/**
 * Format a Date as `yyyy/MM/dd HH:mm` in the given IANA timezone for JQL `DURING`.
 * Jira Cloud interprets unqualified date strings in the calling user's timezone.
 */
export function jqlDate(d: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}/${get("month")}/${get("day")} ${get("hour")}:${get("minute")}`;
}
