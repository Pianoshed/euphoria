import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from './AuthContext';
import { useVideoCall } from '../hooks/useVideoCall';
import VideoCallPanel from '../pages/chat/VideoCallPanel';

/*
 * One call for the whole site, not one per chat page.
 *
 * The call (WebRTC connection, camera, microphone, signaling socket) lives here, above the
 * routes, so it keeps running when the person leaves the chat page. The call screen is drawn
 * from here too, either full-screen or as a small floating bar they can tap to expand.
 *
 * Which conversation's call socket is open:
 *   - while a call is ringing or running: that call's conversation (it stays put, whatever page you open)
 *   - otherwise: the conversation being looked at, so a call to it rings straight away
 */
const CallContext = createContext(null);

export function useCall() {
  const ctx = useContext(CallContext);
  if (!ctx) throw new Error('useCall must be used inside <CallProvider>');
  return ctx;
}

const PENDING_MS = 15_000;

export function CallProvider({ children }) {
  const { user } = useAuth();
  const [viewed, setViewed] = useState(null);
  const [pinned, setPinned] = useState(null);
  const [peers, setPeers] = useState({}); // { [conversationId]: { name, avatar } }
  const [minimized, setMinimized] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [tick, setTick] = useState(0);
  const pendingRef = useRef(null); // { id, type: 'start' | 'accept', kind? }
  const pendingTimer = useRef(null);

  const activeId = pinned ?? viewed;
  const call = useVideoCall({ conversationId: activeId, myId: user?.id, enabled: Boolean(user) });
  const busy = call.status !== 'idle' && call.status !== 'ended';

  // A running call keeps its conversation while the person moves around the site.
  useEffect(() => {
    if (busy) setPinned((p) => p ?? activeId);
    else if (!pendingRef.current) setPinned(null);
  }, [busy, activeId]);

  // A new call starts full-screen; nothing to minimize once it is over.
  useEffect(() => {
    if (!busy) setMinimized(false);
  }, [busy]);
  useEffect(() => {
    if (call.status === 'calling' || call.status === 'incoming') setMinimized(false);
  }, [call.status]);

  const clearPending = useCallback(() => {
    clearTimeout(pendingTimer.current);
    pendingRef.current = null;
    setAccepting(false);
  }, []);

  // Carry out a "start this call" or "answer that ring" once this conversation's socket is the active one.
  const { status, startCall, acceptCall } = call;
  useEffect(() => {
    const p = pendingRef.current;
    if (!p || p.id !== activeId) return;
    if (p.type === 'start' && (status === 'idle' || status === 'ended')) {
      clearPending();
      startCall(p.kind);
    } else if (p.type === 'accept' && status === 'incoming') {
      clearPending();
      acceptCall();
    }
  }, [activeId, status, startCall, acceptCall, tick, clearPending]);

  const schedulePending = useCallback((pending) => {
    clearTimeout(pendingTimer.current);
    pendingRef.current = pending;
    pendingTimer.current = setTimeout(() => {
      pendingRef.current = null;
      setAccepting(false);
      setTick((t) => t + 1); // lets the "idle -> unpin" rule run again
    }, PENDING_MS);
    setPinned(pending.id);
    setTick((t) => t + 1);
  }, []);

  const startCallIn = useCallback((conversationId, kind, peer) => {
    if (peer) setPeers((p) => ({ ...p, [conversationId]: peer }));
    schedulePending({ id: conversationId, type: 'start', kind });
  }, [schedulePending]);

  const acceptIncoming = useCallback((conversationId, peer) => {
    if (peer) setPeers((p) => ({ ...p, [conversationId]: peer }));
    setAccepting(true);
    schedulePending({ id: conversationId, type: 'accept' });
  }, [schedulePending]);

  const setViewedConversation = useCallback((id) => { setViewed(id); }, []);
  const clearViewedConversation = useCallback((id) => {
    setViewed((v) => (v === id ? null : v));
  }, []);
  const setPeer = useCallback((conversationId, peer) => {
    setPeers((p) => {
      const old = p[conversationId];
      return old && old.name === peer.name && old.avatar === peer.avatar ? p : { ...p, [conversationId]: peer };
    });
  }, []);

  useEffect(() => () => clearTimeout(pendingTimer.current), []);

  const peer = (activeId && peers[activeId]) || { name: 'Call', avatar: null };

  const value = useMemo(() => ({
    call, activeId, busy, peer, minimized, setMinimized,
    startCallIn, acceptIncoming, setViewedConversation, clearViewedConversation, setPeer,
  // `call` is a fresh object each render, so this recomputes whenever the call changes. That is intended.
  }), [call, activeId, busy, peer, minimized, startCallIn, acceptIncoming,
    setViewedConversation, clearViewedConversation, setPeer]);

  return (
    <CallContext.Provider value={value}>
      {children}
      {user && (
        <VideoCallPanel
          call={call}
          name={peer.name}
          avatar={peer.avatar}
          minimized={minimized}
          onMinimize={() => setMinimized(true)}
          onExpand={() => setMinimized(false)}
          quiet={accepting}
        />
      )}
    </CallContext.Provider>
  );
}
