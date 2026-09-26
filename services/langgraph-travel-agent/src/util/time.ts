const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2})?)(.*)$/;

/** "2026-10-02T08:40:00+02:00" -> "2026-10-02" */
export function isoDateOf(timestamp: string): string {
  return timestamp.slice(0, 10);
}

/** "2026-10-02T08:40:00+02:00" -> "08:40" */
export function isoTimeOf(timestamp: string): string {
  return timestamp.slice(11, 16);
}

export function isValidIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

export function addDaysToIsoDate(date: string, days: number): string {
  const base = new Date(`${date}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

export function daysBetweenIsoDates(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/**
 * Shifts the calendar date of an offset-bearing timestamp while leaving the
 * wall-clock time and UTC offset untouched. Used to roll the seeded dataset
 * forward so a 08:40 departure stays a 08:40 departure.
 */
export function shiftIsoTimestampDays(timestamp: string, days: number): string {
  const match = ISO_TIMESTAMP.exec(timestamp);
  if (!match) return timestamp;
  const [, datePart, timePart, zonePart] = match as unknown as [
    string,
    string,
    string,
    string,
  ];
  return `${addDaysToIsoDate(datePart, days)}T${timePart}${zonePart}`;
}

export function todayIsoDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** 545 -> "9h 05m" */
export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${String(mins).padStart(2, "0")}m`;
}
