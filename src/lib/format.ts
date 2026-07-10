// Tiny formatting helpers shared across views.

export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

/**
 * Truncate a string in the middle so both the head and tail remain
 * readable — useful for long DNS names like
 * `aphrodite.barb-kardashev.ts.net` → `aphrod…ts.net`.
 *
 * `max` is the maximum output length including the ellipsis character.
 */
export function middleTruncate(s: string, max = 24): string {
  if (typeof s !== 'string') return '';
  if (max < 2) return '…';
  if (s.length <= max) return s;
  // Prefer a slightly longer head (host label) over the TLD tail.
  const budget = max - 1; // room for …
  const head = Math.max(1, Math.ceil(budget * 0.55));
  const tail = Math.max(1, budget - head);
  return s.slice(0, head) + '…' + s.slice(s.length - tail);
}
