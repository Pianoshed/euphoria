import '../pages/chat/call.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { WS_BASE } from '../api/client';
import * as chatApi from '../api/chat';
import * as accountsApi from '../api/accounts';
import { armSound, startRingtone, stopRingtone } from '../utils/notifySound';
import { isInCall } from '../utils/callActivity';

const RING_MS = 45_000; // keep in step with RING_TIMEOUT_MS in useVideoCall and RING_TIMEOUT_SECONDS on the server
const POLL_MS = 6_000;
const MIN_DELAY_MS = 1000;
const MAX_DELAY_MS = 15000;
const NO_RETRY = new Set([4401, 4403]);

// Say one thing (reject / busy) on a conversation's call socket, then hang up the socket.
// Declining from the site-wide ring has no call page open, so this borrows the same signaling path.
function quickSignal(conversationId, type) {
  try {
    const ws = new WebSocket(`${WS_BASE}/ws/call/${conversationId}/`);
    const done = () => { try { ws.close(); } catch { /* already closed */ } };
    ws.onopen = () => { ws.send(JSON.stringify({ type })); setTimeout(done, 400); };
    ws.onerror = done;
  } catch { /* nothing more to try */ }
}

/**
 * Makes an incoming call ring on EVERY page, not only inside the conversation. Renders the ring
 * screen and plays the ringtone. Accepting opens the conversation, whose own call hook does the
 * real WebRTC work (the server replays the ringing offer to it).
 *
 * If you are already looking at the calling conversation, that page rings by itself, so this
 * stays quiet there.
 */
export default function IncomingCallNotifier() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [ring, setRing] = useState(null); // { conversationId, mode, name, avatar }
  const ringRef = useRef(null);
  const pathRef = useRef(pathname);
  const timerRef = useRef(null);
  const socketOpenRef = useRef(false);

  const clear = useCallback((conversationId) => {
    if (conversationId && ringRef.current && ringRef.current.conversationId !== conversationId) return;
    clearTimeout(timerRef.current);
    ringRef.current = null;
    setRing(null);
  }, []);

  const onIncoming = useCallback((info) => {
    const cid = String(info.conversation_id);
    if (ringRef.current?.conversationId === cid) return; // already ringing for this one
    if (/^\/chat\/([^/]+)/.exec(pathRef.current)?.[1] === cid) return; // that page rings itself
    if (isInCall() || ringRef.current) { quickSignal(cid, 'busy'); return; }

    const next = { conversationId: cid, mode: info.mode, name: 'Incoming call', avatar: null };
    ringRef.current = next;
    setRing(next);
    timerRef.current = setTimeout(() => clear(cid), RING_MS);
    accountsApi.getPublicProfile(info.caller_id)
      .then((p) => {
        if (ringRef.current?.conversationId !== cid) return;
        ringRef.current = { ...ringRef.current, name: p.display_name || p.username || 'Someone', avatar: p.avatar || null };
        setRing(ringRef.current);
      })
      .catch(() => {});
  }, [clear]);

  // Opening the calling conversation hands the ring over to that page.
  useEffect(() => {
    pathRef.current = pathname;
    const viewing = /^\/chat\/([^/]+)/.exec(pathname)?.[1];
    if (viewing && ringRef.current?.conversationId === viewing) clear();
  }, [pathname, clear]);

  // The site-wide socket: reconnects on its own, and again when the tab wakes or the network returns.
  useEffect(() => {
    if (!user) { clear(); return undefined; }
    const disarm = armSound();
    let closed = false;
    let attempt = 0;
    let retry;
    let socket = null;

    const open = () => {
      clearTimeout(retry);
      if (closed || (socket && socket.readyState <= WebSocket.OPEN)) return;
      const ws = new WebSocket(`${WS_BASE}/ws/calls/inbox/`);
      socket = ws;
      ws.onopen = () => { attempt = 0; socketOpenRef.current = true; };
      ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.type === 'incoming') onIncoming(data);
          else if (data.type === 'ended') clear(String(data.conversation_id));
        } catch { /* ignore malformed frames */ }
      };
      ws.onclose = (e) => {
        if (socket === ws) socket = null;
        socketOpenRef.current = false;
        if (closed || NO_RETRY.has(e.code)) return;
        retry = setTimeout(open, Math.min(MAX_DELAY_MS, MIN_DELAY_MS * 2 ** attempt));
        attempt += 1;
      };
    };

    const wake = () => {
      if (document.visibilityState !== 'visible') return;
      if (!socket || socket.readyState > WebSocket.OPEN) { attempt = 0; open(); }
    };

    // Safety net: while the socket is down (blocked websockets, flaky network), ask over HTTP.
    const poll = setInterval(async () => {
      if (socketOpenRef.current || document.visibilityState !== 'visible') return;
      try {
        const calls = await chatApi.listIncomingCalls();
        (Array.isArray(calls) ? calls : []).forEach(onIncoming);
      } catch { /* offline or signed out */ }
    }, POLL_MS);

    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    window.addEventListener('focus', wake);
    open();

    return () => {
      closed = true;
      disarm();
      clearTimeout(retry);
      clearInterval(poll);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
      window.removeEventListener('focus', wake);
      socketOpenRef.current = false;
      socket?.close();
    };
  }, [user, onIncoming, clear]);

  const ringing = Boolean(ring);
  useEffect(() => {
    if (!ringing) return undefined;
    startRingtone();
    return stopRingtone;
  }, [ringing]);

  if (!ring) return null;

  const voice = ring.mode === 'voice';
  const accept = () => {
    const cid = ring.conversationId;
    clear();
    navigate(`/chat/${cid}`, { state: { acceptCall: Date.now() } });
  };
  const decline = () => {
    const cid = ring.conversationId;
    clear();
    quickSignal(cid, 'reject');
  };

  return (
    <div className="vc-backdrop">
      <div className="vc-ring" role="alertdialog" aria-modal="true"
        aria-label={`Incoming ${voice ? 'voice' : 'video'} call from ${ring.name}`}>
        {ring.avatar
          ? <img className="vc-face vc-face--pulse" src={ring.avatar} alt="" />
          : <span className="vc-face vc-face--pulse" aria-hidden="true">{(ring.name || '?')[0].toUpperCase()}</span>}
        <h2>{ring.name}</h2>
        <p>{voice ? 'is calling you' : 'is calling you on video'}</p>
        <div className="vc-ring__actions">
          <button type="button" className="vc-btn vc-btn--decline" onClick={decline}>Decline</button>
          <button type="button" className="vc-btn vc-btn--accept" onClick={accept} autoFocus>Accept</button>
        </div>
        <small>{voice ? 'Your microphone turns on when you accept.' : 'Your camera and microphone turn on when you accept.'}</small>
      </div>
    </div>
  );
}
