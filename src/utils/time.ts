/**
 * Small time helpers. We store `remind_at` as a HH:MM:SS `time` in the user's
 * local timezone and pass `{ timezone }` to node-cron so the cron engine handles
 * DST and offsets for us.
 */

/** Parses 'HH:MM' or 'HH:MM:SS' into [hour, minute]. Returns null if invalid. */
export function parseTimeOfDay(input: string): { hour: number; minute: number } | null {
  const trimmed = input.trim();
  const match = /^([0-1]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(trimmed);
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** Formats hour+minute as HH:MM:SS for Postgres `time` type. */
export function formatTimeOfDay(hour: number, minute: number): string {
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return `${hh}:${mm}:00`;
}

/**
 * Converts HH:MM or HH:MM:SS to a 6-field cron expression firing daily at
 * that time, with random second-level jitter so that users who picked the
 * same hh:mm don't all fire on the exact same second (spreads load across
 * LLM / Twilio / Postgres when this eventually scales).
 *
 * Example: parseTime("08:30") → "37 30 8 * * *" (second 37 is random).
 */
export function cronForTime(time: string): string | null {
  const parsed = parseTimeOfDay(time);
  if (!parsed) return null;
  // Belt-and-suspenders range check — parseTimeOfDay already enforces this,
  // but if we ever bypass it, don't produce a garbage cron.
  if (parsed.hour < 0 || parsed.hour > 23 || parsed.minute < 0 || parsed.minute > 59) {
    return null;
  }
  const second = Math.floor(Math.random() * 60);
  return `${second} ${parsed.minute} ${parsed.hour} * * *`;
}

/** Returns today's date in YYYY-MM-DD for a given IANA timezone. */
export function todayInTimezone(timezone: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date());
}

/** Returns a Date representing "start of today" in the given timezone, as a UTC Date. */
export function startOfTodayInTimezone(timezone: string): Date {
  const ymd = todayInTimezone(timezone);
  // Construct local midnight in that timezone and convert to UTC.
  // We do it the lazy way: parse the date parts and assume the server's math is OK.
  const [y, m, d] = ymd.split('-').map(Number);
  // Create a UTC Date for that calendar day start in the target timezone.
  // Intl doesn't give us offset directly, so use a roundtrip via another formatter.
  const utcGuess = new Date(Date.UTC(y!, m! - 1, d!));
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  });
  // Extract the offset like "GMT+05:30"
  const parts = fmt.formatToParts(utcGuess);
  const tzPart = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+00:00';
  const offMatch = /GMT([+-])(\d{2}):(\d{2})/.exec(tzPart);
  if (!offMatch) return utcGuess;
  const sign = offMatch[1] === '+' ? -1 : 1;
  const offMin = sign * (Number(offMatch[2]) * 60 + Number(offMatch[3]));
  return new Date(utcGuess.getTime() + offMin * 60_000);
}
