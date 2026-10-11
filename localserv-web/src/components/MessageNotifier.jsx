import { useCallback, useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useInbox } from '../context/InboxSocketContext';
import * as chatApi from '../api/chat';
import { armSound, notifyDevice, playMessageSound } from '../utils/notifySound';
import { useAlerts } from '../context/AlertsContext';
import { useInboxEvent, useInboxSync } from '../hooks/useInboxSync';

const FALLBACK_POLL_MS = 30_000; // only used while the live socket is down
const COUNT_PREFIX = /^\(\d+\)\s*/;

// "(2) Euphoria" in the tab title, so a message is visible even when the tab is in the background.
function showUnreadInTitle(total) {
  const base = document.title.replace(COUNT_PREFIX, '');
  document.title = total > 0 ? `(${total}) ${base}` : base;
}

/**
 * Site-wide "you have a new message" beep. Renders nothing.
 *
 * The server pushes a tiny "message" event over the shared site-wide socket the moment someone writes
 * to you (and a "read" event when a chat is read on another tab or device), so the counts are kept
 * up to date without asking the server anything. A slow refresh (every few minutes, and whenever the
 * socket reconnects or the tab wakes) corrects any drift; if the socket is down it polls every 30s instead.
 * Beeps when any conversation has more unread messages than before. The conversation you are looking
 * at is skipped here because ConversationView plays its own beep for messages arriving live.
 * The first fetch only records the starting point, so opening the site never beeps for old mail.
 */
export default function MessageNotifier() {
  const { user } = useAuth();
  const { pathname } = useLocation();
  const { connected } = useInbox();
  const { missedCalls, setMessages } = useAlerts();
  const missedRef = useRef(0);
  const totalRef = useRef(0);
  const pathRef = useRef(pathname);
  const seenRef = useRef(null); // Map of conversation id -> unread count from the last update

  // Take a new set of counts: update the badge + tab title, and beep if any chat gained messages.
  const apply = useCallback((next, prev) => {
    seenRef.current = next;
    let total = 0;
    next.forEach((n) => { total += n; });
    totalRef.current = total;
    setMessages(total);
    showUnreadInTitle(total + missedRef.current);
    if (!prev) return;

    const viewing = /^\/chat\/([^/]+)/.exec(pathRef.current)?.[1];
    let fresh = false;
    next.forEach((n, id) => {
      if (n > (prev.get(id) || 0) && id !== viewing) fresh = true;
    });
    if (fresh) {
      playMessageSound();
      notifyDevice('New message', 'Open Euphoria to read it.'); // OS plays its own tone when the tab is hidden
    }
  }, [setMessages]);

  const check = useCallback(async () => {
    let data;
    try {
      data = await chatApi.getUnreadSummary();
    } catch {
      return; // offline or signed out: try again later
    }
    const next = new Map(Object.entries(data?.by_conversation || {}).map(([id, n]) => [String(id), n || 0]));
    apply(next, seenRef.current);
  }, [apply]);

  // Live updates from the server.
  useInboxEvent((e) => {
    if (e.type !== 'message' && e.type !== 'read') return;
    const prev = seenRef.current;
    if (!prev) { check(); return; } // the first fetch has not landed yet: just fetch
    const id = String(e.conversation_id);
    const next = new Map(prev);
    if (e.type === 'message') next.set(id, (prev.get(id) || 0) + 1);
    else next.delete(id);
    apply(next, prev);
  });

  useEffect(() => {
    if (!user) {
      seenRef.current = null;
      totalRef.current = 0;
      setMessages(0);
      showUnreadInTitle(0);
      return undefined;
    }
    return armSound();
  }, [user, setMessages]);

  // Fetch on sign-in and on every socket reconnect; then a slow refresh (a background tab keeps going
  // too, so its title and device notification stay right).
  useInboxSync(check, { key: user?.id, fallbackMs: FALLBACK_POLL_MS, whileHidden: true });

  // Missed calls count towards the tab title too
  useEffect(() => {
    missedRef.current = missedCalls;
    if (user) showUnreadInTitle(totalRef.current + missedCalls);
  }, [missedCalls, user]);

  // Only without the live socket: after moving between pages (e.g. opening a chat marks it read),
  // refresh the count soon. With the socket, the server's "read" event does this.
  useEffect(() => {
    pathRef.current = pathname;
    if (!user || connected) return undefined;
    const t = setTimeout(check, 1500);
    return () => clearTimeout(t);
  }, [pathname, user, check, connected]);

  return null;
}
