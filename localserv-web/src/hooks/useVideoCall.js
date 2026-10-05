import { useCallback, useEffect, useRef, useState } from 'react';
import { WS_BASE } from '../api/client';
import { getIceServers } from '../api/chat';
import { setInCall } from '../utils/callActivity';
import { applySenderLimits, callMediaConstraints, isDataSaverOn, subscribeDataSaver } from '../utils/dataSaver';

/*
 * One-to-one video calling over WebRTC.
 *
 * The server only relays signaling (offers, answers, ICE candidates) over
 * /ws/call/<conversation_id>/. Video and audio go straight between the two
 * browsers, or through a TURN relay when a direct path isn't possible.
 *
 * status: 'idle' | 'calling' | 'incoming' | 'connecting' | 'active' | 'ended'
 * mode:   'video' | 'voice'
 */

const RING_TIMEOUT_MS = 45_000;
const MIN_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 15_000;
// Only seen if the server accept()s first and then closes with a custom code.
const NO_RETRY = new Set([4401, 4403, 4404]);
// A close BEFORE accept() (anonymous, not a participant, group chat, blocked) reaches the
// browser as a generic 403 / code 1006, never as 4401 etc. So also stop after this many
// handshakes in a row that never opened.
const MAX_FAILED_OPENS = 5;

const callSocketUrl = (conversationId) => `${WS_BASE}/ws/call/${conversationId}/`;

// A voice call is the same WebRTC call without a video track, so the callee can tell
// from the offer itself (no m=video line) which kind it is. Nothing new for the server to relay.
const offerIsVoice = (sdp) => !/^m=video/m.test(sdp || '');

// ICE servers come from the backend (/api/chat/ice-servers/): a STUN entry plus a TURN
// entry with short-lived credentials, so no TURN secret ever ships in the JS bundle.
// If that request fails we fall back to public STUN, which works on most home networks.
const FALLBACK_ICE = [{ urls: import.meta.env.VITE_STUN_URL || 'stun:stun.l.google.com:19302' }];
let iceCache = null; // { servers, expiresAt }

async function loadIceServers() {
  if (iceCache && iceCache.expiresAt > Date.now() + 60_000) return iceCache.servers;
  try {
    const data = await getIceServers();
    if (Array.isArray(data?.ice_servers) && data.ice_servers.length) {
      iceCache = {
        servers: data.ice_servers,
        expiresAt: Date.now() + (data.ttl || 3600) * 1000,
      };
      return iceCache.servers;
    }
  } catch { /* fall through to STUN-only */ }
  return FALLBACK_ICE;
}

function friendlyMediaError(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera or microphone access is blocked. Allow it in your browser\u2019s address bar, then try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera or microphone was found on this device.';
    case 'NotReadableError':
      return 'Your camera or microphone is being used by another app. Close it and try again.';
    default:
      return 'Could not start your camera. Please try again.';
  }
}

