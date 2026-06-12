export function isDebugMode(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  const value = new URLSearchParams(window.location.search).get('debug');
  return value === '1' || value === 'true';
}

export function debugLog(scope: string, payload: unknown): void {
  if (!isDebugMode()) {
    return;
  }

  console.info(`[hotel-review-ai][debug] ${scope}`, payload);
}
