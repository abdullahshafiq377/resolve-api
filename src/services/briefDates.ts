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