export function useVideoCall({ conversationId, myId, enabled = true }) {
  const [status, setStatus] = useState('idle');
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [facing, setFacing] = useState('user');
  const [notice, setNotice] = useState('');
  const [signalReady, setSignalReady] = useState(false);
  const [mode, setMode] = useState('video');

  const statusRef = useRef('idle');
  const modeRef = useRef('video');
  const wsRef = useRef(null);
  const pcRef = useRef(null);
  const localRef = useRef(null);
  const pendingOfferRef = useRef(null);
  const pendingIceRef = useRef([]);
  const ringTimerRef = useRef(null);
  const closedRef = useRef(false);

  const setStatusBoth = useCallback((next) => {
    statusRef.current = next;
    setInCall(next !== 'idle' && next !== 'ended');
    setStatus(next);
  }, []);

  const setModeBoth = useCallback((next) => {
    modeRef.current = next;
    setMode(next);
  }, []);

  const send = useCallback((payload) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }, []);

  /* ---------- teardown ---------- */

  const cleanup = useCallback(() => {
    clearTimeout(ringTimerRef.current);
    if (pcRef.current) {
      pcRef.current.ontrack = null;
      pcRef.current.onicecandidate = null;
      pcRef.current.onconnectionstatechange = null;
      pcRef.current.close();
      pcRef.current = null;
    }
    localRef.current?.getTracks().forEach((t) => t.stop());
    localRef.current = null;
    pendingOfferRef.current = null;
    pendingIceRef.current = [];
    setLocalStream(null);
    setRemoteStream(null);
    setMicOn(true);
    setCamOn(true);
  }, []);

  const finish = useCallback((message = '') => {
    cleanup();
    setNotice(message);
    setStatusBoth(message ? 'ended' : 'idle');
  }, [cleanup, setStatusBoth]);

  /* ---------- peer connection ---------- */

  const createPeer = useCallback(async () => {
    const pc = new RTCPeerConnection({ iceServers: await loadIceServers() });
    pc.onicecandidate = (e) => send({ type: 'ice', candidate: e.candidate ? e.candidate.toJSON() : null });
    pc.ontrack = (e) => setRemoteStream(e.streams[0] || new MediaStream([e.track]));
    pc.onconnectionstatechange = () => {
      if (pc !== pcRef.current) return;
      if (pc.connectionState === 'connected') {
        clearTimeout(ringTimerRef.current);
        setStatusBoth('active');
      } else if (pc.connectionState === 'failed') {
        send({ type: 'hangup' });
        finish('The connection failed. Check your network and try again.');
      }
    };
    pcRef.current = pc;
    return pc;
  }, [finish, send, setStatusBoth]);

  const openMedia = useCallback(async (facingMode = 'user', withVideo = true) => {
    const stream = await navigator.mediaDevices.getUserMedia(
      callMediaConstraints(isDataSaverOn(), facingMode, withVideo),
    );
    localRef.current = stream;
    setLocalStream(stream);
    return stream;
  }, []);

  const flushPendingIce = useCallback(async () => {
    const pc = pcRef.current;
    const queued = pendingIceRef.current;
    pendingIceRef.current = [];
    for (const candidate of queued) {
      try { await pc.addIceCandidate(candidate); } catch { /* stale candidate; ignore */ }
    }
  }, []);

  // The call socket may still be connecting (or reconnecting after a dropped signal),
  // so give it a few seconds before telling the person it can't be reached.
  const waitForSignal = useCallback(async (ms = 5000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (wsRef.current?.readyState === WebSocket.OPEN) return true;
      await new Promise((resolve) => { setTimeout(resolve, 200); });
    }
    return wsRef.current?.readyState === WebSocket.OPEN;
  }, []);

  /* ---------- actions ---------- */

  const startCall = useCallback(async (kind = 'video') => {
    if (statusRef.current !== 'idle' && statusRef.current !== 'ended') return;
    const voice = kind === 'voice';
    if (!navigator.mediaDevices?.getUserMedia) {
      setNotice(window.isSecureContext === false
        ? 'Calls only work on a secure (https) page. Open this site with https and try again.'
        : 'This browser can\u2019t make calls. Try the latest Chrome or Safari.');
      setStatusBoth('ended');
      return;
    }
    setNotice('');
    setModeBoth(voice ? 'voice' : 'video');
    setStatusBoth('calling');
    try {
      if (!(await waitForSignal())) throw new Error('signal');
      const stream = await openMedia(facing, !voice);
      const pc = await createPeer();
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));
      await applySenderLimits(pc, isDataSaverOn());
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (!send({ type: 'offer', sdp: offer.sdp })) throw new Error('signal');
      ringTimerRef.current = setTimeout(() => {
        send({ type: 'hangup' });
        finish('No answer.');
      }, RING_TIMEOUT_MS);
    } catch (err) {
      cleanup();
      setNotice(err?.message === 'signal'
        ? 'Can\u2019t reach the call service right now. Check your connection and try again.'
        : friendlyMediaError(err));
      setStatusBoth('ended');
    }
  }, [cleanup, createPeer, facing, finish, openMedia, send, setModeBoth, setStatusBoth, waitForSignal]);

  const acceptCall = useCallback(async () => {
    const offer = pendingOfferRef.current;
    if (statusRef.current !== 'incoming' || !offer) return;
    setStatusBoth('connecting');
    try {
      const stream = await openMedia(facing, modeRef.current === 'video');
      const pc = await createPeer();
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));
      await applySenderLimits(pc, isDataSaverOn());
      await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
      await flushPendingIce();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({ type: 'answer', sdp: answer.sdp });
    } catch (err) {
      send({ type: 'reject' });
      cleanup();
      setNotice(friendlyMediaError(err));
      setStatusBoth('ended');
    }
  }, [cleanup, createPeer, facing, flushPendingIce, openMedia, send, setStatusBoth]);

  const declineCall = useCallback(() => {
    send({ type: 'reject' });
    finish('');
  }, [finish, send]);

  const hangUp = useCallback(() => {
    send({ type: 'hangup' });
    finish('');
  }, [finish, send]);

  const dismiss = useCallback(() => {
    setNotice('');
    setStatusBoth('idle');
  }, [setStatusBoth]);

  const toggleMic = useCallback(() => {
    const next = !micOn;
    localRef.current?.getAudioTracks().forEach((t) => { t.enabled = next; });
    setMicOn(next);
  }, [micOn]);

  const toggleCam = useCallback(() => {
    const next = !camOn;
    localRef.current?.getVideoTracks().forEach((t) => { t.enabled = next; });
    setCamOn(next);
  }, [camOn]);

  // Swap between front and back cameras (phones/tablets) without dropping the call.
  const flipCamera = useCallback(async () => {
    const nextFacing = facing === 'user' ? 'environment' : 'user';
    try {
      const fresh = await navigator.mediaDevices.getUserMedia({
        video: callMediaConstraints(isDataSaverOn(), nextFacing, true).video,
      });
      const track = fresh.getVideoTracks()[0];
      track.enabled = camOn;
      const sender = pcRef.current?.getSenders().find((s) => s.track?.kind === 'video');
      if (sender) await sender.replaceTrack(track);
      const old = localRef.current;
      old?.getVideoTracks().forEach((t) => { old.removeTrack(t); t.stop(); });
      old?.addTrack(track);
      setLocalStream(new MediaStream(old ? old.getTracks() : [track]));
      setFacing(nextFacing);
    } catch {
      setNotice('Could not switch cameras on this device.');
    }
  }, [camOn, facing]);

  // Switching Data saver on or off during a call changes the quality right away.
  useEffect(() => subscribeDataSaver(() => { applySenderLimits(pcRef.current, isDataSaverOn()); }), []);

  /* ---------- incoming signals ---------- */

  const handleSignal = useCallback(async (data) => {
    const fromMe = data.from === String(myId);

    // Another tab or device of mine: only react by dismissing a ringing call.
    if (fromMe) {
      if (statusRef.current === 'incoming' && ['answer', 'reject', 'hangup'].includes(data.type)) {
        finish(data.type === 'answer' ? 'Answered on another device.' : '');
      }
      return;
    }

    switch (data.type) {
      case 'offer':
        // The server replays a ringing offer whenever this socket reconnects. Same offer, same call.
        if (statusRef.current === 'incoming' && pendingOfferRef.current?.sdp === data.sdp) return;
        if (statusRef.current !== 'idle' && statusRef.current !== 'ended') {
          send({ type: 'busy' });
          return;
        }
        pendingOfferRef.current = data;
        pendingIceRef.current = [];
        setModeBoth(offerIsVoice(data.sdp) ? 'voice' : 'video');
        setNotice('');
        setStatusBoth('incoming');
        ringTimerRef.current = setTimeout(() => finish('Missed call.'), RING_TIMEOUT_MS);
        break;
      case 'answer':
        if (statusRef.current === 'calling' && pcRef.current) {
          clearTimeout(ringTimerRef.current);
          setStatusBoth('connecting');
          try {
            await pcRef.current.setRemoteDescription({ type: 'answer', sdp: data.sdp });
            await flushPendingIce();
          } catch {
            send({ type: 'hangup' });
            finish('Could not connect the call.');
          }
        }
        break;
      case 'ice': {
        const candidate = data.candidate;
        if (!candidate) break;
        if (pcRef.current?.remoteDescription) {
          try { await pcRef.current.addIceCandidate(candidate); } catch { /* ignore */ }
        } else {
          pendingIceRef.current.push(candidate);
        }
        break;
      }
      case 'reject':
        if (statusRef.current === 'calling') finish('Call declined.');
        break;
      case 'busy':
        if (statusRef.current === 'calling') finish('They are on another call.');
        break;
      case 'hangup':
        if (statusRef.current !== 'idle') finish(statusRef.current === 'incoming' ? 'Missed call.' : 'Call ended.');
        break;
      default:
        break;
    }
  }, [finish, flushPendingIce, myId, send, setModeBoth, setStatusBoth]);

  /* ---------- signaling socket ---------- */

  const handleSignalRef = useRef(handleSignal);
  useEffect(() => { handleSignalRef.current = handleSignal; }, [handleSignal]);

  useEffect(() => {
    if (!enabled || !conversationId) return undefined;
    closedRef.current = false;
    let reconnectTimer;
    let attempt = 0;
    let failedOpens = 0;

    const connect = () => {
      clearTimeout(reconnectTimer);
      const current = wsRef.current;
      if (closedRef.current || (current && current.readyState <= WebSocket.OPEN)) return;

      const ws = new WebSocket(callSocketUrl(conversationId));
      wsRef.current = ws;
      let didOpen = false;

      ws.onopen = () => {
        didOpen = true;
        attempt = 0;
        failedOpens = 0;
        setSignalReady(true);
      };
      ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.type === 'error') setNotice(data.detail);
          else handleSignalRef.current(data);
        } catch { /* ignore malformed frames */ }
      };
      ws.onclose = (e) => {
        if (wsRef.current === ws) wsRef.current = null;
        setSignalReady(false);
        if (closedRef.current || NO_RETRY.has(e.code)) return;
        if (!didOpen) {
          failedOpens += 1;
          if (failedOpens >= MAX_FAILED_OPENS) return; // server keeps rejecting us; stop
        }
        const delay = Math.min(MAX_RECONNECT_MS, MIN_RECONNECT_MS * 2 ** attempt);
        attempt += 1;
        reconnectTimer = setTimeout(connect, delay);
      };
    };

    // Tab visible again or network back: start a fresh round if the socket is down.
    const wake = () => {
      if (document.visibilityState !== 'visible') return;
      const current = wsRef.current;
      if (!current || current.readyState > WebSocket.OPEN) {
        attempt = 0;
        failedOpens = 0;
        connect();
      }
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    connect();

    // Closing the tab mid-call should end it for the other person right away.
    const onUnload = () => {
      if (statusRef.current !== 'idle' && statusRef.current !== 'ended') send({ type: 'hangup' });
    };
    window.addEventListener('pagehide', onUnload);

    return () => {
      closedRef.current = true;
      clearTimeout(reconnectTimer);
      window.removeEventListener('pagehide', onUnload);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
      onUnload();
      wsRef.current?.close();
      wsRef.current = null;
      cleanup();
      statusRef.current = 'idle';
      setInCall(false);
    };
  }, [cleanup, conversationId, enabled, send]);

  return {
    status, mode, notice, signalReady,
    localStream, remoteStream,
    micOn, camOn, facing,
    startCall, acceptCall, declineCall, hangUp, dismiss,
    toggleMic, toggleCam, flipCamera,
  };
}
