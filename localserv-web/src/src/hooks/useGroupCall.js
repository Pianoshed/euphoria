import { useCallback, useEffect, useRef, useState } from 'react';
import { WS_BASE } from '../api/client';
import { setInCall } from '../utils/callActivity';
import { applySenderLimits, callMediaConstraints, isDataSaverOn, subscribeDataSaver } from '../utils/dataSaver';
import { friendlyMediaError, loadIceServers } from './useVideoCall';

/*
 * Group calling over WebRTC (voice or video, several people at once).
 *
 * A mesh: this browser keeps one RTCPeerConnection per other person. The server only relays
 * offers, answers and ICE, addressed to a person, over /ws/gcall/<conversation_id>/.
 *
 *   - Opening the socket does not join. join(kind) does.
 *   - The person who joins sends an offer to everyone already on the call. Nobody else ever
 *     offers first, so there is no "both offered at once" clash to untangle.
 *   - If the signaling socket drops mid-call, the media keeps flowing for a moment; we reconnect,
 *     join again and rebuild the connections.
 *
 * status: 'idle' | 'joining' | 'active' | 'ended'
 */

const MIN_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 15_000;
const NO_RETRY = new Set([4401, 4403, 4404]);
const MAX_FAILED_OPENS = 5;
const gcallSocketUrl = (conversationId) => `${WS_BASE}/ws/gcall/${conversationId}/`;

