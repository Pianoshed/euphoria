import { useEffect, useRef, useState } from 'react';
import { WS_BASE } from '../api/client';

const MIN_DELAY_MS = 1000;
const MAX_DELAY_MS = 15000;
// Only seen if the server accept()s first and then closes with a custom code.
const NO_RETRY = new Set([4401, 4403, 4404]); // not signed in / not allowed / not found
// A close BEFORE accept() reaches the browser as a generic 403 (code 1006), never as
// 4401 etc. So also stop after this many handshakes in a row that never opened.
const MAX_FAILED_OPENS = 5;

/**
 * Manages the WebSocket connection for one conversation. Session auth
 * over WS relies on the browser sending the session cookie during the
 * initial HTTP upgrade handshake automatically -- no token needed in
 * the URL.
 *
 * The socket reconnects on its own (backing off from 1s to 15s) and again
 * as soon as the page becomes visible or the network returns. Phones drop
 * sockets all the time -- screen lock, wifi to mobile data -- and a socket
 * that stays closed was why chats only updated after a refresh.
 * `onOpen` fires on every (re)connect so the caller can catch up on
 * anything that arrived while it was away.
 *
 * If the server keeps rejecting the handshake (never reaches onopen), it stops
 * after MAX_FAILED_OPENS tries. Coming back to the tab or regaining network
 * starts a fresh round.
 */
export function useChatSocket(conversationId, { onMessage, onOpen } = {}) {
  const [connected, setConnected] = useState(false);
  const socketRef = useRef(null);
  const onMessageRef = useRef(onMessage);
  const onOpenRef = useRef(onOpen);

  // Keep the refs current without mutating them during render.
  useEffect(() => {
    onMessageRef.current = onMessage;
    onOpenRef.current = onOpen;
  });

  useEffect(() => {
    if (!conversationId) return undefined;

    let closed = false;
    let attempt = 0;
    let failedOpens = 0;
    let timer;

    const open = () => {
      clearTimeout(timer);
      const current = socketRef.current;
      if (closed || (current && current.readyState <= WebSocket.OPEN)) return;

      const socket = new WebSocket(`${WS_BASE}/ws/chat/${conversationId}/`);
      socketRef.current = socket;
      let didOpen = false;

      socket.onopen = () => {
        didOpen = true;
        attempt = 0;
        failedOpens = 0;
        setConnected(true);
        onOpenRef.current?.();
      };
      socket.onerror = () => setConnected(false); // onclose always follows
      socket.onclose = (event) => {
        if (socketRef.current === socket) socketRef.current = null;
        setConnected(false);
        if (closed || NO_RETRY.has(event.code)) return;
        if (!didOpen) {
          failedOpens += 1;
          if (failedOpens >= MAX_FAILED_OPENS) return; // server is rejecting us; stop
        }
        const delay = Math.min(MAX_DELAY_MS, MIN_DELAY_MS * 2 ** attempt);
        attempt += 1;
        timer = setTimeout(open, delay);
      };
      socket.onmessage = (event) => {
        try {
          onMessageRef.current?.(JSON.parse(event.data));
        } catch {
          // Ignore a malformed frame rather than crashing the socket handler.
        }
      };
    };

    const wake = () => {
      if (document.visibilityState !== 'visible') return;
      const current = socketRef.current;
      if (!current || current.readyState > WebSocket.OPEN) {
        attempt = 0;
        failedOpens = 0;
        open();
      }
    };

    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    open();

    return () => {
      closed = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [conversationId]);

  const sendOverSocket = (body) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: 'message', body }));
      return true;
    }
    return false;
  };

  // "I am typing" ping. Throttled here too, so a fast typist sends one every couple of seconds.
  const lastTypingRef = useRef(0);
  const sendTyping = () => {
    const now = Date.now();
    if (now - lastTypingRef.current < 2000 || socketRef.current?.readyState !== WebSocket.OPEN) return;
    lastTypingRef.current = now;
    socketRef.current.send(JSON.stringify({ type: 'typing' }));
  };

  return { connected, sendOverSocket, sendTyping };
}
