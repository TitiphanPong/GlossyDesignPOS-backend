export function transformOptionalString({
  value,
}: {
  value: unknown;
}): unknown {
  if (value === undefined || value === null) {
    return value;
  }

  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'boolean'
  ) {
    return value.toString();
  }

  return value;
}
