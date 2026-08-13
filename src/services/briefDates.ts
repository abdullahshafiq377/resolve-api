const TIME_ZONE = 'Asia/Karachi';

function pakistanParts(date: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  return { year: get('year'), month: get('month'), day: get('day') };
}

export function getPakistanDateString(date = new Date()): string {
  const parts = pakistanParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * Midnight of the Pakistan day `date` falls in, as an instant. Lets "today"
 * counters agree with the brief's day boundary. PKT is a fixed +05:00 with no
 * DST, so the offset can be written literally.
 */
export function startOfPakistanDay(date = new Date()): Date {
  return new Date(`${getPakistanDateString(date)}T00:00:00+05:00`);
}

/**
 * The Pakistan calendar month `date` falls in, as `[start, end)` instants plus
 * its `YYYY-MM` key. The account overview counts a member's month on the same
 * boundary the Brief uses for its day, so "22 briefs read in July" lines up with
 * the 22 editions dated July.
 */
export function pakistanMonthWindow(date = new Date()): { key: string; start: Date; end: Date } {
  const key = getPakistanDateString(date).slice(0, 7);
  const [year, month] = key.split('-').map(Number);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    key,
    start: new Date(`${key}-01T00:00:00+05:00`),
    end: new Date(`${nextYear}-${pad(nextMonth)}-01T00:00:00+05:00`),
  };
}

export function defaultArticleWindow(now = new Date()): { start: Date; end: Date } {
  return { start: new Date(now.getTime() - 24 * 60 * 60 * 1000), end: now };
}

export function parseBriefDate(value: unknown): string {
  if (value === undefined || value === null || value === '') return getPakistanDateString();
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw Object.assign(new Error('invalid_brief_date'), { status: 400 });
  }
  return value;
}
