import { useCallback, useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import * as chatApi from '../api/chat';
import { armSound, playMessageSound } from '../utils/notifySound';

const POLL_MS = 10_000;
const COUNT_PREFIX = /^\(\d+\)\s*/;

// "(2) Euphoria" in the tab title, so a message is visible even when the tab is in the background.
function showUnreadInTitle(total) {
  const base = document.title.replace(COUNT_PREFIX, '');
  document.title = total > 0 ? `(${total}) ${base}` : base;
}

/**
 * Site-wide "you have a new message" beep. Renders nothing.
 *
 * It checks the inbox every few seconds (and the moment the tab regains focus) and beeps when
 * any conversation has more unread messages than last time. The conversation you are looking at
 * is skipped here because ConversationView plays its own beep for messages arriving live.
 * The first check only records the starting point, so opening the site never beeps for old mail.
 */
export default function MessageNotifier() {
  const { user } = useAuth();
  const { pathname } = useLocation();
  const pathRef = useRef(pathname);
  const seenRef = useRef(null); // Map of conversation id -> unread count from the last check

  const check = useCallback(async () => {
    let data;
    try {
      data = await chatApi.listConversations();
    } catch {
      return; // offline or signed out: try again on the next tick
    }
    const list = data.results ?? data;
    const next = new Map(list.map((c) => [String(c.id), c.unread_count || 0]));
    const prev = seenRef.current;
    seenRef.current = next;

    let total = 0;
    next.forEach((n) => { total += n; });
    showUnreadInTitle(total);
    if (!prev) return;

    const viewing = /^\/chat\/([^/]+)/.exec(pathRef.current)?.[1];
    let fresh = false;
    next.forEach((n, id) => {
      if (n > (prev.get(id) || 0) && id !== viewing) fresh = true;
    });
    if (fresh) playMessageSound();
  }, []);

  useEffect(() => {
    if (!user) {
      seenRef.current = null;
      showUnreadInTitle(0);
      return undefined;
    }
    const disarm = armSound();
    const tick = () => { if (document.visibilityState === 'visible') check(); };
    check();
    const timer = setInterval(check, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('focus', tick);
    window.addEventListener('online', tick);
    return () => {
      disarm();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
      window.removeEventListener('focus', tick);
      window.removeEventListener('online', tick);
    };
  }, [user, check]);

  // After moving between pages (e.g. opening a chat marks it read), refresh the count soon.
  useEffect(() => {
    pathRef.current = pathname;
    if (!user) return undefined;
    const t = setTimeout(check, 1500);
    return () => clearTimeout(t);
  }, [pathname, user, check]);

  return null;
}
