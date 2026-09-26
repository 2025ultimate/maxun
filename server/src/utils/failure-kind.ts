/**
 * Classify a scrape/run failure as 'engine' (Maxun's own infra: browser pool,
 * proxy, browser crash) or 'page' (the target site's fault: nav/timeout/404).
 *
 * The client's worker treats 'engine' as Maxun's fault and backs off; 'page'
 * is attributed to the site. Keep the engine marker wording stable.
 */
const ENGINE_MARKERS = [
  'ERR_TUNNEL_CONNECTION_FAILED',
  'ERR_PROXY_CONNECTION_FAILED',
  'browser has been closed',
  'Target closed',
  'Could not create a new page',
  'browser pool',
  'Browser slot',
  'maximum browser limit',
  'no available slots',
  'Failed to initialize browser',
  'Failed to connect to browser service',
  'Failed to start scrape',
  'Failed to start robot execution',
  'User has reached maximum browser limit',
];

export type FailureKind = 'engine' | 'page';

export function classifyFailure(message: string | undefined | null): FailureKind {
  const m = (message || '').toString();
  for (const marker of ENGINE_MARKERS) {
    if (m.includes(marker)) return 'engine';
  }
  return 'page';
}
