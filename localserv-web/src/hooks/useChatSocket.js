import { useEffect, useRef, useState } from 'react';

const WS_BASE = import.meta.env.VITE_WS_BASE || 'ws://localhost:8000';

/**
 * Manages the WebSocket connection for one conversation. Session auth
 * over WS relies on the browser sending the session cookie during the
 * initial HTTP upgrade handshake automatically -- no token needed in
 * the URL. Falls back silently to REST-only (no live push) if the
 * socket fails to connect; the caller still has sendMessage() via
 * REST as the source of truth either way (see ConversationView).
 */
export function useChatSocket(conversationId, { onMessage } = {}) {
  const [connected, setConnected] = useState(false);
  const socketRef = useRef(null);
  const onMessageRef = useRef(onMessage);

  // Runs after every render (no dependency array) -- safe place to
  // keep the ref current without mutating it during render itself,
  // which oxlint's react(refs) rule correctly flags as unsafe under
  // concurrent rendering.
  useEffect(() => {
    onMessageRef.current = onMessage;
  });

  useEffect(() => {
    if (!conversationId) return undefined;

    const socket = new WebSocket(`${WS_BASE}/ws/chat/${conversationId}/`);
    socketRef.current = socket;

    socket.onopen = () => setConnected(true);
    socket.onclose = () => setConnected(false);
    socket.onerror = () => setConnected(false);
    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        onMessageRef.current?.(data);
      } catch {
        // Ignore a malformed frame rather than crashing the socket handler.
      }
    };

    return () => {
      socket.close();
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

  return { connected, sendOverSocket };
}
