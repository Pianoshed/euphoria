import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext';
import * as chatApi from '../api/chat';

/**
 * One place that knows what needs the person's attention, so the header, the menu and the tab title agree:
 *   messages     - unread messages across every conversation (fed by MessageNotifier, which already polls the inbox)
 *   missedCalls  - calls you were not there to answer, since you last opened the Call log
 * "Missed" is read from the same call records the Call log page shows: you were the one called and the
 * call ended as no answer, busy or cancelled by the caller.
 */
const AlertsContext = createContext({ messages: 0, missedCalls: 0, setMessages: () => {}, refreshCalls: () => {} });
export const useAlerts = () => useContext(AlertsContext);

const MISSED = new Set(['no_answer', 'busy', 'cancelled']);
const POLL_MS = 15_000;
const seenKey = (uid) => `calls-seen-v1:${uid}`;
const readSeen = (uid) => { try { return Number(localStorage.getItem(seenKey(uid))) || 0; } catch { return 0; } };
const writeSeen = (uid, t) => { try { localStorage.setItem(seenKey(uid), String(t)); } catch { /* private mode: in-memory only */ } };

export function AlertsProvider({ children }) {
  const { user } = useAuth();
  const { pathname } = useLocation();
  const [messages, setMessages] = useState(0);
  const [missedCalls, setMissedCalls] = useState(0);
  const seenRef = useRef(0);
  const uid = user?.id;

  const refreshCalls = useCallback(async () => {
    if (!uid) return;
    try {
      const data = await chatApi.listCallLogs({ scope: 'mine', page: 1 });
      const rows = data.results ?? data;
      if (seenRef.current === 0 && readSeen(uid) === 0) {
        // first run on this device: start counting from now instead of flagging the whole history
        seenRef.current = Date.now();
        writeSeen(uid, seenRef.current);
      }
      const since = seenRef.current;
      setMissedCalls(rows.filter((r) => r.callee === uid && MISSED.has(r.outcome) && new Date(r.started_at).getTime() > since).length);
    } catch { /* offline or signed out: keep the last number */ }
  }, [uid]);

  useEffect(() => {
    if (!uid) { setMessages(0); setMissedCalls(0); seenRef.current = 0; return undefined; }
    seenRef.current = readSeen(uid);
    refreshCalls();
    const tick = () => { if (document.visibilityState === 'visible') refreshCalls(); };
    const timer = setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('focus', tick);
    window.addEventListener('online', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
      window.removeEventListener('focus', tick);
      window.removeEventListener('online', tick);
    };
  }, [uid, refreshCalls]);

  // Opening the Call log counts as seeing them.
  useEffect(() => {
    if (!uid || !pathname.startsWith('/calls')) return;
    seenRef.current = Date.now();
    writeSeen(uid, seenRef.current);
    setMissedCalls(0);
  }, [pathname, uid]);

  const value = useMemo(() => ({ messages, missedCalls, setMessages, refreshCalls }), [messages, missedCalls, refreshCalls]);
  return <AlertsContext.Provider value={value}>{children}</AlertsContext.Provider>;
}
