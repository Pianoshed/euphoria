import '../../styles/index.css';
import './chat.css';
import { usePageBackdrop } from '../../hooks/usePageBackdrop';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import * as chatApi from '../../api/chat';
import * as accountsApi from '../../api/accounts';
import { API_BASE, apiFetch, apiBlob } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { useChatSocket } from '../../hooks/useChatSocket';
import { useCall } from '../../context/CallContext';
import { useDataSaver } from '../../hooks/useDataSaver';
import { compressImage } from '../../utils/dataSaver';
import { ErrorAlert, Spinner } from '../../components/ui';
import { PaperclipIcon } from '../../components/icons';
import { presenceLabel } from '../../utils/presence';
import { playMessageSound } from '../../utils/notifySound';

// Live socket pushes send a relative /media/... path (REST sends an absolute URL).
// Resolve against the API host so the image loads from the backend, not the frontend.
const mediaUrl = (u) => (u && !/^(https?:|blob:|data:)/.test(u) ? `${API_BASE}${u}` : u);

/* ------------------------------------------------------------------ */
/* Emoji data                                                          */
/* ------------------------------------------------------------------ */

const QUICK_REACTIONS = ['❤️', '😂', '👍', '😮', '😢', '🔥'];

const EMOJI_GROUPS = [
  { id: 'faces', icon: '😊', label: 'Faces', emoji: ['😀', '😁', '😂', '🤣', '😊', '😍', '🥰', '😘', '😎', '🤩', '🥳', '😏', '😌', '😴', '🤔', '🙄', '😮', '😢', '😭', '😡', '🥺', '😅', '😇', '🤗'] },
  { id: 'hands', icon: '👍', label: 'Gestures', emoji: ['👍', '👎', '👏', '🙌', '🙏', '🤝', '💪', '👀', '✌️', '🤞', '👌', '🫡', '🤙', '👋', '🤌', '🫶'] },
  { id: 'hearts', icon: '❤️', label: 'Hearts', emoji: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '💖', '💕', '💘', '💝', '💞', '💓', '🌹', '😻'] },
  { id: 'party', icon: '🎉', label: 'Party', emoji: ['🎉', '🎊', '🎂', '🎁', '🎈', '✨', '🔥', '💯', '🥂', '🍾', '🎶', '🎵', '💃', '🕺', '🎤', '🏆'] },
  { id: 'food', icon: '☕', label: 'Food and drink', emoji: ['☕', '🍕', '🍔', '🍟', '🍣', '🍜', '🍰', '🍩', '🍫', '🍿', '🍷', '🍺', '🥗', '🌮', '🍓', '🍉'] },
  { id: 'places', icon: '🌴', label: 'Places and nature', emoji: ['🌞', '🌙', '⭐', '🌈', '🌸', '🌴', '🏖️', '🐶', '🐱', '🦋', '🌊', '⛰️', '✈️', '🚗', '🏠', '📍'] },
];

const RECENT_KEY = 'chat-recent-emoji';
const reactionsKey = (conversationId) => `chat-reactions:${conversationId}`;

function readJSON(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage can be unavailable (private mode); reactions just won't persist */
  }
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

const GROUP_GAP_MS = 5 * 60 * 1000;

// The messages endpoint returns NEWEST first (page 1 = the latest 30). The page shows oldest at the
// top, so everything that enters state goes through sortOldestFirst.
const byTime = (a, b) => new Date(a.created_at) - new Date(b.created_at)
  || String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
const sortOldestFirst = (list) => [...list].sort(byTime);

// Keep whatever is already on screen, add what's new, and pick up edits and deletes.
// Returns the SAME array when nothing changed so a quiet poll never re-renders or moves the scroll.
const msgSig = (m) => `${m.id}|${m.edited_at ?? ''}|${m.is_deleted ? 1 : 0}|${m.body ?? ''}|${m.attachment_viewed ? 1 : 0}`;
function mergeMessages(prev, fresh) {
  if (!prev) return sortOldestFirst(fresh);
  const byId = new Map(prev.map((m) => [m.id, m]));
  let changed = false;
  for (const m of fresh) {
    const old = byId.get(m.id);
    if (!old || msgSig(old) !== msgSig(m)) {
      byId.set(m.id, m);
      changed = true;
    }
  }
  return changed ? sortOldestFirst([...byId.values()]) : prev;
}

const PhoneIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z" />
  </svg>
);
const VideoIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="6" width="12" height="12" rx="2" />
    <path d="M15 10l6-3v10l-6-3" />
  </svg>
);

function initialOf(profile) {
  return (profile?.display_name || profile?.username || '?')[0].toUpperCase();
}

/* ------------------------------------------------------------------ */
/* Emoji palette                                                       */
/* ------------------------------------------------------------------ */

function EmojiPalette({ onPick, label = 'Emoji palette', className = '' }) {
  const [tab, setTab] = useState('recent');
  const recents = readJSON(RECENT_KEY, []);
  const hasRecents = recents.length > 0;
  const activeTab = tab === 'recent' && !hasRecents ? 'faces' : tab;
  const group = EMOJI_GROUPS.find((g) => g.id === activeTab);
  const list = activeTab === 'recent' ? recents : group.emoji;
  const title = activeTab === 'recent' ? 'Recently used' : group.label;

  return (
    <div className={`cv-palette ${className}`} role="group" aria-label={label} data-emoji-pop>
      <div className="cv-palette__tabs" role="tablist" aria-label="Emoji categories">
        {hasRecents && (
          <button type="button" role="tab" aria-selected={activeTab === 'recent'} aria-label="Recently used"
            className="cv-palette__tab" onClick={() => setTab('recent')}>🕘</button>
        )}
        {EMOJI_GROUPS.map((g) => (
          <button key={g.id} type="button" role="tab" aria-selected={activeTab === g.id} aria-label={g.label}
            className="cv-palette__tab" onClick={() => setTab(g.id)}>{g.icon}</button>
        ))}
      </div>
      <p className="cv-palette__title">{title}</p>
      <div className="cv-palette__grid" role="tabpanel">
        {list.map((e) => (
          <button key={e} type="button" className="cv-palette__emoji" onClick={() => onPick(e)} aria-label={`Use ${e}`}>{e}</button>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Portrait canvas (right column)                                      */
/* ------------------------------------------------------------------ */

function PortraitCanvas({ profile, otherUserId, presence }) {
  const name = profile?.display_name || profile?.username || '…';
  const online = Boolean(presence?.online);

  return (
    <aside className="cv-canvas" aria-label={`About ${name}`}>
      <div className={`cv-frame${online ? ' cv-frame--online' : ''}`}>
        <div className="cv-frame__mat">
          <div className="cv-frame__art">
            {profile?.avatar
              ? <img src={profile.avatar} alt={`Portrait of ${name}`} />
              : <span className="cv-frame__initial" aria-hidden="true">{initialOf(profile)}</span>}
            <span className="cv-frame__weave" aria-hidden="true" />
          </div>
        </div>
      </div>

      <div className="cv-plaque">
        <h2 className="cv-plaque__name break">{name}</h2>
        {profile?.username && <p className="cv-plaque__handle break">@{profile.username}</p>}

        <p className="cv-status" role="status">
          <span className={`cv-dot${online ? ' cv-dot--on' : ''}`} aria-hidden="true" />
          {online ? 'Online now' : (presence?.text || 'Offline')}
        </p>

        {profile?.availability && <p className="cv-plaque__line break">{profile.availability}</p>}
        {profile?.general_location && <p className="cv-plaque__line cv-plaque__line--muted break">{profile.general_location}</p>}
        {profile?.bio && <p className="cv-plaque__bio break">{profile.bio}</p>}

        {otherUserId && <Link className="cv-plaque__link" to={`/profile/${otherUserId}`}>View full profile</Link>}
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function ConversationView() {
  usePageBackdrop('couples');
  const { id } = useParams();
  const { user } = useAuth();
  // The call itself lives above the routes (see CallContext), so it keeps going when this page closes.
  const { call, startCallIn, setViewedConversation, clearViewedConversation, setPeer } = useCall();
  const saver = useDataSaver();
  const [shownPhotos, setShownPhotos] = useState({}); // photos the person tapped to load while Data saver is on
  const [messages, setMessages] = useState(null);
  const [otherProfile, setOtherProfile] = useState(null);
  const [otherUserId, setOtherUserId] = useState(null);
  const [error, setError] = useState(null);
  const [draft, setDraft] = useState('');
  const [attachment, setAttachment] = useState(null);
  const [attachmentPreview, setAttachmentPreview] = useState(null);
  const [viewOnce, setViewOnce] = useState(false); // send the pending photo as view-once
  const [viewer, setViewer] = useState(null); // { id, url, loading, error } for an open view-once photo
  const [sending, setSending] = useState(false);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [reactTarget, setReactTarget] = useState(null); // { id, full }
  // Reactions are stored in this browser only (see note in chat.css / README).
  // Shape: { [messageId]: ['❤️', '😂'] } = the emoji *I* reacted with.
  const [reactions, setReactions] = useState({});

  const logRef = useRef(null);
  const stickRef = useRef(true);      // is the reader at the bottom of the log?
  const incomingRef = useRef(0);      // how many messages from the other person we've seen
  const seededRef = useRef(false);    // false until the first load of this conversation has been counted
  const fileInputRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    chatApi.getConversation(id)
      .then((c) => {
        setOtherUserId(c.other_user_id);
        return accountsApi.getPublicProfile(c.other_user_id);
      })
      .then(setOtherProfile)
      .catch(() => setOtherProfile({ username: 'Unknown user' }));

    incomingRef.current = 0;
    seededRef.current = false;
    stickRef.current = true;
    setMessages(null); // never count the previous conversation's messages as new here
    chatApi.listMessages(id).then((data) => setMessages(sortOldestFirst(data.results ?? data))).catch(setError);
    chatApi.markConversationRead(id).catch(() => {});
    setReactions(readJSON(reactionsKey(id), {}));
  }, [id]);

  // Scroll the message list itself. scrollIntoView() also scrolled the whole page,
  // which on a phone yanked the header out of view every time a message arrived.
  // Only follow new messages if the reader is already at the bottom (or sent them),
  // so a message arriving doesn't throw someone out of the history they're reading.
  const onLogScroll = () => {
    const log = logRef.current;
    if (log) stickRef.current = log.scrollHeight - log.scrollTop - log.clientHeight < 160;
  };
  useEffect(() => {
    const log = logRef.current;
    if (!log || !messages) return;
    const last = messages[messages.length - 1];
    if (stickRef.current || last?.sender === user.id) log.scrollTop = log.scrollHeight;
  }, [messages, user.id]);

  // New messages from the other person while the page is open: beep, and count them as read
  // if the tab is in view. The first load of a conversation only sets the starting count, so
  // opening a chat never beeps for old messages. This sees messages from the socket and from
  // the polling fallback alike.
  useEffect(() => {
    if (!messages) {
      seededRef.current = false;
      return;
    }
    const incoming = messages.reduce((n, m) => n + (m.sender !== user.id ? 1 : 0), 0);
    if (!seededRef.current) {
      seededRef.current = true;
      incomingRef.current = incoming;
      return;
    }
    if (incoming > incomingRef.current) {
      playMessageSound();
      if (document.visibilityState === 'visible') chatApi.markConversationRead(id).catch(() => {});
    }
    incomingRef.current = incoming;
  }, [messages, id, user.id]);

  // Free the preview blob when it's replaced or the page closes.
  useEffect(() => () => { if (attachmentPreview) URL.revokeObjectURL(attachmentPreview); }, [attachmentPreview]);

  // Close the emoji popovers on outside click or Escape.
  useEffect(() => {
    if (!paletteOpen && !reactTarget) return undefined;
    const onDown = (e) => {
      if (e.target.closest('[data-emoji-pop]') || e.target.closest('[data-react-pop]')) return;
      setPaletteOpen(false);
      setReactTarget(null);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setPaletteOpen(false);
        setReactTarget(null);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [paletteOpen, reactTarget]);

  // Text messages can arrive live over the socket; an attachment
  // always goes through REST (see handleSend) since it's a file
  // upload, but the resulting message still broadcasts over the
  // socket to the OTHER participant just the same -- both transports
  // funnel through the same broadcast_message() server-side.
  const refreshMessages = useCallback(
    () => chatApi.listMessages(id)
      .then((data) => setMessages((prev) => mergeMessages(prev, data.results ?? data)))
      .catch(() => {}),
    [id]
  );

  const { connected, sendOverSocket } = useChatSocket(id, {
    onOpen: refreshMessages, // catch up on anything missed while the socket was down
    onMessage: (data) => {
      if (data.type === 'message') {
        setMessages((prev) => (prev?.some((m) => m.id === data.id) ? prev : [...(prev || []), {
          id: data.id, conversation: data.conversation_id, sender: data.sender_id,
          body: data.body, attachment_url: data.attachment_url ?? null,
          attachment_view_once: data.attachment_view_once ?? false,
          attachment_viewed: data.attachment_viewed ?? false,
          created_at: data.created_at, is_deleted: false, edited_at: null,
        }]));
      } else if (data.type === 'message_deleted') {
        setMessages((prev) => prev?.map((m) => (m.id === data.id
          ? { ...m, is_deleted: true, body: '', attachment_url: null, attachment_view_once: false }
          : m)));
      } else if (data.type === 'attachment_viewed') {
        setMessages((prev) => prev?.map((m) => (m.id === data.message_id ? { ...m, attachment_viewed: true } : m)));
      } else if (data.type === 'error') {
        setError(new Error(data.detail));
      }
    },
  });

  // Safety net under the socket: poll while the page is visible (every 4s if the socket is
  // down, every 20s if it's up) and refresh the moment the tab regains focus or the network
  // returns. If websockets are blocked or flaky on someone's network, chats still arrive.
  useEffect(() => {
    if (!id) return undefined;
    const run = () => { if (document.visibilityState === 'visible') refreshMessages(); };
    const timer = setInterval(run, connected ? (saver.active ? 60000 : 20000) : (saver.active ? 12000 : 4000));
    document.addEventListener('visibilitychange', run);
    window.addEventListener('focus', run);
    window.addEventListener('online', run);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', run);
      window.removeEventListener('focus', run);
      window.removeEventListener('online', run);
    };
  }, [id, connected, refreshMessages, saver.active]);

  const handleFileChange = async (e) => {
    const picked = e.target.files?.[0];
    if (!picked) { setAttachment(null); setAttachmentPreview(null); return; }
    // Shrink big photos first: much less mobile data to send, and to download on the other side.
    const file = await compressImage(picked, saver.active);
    setAttachment(file);
    setAttachmentPreview(URL.createObjectURL(file));
  };

  const clearAttachment = () => {
    setAttachment(null);
    setAttachmentPreview(null);
    setViewOnce(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleSend = async (e) => {
    e.preventDefault();
    const body = draft.trim();
    if (!body && !attachment) return;
    setSending(true);
    setError(null);
    setPaletteOpen(false);
    const pendingAttachment = attachment;
    const pendingViewOnce = viewOnce;
    setDraft('');
    clearAttachment();
    try {
      if (pendingAttachment) {
        // File uploads can't go over the plain-text WS protocol this
        // app uses -- always REST for these.
        const form = new FormData();
        form.append('attachment', pendingAttachment);
        if (body) form.append('body', body);
        if (pendingViewOnce) form.append('view_once', 'true');
        const message = await apiFetch(`/api/chat/conversations/${id}/messages/`, { method: 'POST', body: form });
        setMessages((prev) => mergeMessages(prev, [message])); // dedupes: the socket may have delivered it first
      } else if (!sendOverSocket(body)) {
        // Prefer the live socket for plain text (near-instant echo to
        // both sides); fall back to REST if it isn't connected.
        const message = await chatApi.sendMessage(id, body);
        setMessages((prev) => mergeMessages(prev, [message])); // dedupes: the socket may have delivered it first
      }
    } catch (err) {
      setError(err);
      setDraft(body);
    } finally {
      setSending(false);
    }
  };

  const handleDelete = async (m) => {
    if (!window.confirm('Delete this message for everyone?')) return;
    try {
      await apiFetch(`/api/chat/messages/${m.id}/`, { method: 'DELETE' });
      setMessages((prev) => prev?.map((x) => (x.id === m.id
        ? { ...x, is_deleted: true, body: '', attachment_url: null, attachment_view_once: false }
        : x)));
    } catch (err) {
      setError(err);
    }
  };

  const openViewOnce = async (m) => {
    setViewer({ id: m.id, url: null, loading: true, error: null });
    try {
      const blob = await apiBlob(`/api/chat/messages/${m.id}/view-once/`);
      setViewer({ id: m.id, url: URL.createObjectURL(blob), loading: false, error: null });
      setMessages((prev) => prev?.map((x) => (x.id === m.id ? { ...x, attachment_viewed: true } : x)));
    } catch (err) {
      setViewer({ id: m.id, url: null, loading: false, error: err.message || 'Could not open this photo.' });
      refreshMessages();
    }
  };

  const closeViewer = () => {
    setViewer((v) => {
      if (v?.url) URL.revokeObjectURL(v.url); // the photo is gone for good
      return null;
    });
  };

  const rememberEmoji = (emoji) => {
    const next = [emoji, ...readJSON(RECENT_KEY, []).filter((x) => x !== emoji)].slice(0, 16);
    writeJSON(RECENT_KEY, next);
  };

  const insertEmoji = (emoji) => {
    rememberEmoji(emoji);
    const el = inputRef.current;
    const start = el?.selectionStart ?? draft.length;
    const end = el?.selectionEnd ?? draft.length;
    setDraft(draft.slice(0, start) + emoji + draft.slice(end));
    const caret = start + emoji.length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  };

  // TODO(backend): reactions are local to this browser for now. To share them,
  // POST/DELETE here (e.g. /chat/messages/<id>/reactions/) and merge the
  // server's reaction list into each message instead of this local map.
  const toggleReaction = useCallback((messageId, emoji) => {
    rememberEmoji(emoji);
    setReactions((prev) => {
      const mine = new Set(prev[messageId] || []);
      if (mine.has(emoji)) mine.delete(emoji); else mine.add(emoji);
      const next = { ...prev };
      if (mine.size) next[messageId] = [...mine]; else delete next[messageId];
      writeJSON(reactionsKey(id), next);
      return next;
    });
    setReactTarget(null);
  }, [id]);

  // Tell the call which conversation is open (so a call to it rings here) and who the other person is.
  // These are hooks, so they must stay ABOVE the early return below (hooks can't be skipped on some renders).
  useEffect(() => {
    setViewedConversation(id);
    return () => clearViewedConversation(id);
  }, [id, setViewedConversation, clearViewedConversation]);
  const peerName = otherProfile?.display_name || otherProfile?.username || '\u2026';
  const peerAvatar = otherProfile?.avatar || null;
  const peerLoaded = Boolean(otherProfile);
  useEffect(() => {
    if (peerLoaded) setPeer(id, { name: peerName, avatar: peerAvatar });
  }, [id, peerLoaded, peerName, peerAvatar, setPeer]);

  if (!messages) return <div className="page"><Spinner /></div>;

  const presence = presenceLabel(otherProfile);
  const online = Boolean(presence?.online);
  const displayName = otherProfile?.display_name || otherProfile?.username || '…';
  const callBusy = call.status !== 'idle' && call.status !== 'ended';
  const peerInfo = { name: displayName, avatar: otherProfile?.avatar || null };

  return (
    <div className="page cv">
      <div className="cv-shell">
        <section className="cv-chat" aria-label={`Conversation with ${displayName}`}>
          <header className="cv-head">
            {otherUserId ? (
              <Link to={`/profile/${otherUserId}`} className="cv-head__avatar" aria-label={`${displayName}'s profile`}>
                {otherProfile?.avatar
                  ? <img src={otherProfile.avatar} alt="" />
                  : <span aria-hidden="true">{initialOf(otherProfile)}</span>}
              </Link>
            ) : null}
            <div className="cv-head__text">
              <h1 className="cv-head__name" title={displayName}>{displayName}</h1>
              <p className="cv-status cv-status--small">
                <span className={`cv-dot${online ? ' cv-dot--on' : ''}`} aria-hidden="true" />
                {online ? 'Online now' : (presence?.text || 'Offline')}
              </p>
            </div>
            <div className="cv-head__actions">
              <button
                type="button"
                className="cv-call-btn"
                onClick={() => startCallIn(id, 'voice', peerInfo)}
                disabled={callBusy}
                aria-label={`Start a voice call with ${displayName}`}
              >
                <PhoneIcon /><span className="cv-call-btn__text">Voice</span>
              </button>
              <button
                type="button"
                className="cv-call-btn"
                onClick={() => startCallIn(id, 'video', peerInfo)}
                disabled={callBusy}
                aria-label={`Start a video call with ${displayName}`}
              >
                <VideoIcon /><span className="cv-call-btn__text">Video</span>
              </button>
              <button type="button" className={`cv-call-btn${saver.active ? ' is-on' : ''}`} aria-pressed={saver.active}
                onClick={() => saver.setSetting(saver.active ? 'off' : 'on')}
                title="Data saver: smaller photos, lower call quality, slower refresh">
                <span aria-hidden="true">↓</span><span className="cv-call-btn__text">Data saver {saver.active ? 'on' : 'off'}</span>
              </button>
              <span className={`cv-live${connected ? ' cv-live--on' : ''}`} role="status">
                <span className="cv-live__text">{connected ? 'Live' : 'Reconnecting…'}</span>
              </span>
            </div>
          </header>

          <ErrorAlert error={error} />

          <div className="cv-log" ref={logRef} onScroll={onLogScroll}>
            {messages.length === 0 && (
              <p className="cv-empty">No messages yet. Say hi to {displayName}.</p>
            )}
            {messages.map((m, i) => {
              const mine = m.sender === user.id;
              const prev = messages[i - 1];
              const next = messages[i + 1];
              const newDay = !prev || new Date(prev.created_at).toDateString() !== new Date(m.created_at).toDateString();
              const joinsPrev = prev && !newDay && prev.sender === m.sender
                && new Date(m.created_at) - new Date(prev.created_at) < GROUP_GAP_MS;
              const joinsNext = next && next.sender === m.sender
                && new Date(next.created_at).toDateString() === new Date(m.created_at).toDateString()
                && new Date(next.created_at) - new Date(m.created_at) < GROUP_GAP_MS;
              const mineReactions = reactions[m.id] || [];
              const pickerHere = reactTarget?.id === m.id;

              return (
                <div key={m.id}>
                  {newDay && <p className="cv-day"><span>{dayLabel(m.created_at)}</span></p>}
                  <div className={`cv-msg${mine ? ' cv-msg--mine' : ''}${joinsPrev ? ' cv-msg--joined' : ''}`}>
                    <div className="cv-msg__row">
                      <div
                        className={`cv-bubble${m.is_deleted ? ' cv-bubble--deleted' : ''}`}
                        onDoubleClick={() => !m.is_deleted && toggleReaction(m.id, '❤️')}
                      >
                        {m.is_deleted ? (
                          <p><em>Message deleted</em></p>
                        ) : (
                          <>
                            {m.attachment_view_once ? (
                              mine ? (
                                <p className="cv-once cv-once--mine">
                                  📷 Photo · View once <span>{m.attachment_viewed ? 'Opened' : 'Not opened yet'}</span>
                                </p>
                              ) : m.attachment_viewed ? (
                                <p className="cv-once cv-once--done">📷 Photo opened</p>
                              ) : (
                                <button type="button" className="cv-once cv-once--open" onClick={() => openViewOnce(m)}>
                                  📷 Tap to view photo <span>(once)</span>
                                </button>
                              )
                            ) : m.attachment_url && (saver.active && !mine && !shownPhotos[m.id] ? (
                              <button type="button" className="cv-once cv-once--open"
                                onClick={() => setShownPhotos((s) => ({ ...s, [m.id]: true }))}>
                                📷 Tap to load photo <span>(saves data)</span>
                              </button>
                            ) : (
                              <a href={mediaUrl(m.attachment_url)} target="_blank" rel="noreferrer">
                                <img className="cv-bubble__img" src={mediaUrl(m.attachment_url)} alt="Photo" loading="lazy" />
                              </a>
                            ))}
                            {m.body && (
                              <p className={m.attachment_url || m.attachment_view_once ? 'cv-bubble__caption' : undefined}>{m.body}</p>
                            )}
                          </>
                        )}
                      </div>

                      {!m.is_deleted && (
                        <div className="cv-react" data-react-pop>
                          <button
                            type="button"
                            className="cv-react__btn"
                            aria-label="React to this message"
                            aria-expanded={pickerHere}
                            onClick={() => setReactTarget(pickerHere ? null : { id: m.id, full: false })}
                          >☺</button>
                          {pickerHere && (
                            <div className="cv-react__pop" data-react-pop>
                              {reactTarget.full ? (
                                <EmojiPalette label="Pick a reaction" onPick={(e) => toggleReaction(m.id, e)} />
                              ) : (
                                <div className="cv-quick" role="group" aria-label="Quick reactions">
                                  {QUICK_REACTIONS.map((e) => (
                                    <button key={e} type="button"
                                      className={`cv-quick__btn${mineReactions.includes(e) ? ' is-on' : ''}`}
                                      aria-label={`React with ${e}`} aria-pressed={mineReactions.includes(e)}
                                      onClick={() => toggleReaction(m.id, e)}>{e}</button>
                                  ))}
                                  <button type="button" className="cv-quick__btn cv-quick__more" aria-label="More emoji"
                                    onClick={() => setReactTarget({ id: m.id, full: true })}>+</button>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                      {mine && !m.is_deleted && (
                        <button type="button" className="cv-del" aria-label="Delete this message" title="Delete"
                          onClick={() => handleDelete(m)}>🗑</button>
                      )}
                    </div>

                    {mineReactions.length > 0 && (
                      <div className="cv-chips">
                        {mineReactions.map((e) => (
                          <button key={e} type="button" className="cv-chip is-mine"
                            aria-label={`Remove your ${e} reaction`}
                            onClick={() => toggleReaction(m.id, e)}>{e}</button>
                        ))}
                      </div>
                    )}

                    {!joinsNext && (
                      <p className="cv-time">
                        {new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        {m.edited_at && ' (edited)'}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {attachmentPreview && (
            <div className="cv-attach">
              <img src={attachmentPreview} alt="" />
              <label className="cv-once-toggle">
                <input type="checkbox" checked={viewOnce} onChange={(e) => setViewOnce(e.target.checked)} />
                View once
              </label>
              <button type="button" className="btn btn--ghost btn--sm" onClick={clearAttachment}>Remove</button>
            </div>
          )}

          <div className="cv-composer-wrap">
            {paletteOpen && (
              <div className="cv-composer-pop" data-emoji-pop>
                <EmojiPalette onPick={insertEmoji} />
              </div>
            )}
            <form onSubmit={handleSend} className="cv-composer">
              <label className="cv-icon-btn" aria-label="Attach an image">
                <PaperclipIcon />
                <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={handleFileChange} />
              </label>
              <input
                ref={inputRef}
                className="cv-composer__input"
                placeholder="Write a message…"
                aria-label="Message"
                enterKeyHint="send"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                maxLength={4000}
              />
              <button
                type="button"
                className={`cv-icon-btn cv-icon-btn--emoji${paletteOpen ? ' is-open' : ''}`}
                aria-label="Open emoji palette"
                aria-expanded={paletteOpen}
                data-emoji-pop
                onClick={() => { setReactTarget(null); setPaletteOpen((o) => !o); }}
              >☺</button>
              <button className="cv-send" disabled={sending || (!draft.trim() && !attachment)} type="submit">Send</button>
            </form>
          </div>
        </section>

        <PortraitCanvas profile={otherProfile} otherUserId={otherUserId} presence={presence} />
      </div>
      {viewer && (
        <div className="cv-viewer" role="dialog" aria-modal="true" aria-label="View-once photo" onClick={closeViewer}>
          <div className="cv-viewer__box" onClick={(e) => e.stopPropagation()}>
            {viewer.loading && <Spinner />}
            {viewer.error && <p className="cv-viewer__err">{viewer.error}</p>}
            {viewer.url && (
              <img src={viewer.url} alt="View-once photo" draggable={false} onContextMenu={(e) => e.preventDefault()} />
            )}
            {viewer.url && <p className="cv-viewer__note">This photo disappears when you close it.</p>}
            <button type="button" className="btn btn--ghost btn--sm" onClick={closeViewer}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}