export function useGroupCall({ conversationId, myId, enabled = true }) {
  const [status, setStatus] = useState('idle');
  const [mode, setMode] = useState('video');
  const [notice, setNotice] = useState('');
  const [signalReady, setSignalReady] = useState(false);
  const [localStream, setLocalStream] = useState(null);
  const [remotes, setRemotes] = useState({}); // { [userId]: MediaStream | null }  (null = still connecting)
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [facing, setFacing] = useState('user');

  const statusRef = useRef('idle');
  const modeRef = useRef('video');
  const wsRef = useRef(null);
  const pcsRef = useRef(new Map());        // userId -> RTCPeerConnection
  const iceQueueRef = useRef(new Map());   // userId -> candidates that arrived before the offer/answer
  const localRef = useRef(null);
  const closedRef = useRef(false);
  const wantJoinRef = useRef(null);        // 'voice' | 'video' while we should be on the call (used to rejoin)

  const setStatusBoth = useCallback((next) => {
    statusRef.current = next;
    setInCall(next === 'joining' || next === 'active');
    setStatus(next);
  }, []);

  const send = useCallback((payload) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(payload)); return true; }
    return false;
  }, []);

  /* ---------- peers ---------- */

  const dropPeer = useCallback((userId) => {
    const pc = pcsRef.current.get(userId);
    if (pc) {
      pc.ontrack = null; pc.onicecandidate = null; pc.onconnectionstatechange = null;
      pc.close();
      pcsRef.current.delete(userId);
    }
    iceQueueRef.current.delete(userId);
    setRemotes((r) => { if (!(userId in r)) return r; const { [userId]: _gone, ...rest } = r; return rest; });
  }, []);

  const dropAllPeers = useCallback(() => {
    [...pcsRef.current.keys()].forEach(dropPeer);
    setRemotes({});
  }, [dropPeer]);

  const makePeer = useCallback(async (userId) => {
    dropPeer(userId); // a fresh connection replaces any old one (e.g. that person rejoined)
    const pc = new RTCPeerConnection({ iceServers: await loadIceServers() });
    pc.onicecandidate = (e) => send({ type: 'ice', to: userId, candidate: e.candidate ? e.candidate.toJSON() : null });
    pc.ontrack = (e) => {
      const stream = e.streams[0] || new MediaStream([e.track]);
      setRemotes((r) => ({ ...r, [userId]: stream }));
    };
    pc.onconnectionstatechange = () => {
      if (pcsRef.current.get(userId) !== pc) return;
      if (pc.connectionState === 'failed') dropPeer(userId); // that one link failed; the rest of the call carries on
    };
    localRef.current?.getTracks().forEach((t) => pc.addTrack(t, localRef.current));
    await applySenderLimits(pc, isDataSaverOn());
    pcsRef.current.set(userId, pc);
    setRemotes((r) => (userId in r ? r : { ...r, [userId]: null }));
    return pc;
  }, [dropPeer, send]);

  const flushIce = useCallback(async (userId) => {
    const pc = pcsRef.current.get(userId);
    const queued = iceQueueRef.current.get(userId) || [];
    iceQueueRef.current.delete(userId);
    for (const candidate of queued) {
      try { await pc.addIceCandidate(candidate); } catch { /* stale candidate */ }
    }
  }, []);

  const offerTo = useCallback(async (userId) => {
    const pc = await makePeer(userId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({ type: 'offer', to: userId, sdp: offer.sdp });
  }, [makePeer, send]);

  /* ---------- teardown ---------- */

  const cleanup = useCallback(() => {
    dropAllPeers();
    localRef.current?.getTracks().forEach((t) => t.stop());
    localRef.current = null;
    wantJoinRef.current = null;
    setLocalStream(null);
    setMicOn(true);
    setCamOn(true);
  }, [dropAllPeers]);

  const finish = useCallback((message = '') => {
    cleanup();
    setNotice(message);
    setStatusBoth(message ? 'ended' : 'idle');
  }, [cleanup, setStatusBoth]);

  /* ---------- actions ---------- */

  const waitForSignal = useCallback(async (ms = 5000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (wsRef.current?.readyState === WebSocket.OPEN) return true;
      await new Promise((resolve) => { setTimeout(resolve, 200); });
    }
    return wsRef.current?.readyState === WebSocket.OPEN;
  }, []);

  const join = useCallback(async (kind = 'video') => {
    if (statusRef.current === 'joining' || statusRef.current === 'active') return;
    const voice = kind === 'voice';
    if (!navigator.mediaDevices?.getUserMedia) {
      setNotice(window.isSecureContext === false
        ? 'Calls only work on a secure (https) page. Open this site with https and try again.'
        : 'This browser can\u2019t make calls. Try the latest Chrome or Safari.');
      setStatusBoth('ended');
      return;
    }
    setNotice('');
    modeRef.current = voice ? 'voice' : 'video';
    setMode(modeRef.current);
    setStatusBoth('joining');
    try {
      if (!(await waitForSignal())) throw new Error('signal');
      const stream = await navigator.mediaDevices.getUserMedia(callMediaConstraints(isDataSaverOn(), facing, !voice));
      localRef.current = stream;
      setLocalStream(stream);
      wantJoinRef.current = modeRef.current;
      if (!send({ type: 'join', mode: modeRef.current })) throw new Error('signal');
    } catch (err) {
      cleanup();
      setNotice(err?.message === 'signal'
        ? 'Can\u2019t reach the call service right now. Check your connection and try again.'
        : friendlyMediaError(err));
      setStatusBoth('ended');
    }
  }, [cleanup, facing, send, setStatusBoth, waitForSignal]);

  const leave = useCallback(() => {
    send({ type: 'leave' });
    finish('');
  }, [finish, send]);

  const dismiss = useCallback(() => { setNotice(''); setStatusBoth('idle'); }, [setStatusBoth]);

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

  const flipCamera = useCallback(async () => {
    const nextFacing = facing === 'user' ? 'environment' : 'user';
    try {
      const fresh = await navigator.mediaDevices.getUserMedia({
        video: callMediaConstraints(isDataSaverOn(), nextFacing, true).video,
      });
      const track = fresh.getVideoTracks()[0];
      track.enabled = camOn;
      await Promise.all([...pcsRef.current.values()].map((pc) => {
        const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
        return sender ? sender.replaceTrack(track) : null;
      }));
      const old = localRef.current;
      old?.getVideoTracks().forEach((t) => { old.removeTrack(t); t.stop(); });
      old?.addTrack(track);
      setLocalStream(new MediaStream(old ? old.getTracks() : [track]));
      setFacing(nextFacing);
    } catch {
      setNotice('Could not switch cameras on this device.');
    }
  }, [camOn, facing]);

  useEffect(() => subscribeDataSaver(() => {
    pcsRef.current.forEach((pc) => applySenderLimits(pc, isDataSaverOn()));
  }), []);

  /* ---------- signals from the server ---------- */

  const handleSignal = useCallback(async (data) => {
    try {
      switch (data.type) {
        case 'joined':
          setStatusBoth('active');
          // Newcomer's job: offer to everyone already here.
          await Promise.all((data.peers || []).map((uid) => offerTo(uid).catch(() => dropPeer(uid))));
          break;
        case 'full':
          cleanup();
          setNotice(`This call is full (${data.max} people at most).`);
          setStatusBoth('ended');
          break;
        case 'replaced':
          finish('You joined this call on another device.');
          break;
        case 'peer-joined':
          // Wait for their offer. Show a placeholder tile so the call feels alive straight away.
          setRemotes((r) => (data.user_id in r ? r : { ...r, [data.user_id]: null }));
          break;
        case 'peer-left':
          dropPeer(data.user_id);
          break;
        case 'offer': {
          if (statusRef.current !== 'active') break;
          const pc = await makePeer(data.from);
          await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
          await flushIce(data.from);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          send({ type: 'answer', to: data.from, sdp: answer.sdp });
          break;
        }
        case 'answer': {
          const pc = pcsRef.current.get(data.from);
          if (pc && pc.signalingState === 'have-local-offer') {
            await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
            await flushIce(data.from);
          }
          break;
        }
        case 'ice': {
          if (!data.candidate) break;
          const pc = pcsRef.current.get(data.from);
          if (pc?.remoteDescription) {
            try { await pc.addIceCandidate(data.candidate); } catch { /* ignore */ }
          } else {
            const q = iceQueueRef.current.get(data.from) || [];
            q.push(data.candidate);
            iceQueueRef.current.set(data.from, q);
          }
          break;
        }
        default:
          break;
      }
    } catch {
      if (data.from) dropPeer(data.from);
    }
  }, [cleanup, dropPeer, finish, flushIce, makePeer, offerTo, send, setStatusBoth]);

  const handleSignalRef = useRef(handleSignal);
  useEffect(() => { handleSignalRef.current = handleSignal; }, [handleSignal]);

  /* ---------- signaling socket ---------- */

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
      const ws = new WebSocket(gcallSocketUrl(conversationId));
      wsRef.current = ws;
      let didOpen = false;

      ws.onopen = () => {
        didOpen = true; attempt = 0; failedOpens = 0;
        setSignalReady(true);
        // The socket came back in the middle of a call: the server dropped our seat, so take it again.
        if (wantJoinRef.current && statusRef.current === 'active') {
          dropAllPeers();
          ws.send(JSON.stringify({ type: 'join', mode: wantJoinRef.current }));
        }
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
          if (failedOpens >= MAX_FAILED_OPENS) {
            if (statusRef.current === 'joining') finish('Can\u2019t reach the call service right now.');
            return;
          }
        }
        reconnectTimer = setTimeout(connect, Math.min(MAX_RECONNECT_MS, MIN_RECONNECT_MS * 2 ** attempt));
        attempt += 1;
      };
    };

    const wake = () => {
      if (document.visibilityState !== 'visible') return;
      const current = wsRef.current;
      if (!current || current.readyState > WebSocket.OPEN) { attempt = 0; failedOpens = 0; connect(); }
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    connect();

    const onUnload = () => { if (wantJoinRef.current) send({ type: 'leave' }); };
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
  }, [cleanup, conversationId, dropAllPeers, enabled, finish, send]);

  return {
    status, mode, notice, signalReady, localStream, remotes, micOn, camOn, facing,
    myId, join, leave, dismiss, toggleMic, toggleCam, flipCamera,
  };
}
