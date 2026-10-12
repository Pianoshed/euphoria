import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from './AuthContext';
import { ACCOUNT_SUSPENDED_EVENT, WS_BASE } from '../api/client';

/**
 * The ONE site-wide socket per open tab (/ws/calls/inbox/). The server pushes small, content-free
 * events down it:
 *   incoming / ended   a call is ringing / is over
 *   message            something new arrived in a conversation   { conversation_id }
 *   read               that conversation was read (on another tab or device)
 *   wallet             money landed in the wallet (no amount is sent)
 *   missed_call        a call was missed
 * Components subscribe with useInboxEvent() and fetch details over the normal API only when told to,
 * so nothing has to poll every few seconds. `connected` is true once the server has said "ready" and false
 * while the socket is down; the notifiers fall back to a slow poll during that time (see useInboxSync).
 *
 * The socket reconnects on its own (1s -> 15s backoff with jitter), and again at once when the tab
 * wakes or the network returns. Phones drop sockets all the time.
 */
const MIN_DELAY_MS = 1000;
const MAX_DELAY_MS = 15000;
const NO_RETRY = new Set([4401, 4403]); // not signed in / account not active

const InboxSocketContext = createContext({ connected: false, subscribe: () => () => {} });
export const useInbox = () => useContext(InboxSocketContext);

export function InboxSocketProvider({ children }) {
  const { user } = useAuth();
  const uid = user?.id;
  const [connected, setConnected] = useState(false);
  const listenersRef = useRef(new Set());

  const subscribe = useCallback((fn) => {
    listenersRef.current.add(fn);
    return () => listenersRef.current.delete(fn);
  }, []);

  useEffect(() => {
    if (!uid) { setConnected(false); return undefined; }
    let closed = false;
    let attempt = 0;
    let retry;
    let socket = null;

    const open = () => {
      clearTimeout(retry);
      if (closed || (socket && socket.readyState <= WebSocket.OPEN)) return;
      const ws = new WebSocket(`${WS_BASE}/ws/calls/inbox/`);
      socket = ws;
      // "Connected" means the server said it pushes events ("ready"), not merely that the socket opened.
      // A server that predates the push (or a proxy that swallowed the frame) keeps the pollers running.
      ws.onopen = () => { attempt = 0; };
      ws.onmessage = (e) => {
        let data;
        try { data = JSON.parse(e.data); } catch { return; } // ignore malformed frames
        if (data.type === 'ready') { setConnected(true); return; }
        listenersRef.current.forEach((fn) => {
          try { fn(data); } catch (err) { console.error('inbox listener failed', err); }
        });
      };
      ws.onclose = (e) => {
        if (socket === ws) socket = null;
        setConnected(false);
        if (closed) return;
        if (e.code === 4403) window.dispatchEvent(new Event(ACCOUNT_SUSPENDED_EVENT)); // suspended/banned: stop and sign out
        if (NO_RETRY.has(e.code)) return;
        retry = setTimeout(open, Math.min(MAX_DELAY_MS, MIN_DELAY_MS * 2 ** attempt) * (0.5 + Math.random()));
        attempt += 1;
      };
    };

    const wake = () => {
      if (document.visibilityState !== 'visible') return;
      if (!socket || socket.readyState > WebSocket.OPEN) { attempt = 0; open(); }
    };

    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    window.addEventListener('focus', wake);
    open();

    return () => {
      closed = true;
      clearTimeout(retry);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
      window.removeEventListener('focus', wake);
      setConnected(false);
      socket?.close();
    };
  }, [uid]);

  const value = useMemo(() => ({ connected, subscribe }), [connected, subscribe]);
  return <InboxSocketContext.Provider value={value}>{children}</InboxSocketContext.Provider>;
}
