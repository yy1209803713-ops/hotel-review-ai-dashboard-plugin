export type HostDataItem = {
  value?: string | number | null;
  text?: string | null;
  groupKey?: string | number | null;
};

export type HostData = HostDataItem[][];

export function parseHostVisibleReviewIds(data: unknown): Set<string> | null {
  if (!Array.isArray(data) || data.length < 2) {
    return null;
  }

  const ids = new Set<string>();
  for (const row of data.slice(1)) {
    if (!Array.isArray(row)) {
      return null;
    }

    const firstCell = row[0] as HostDataItem | undefined;
    const rawId = firstCell?.groupKey;
    if (rawId === null || rawId === undefined || String(rawId).trim() === '') {
      return null;
    }
    ids.add(String(rawId).trim());
  }

  return ids.size ? ids : null;
}

export function buildHostDataSignal(data: unknown): string {
  const ids = parseHostVisibleReviewIds(data);
  if (!ids) {
    return 'host-data-unsupported';
  }
  return `host-visible-review-ids:${Array.from(ids).sort().join('|')}`;
}
