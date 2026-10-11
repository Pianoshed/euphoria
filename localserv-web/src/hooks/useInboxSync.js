import { useEffect, useRef } from 'react';
import { useInbox } from '../context/InboxSocketContext';

// While the live socket is up the server tells us when something changes, so this is only a slow
// "make sure we did not miss anything" refresh. While it is down, the caller's own (faster) fallbackMs applies.
export const RECONCILE_MS = 5 * 60_000;
const WAKE_GAP_MS = 10_000; // focus + visibilitychange usually fire together; one refresh is enough

/** Subscribe to the pushed events: useInboxEvent((e) => { if (e.type === 'wallet') refresh(); }) */
export function useInboxEvent(handler) {
  const { subscribe } = useInbox();
  const ref = useRef(handler);
  useEffect(() => { ref.current = handler; });
  useEffect(() => subscribe((e) => ref.current(e)), [subscribe]);
}

/**
 * Keeps `refresh` (a function that fetches something from the API) up to date without hammering the server:
 *   - once when `key` (the signed-in user's id) appears or changes, unless immediate: false
 *   - again whenever the live socket (re)connects, to catch up on anything missed while it was down
 *   - every RECONCILE_MS while the socket is up, every `fallbackMs` while it is down
 *   - when the tab is shown again or the network returns (at most once per WAKE_GAP_MS)
 * Pass whileHidden: true if the timer should also run in a background tab (e.g. to update the tab title).
 */
export function useInboxSync(refresh, { key, fallbackMs, immediate = true, whileHidden = false }) {
  const { connected } = useInbox();
  const refreshRef = useRef(refresh);
  useEffect(() => { refreshRef.current = refresh; });
  const lastRef = useRef(0);

  const run = (minGap) => {
    const now = Date.now();
    if (now - lastRef.current < minGap) return;
    lastRef.current = now;
    refreshRef.current();
  };

  useEffect(() => {
    if (!key) return;
    lastRef.current = 0;
    if (immediate) run(0);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (key && connected) run(1000); // socket (re)connected: catch up
  }, [key, connected]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!key) return undefined;
    const timer = setInterval(() => {
      if (whileHidden || document.visibilityState === 'visible') run(0);
    }, connected ? RECONCILE_MS : fallbackMs);
    const wake = () => { if (document.visibilityState === 'visible') run(WAKE_GAP_MS); };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    window.addEventListener('online', wake);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('focus', wake);
      window.removeEventListener('online', wake);
    };
  }, [key, connected, fallbackMs, whileHidden]); // eslint-disable-line react-hooks/exhaustive-deps
}
