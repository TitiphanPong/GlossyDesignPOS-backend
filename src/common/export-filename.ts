const BANGKOK_TIME_ZONE = 'Asia/Bangkok';
const MONTH_COMPACT_PATTERN = /^(\d{4})(\d{2})$/u;
const MONTH_DASHED_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/u;

export type ExportFilenameOptions = {
  artifact: string;
  scope: string;
  extension: string;
  variant?: string;
};

export type OrderExportDateScopeInput = {
  saleMonth?: string;
  period?: 'today';
  saleFrom?: string;
  saleTo?: string;
};

function sanitizeFilenamePart(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return normalized || fallback;
}

export function buildExportFilename(options: ExportFilenameOptions): string {
  const artifact = sanitizeFilenamePart(options.artifact, 'export');
  const variant = options.variant
    ? sanitizeFilenamePart(options.variant, '')
    : '';
  const scope = sanitizeFilenamePart(options.scope, 'all');
  const extension = sanitizeFilenamePart(
    options.extension.replace(/^\./u, ''),
    'bin',
  );
  return ['glossy', artifact, variant, scope]
    .filter(Boolean)
    .join('-')
    .concat(`.${extension}`);
}

export function normalizeMonthScope(value: string): string {
  const trimmed = value.trim();
  if (MONTH_DASHED_PATTERN.test(trimmed)) return trimmed;
  const compact = trimmed.match(MONTH_COMPACT_PATTERN);
  if (compact) return `${compact[1]}-${compact[2]}`;
  return sanitizeFilenamePart(trimmed, 'all');
}

export function formatBangkokDateScope(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'all';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BANGKOK_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get('year')}-${values.get('month')}-${values.get('day')}`;
}

export function buildDateRangeScope(
  from?: string | Date,
  to?: string | Date,
): string {
  const start = from ? formatBangkokDateScope(from) : '';
  const end = to ? formatBangkokDateScope(to) : '';
  if (start === 'all' && from) return 'all';
  if (end === 'all' && to) return 'all';
  if (start && end) return start === end ? start : `${start}_to_${end}`;
  if (start) return `from_${start}`;
  if (end) return `to_${end}`;
  return 'all';
}

export function resolveOrderExportDateScope(
  input: OrderExportDateScopeInput,
  now = new Date(),
): string {
  if (input.saleMonth) return normalizeMonthScope(input.saleMonth);
  if (input.period === 'today') return formatBangkokDateScope(now);
  return buildDateRangeScope(input.saleFrom, input.saleTo);
}
