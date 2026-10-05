import '../../styles/index.css';
import './chat.css';
import { usePageBackdrop } from '../../hooks/usePageBackdrop';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import * as chatApi from '../../api/chat';
import * as accountsApi from '../../api/accounts';
import { API_BASE, apiFetch, apiBlob } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { useChatSocket } from '../../hooks/useChatSocket';
import { useCall } from '../../context/CallContext';
import { useDataSaver } from '../../hooks/useDataSaver';
import { compressImage } from '../../utils/dataSaver';
import { ErrorAlert, Spinner } from '../../components/ui';
import { PaperclipIcon, MicIcon, StopIcon, TrashIcon, PlayIcon, PauseIcon } from '../../components/icons';
import { presenceLabel } from '../../utils/presence';
import { playMessageSound } from '../../utils/notifySound';
import PeoplePicker from '../../components/PeoplePicker';
import GroupPanel, { MOODS, moodOf, MoodPicker, VibeBar } from './GroupPanel';
import './group.css';

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
const msgSig = (m) => `${m.id}|${m.edited_at ?? ''}|${m.is_deleted ? 1 : 0}|${m.body ?? ''}|${m.attachment_viewed ? 1 : 0}|${m.pinned ? 1 : 0}`;
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
const DataSaverIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8 20V5M8 5L4.5 8.5M8 5l3.5 3.5M16 4v15M16 19l-3.5-3.5M16 19l3.5-3.5" />
  </svg>
);
const VideoIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="6" width="12" height="12" rx="2" />
    <path d="M15 10l6-3v10l-6-3" />
  </svg>
);


/* ------------------------------------------------------------------ */
/* Voice notes + long text helpers                                     */
/* ------------------------------------------------------------------ */

const MAX_VOICE_SECONDS = 120;          // short voice notes only
const LONG_TEXT_CHARS = 500;            // longer than this collapses behind "Read more"
const LONG_TEXT_LINES = 10;
const AUDIO_EXT = /\.(webm|ogg|oga|opus|m4a|mp4|aac|mp3|wav)(\?|$)/i;

// Backend may send attachment_type/attachment_mime; fall back to the file extension.
const isAudioMessage = (m) => Boolean(m.attachment_url) && (
  m.attachment_type === 'audio'
  || String(m.attachment_mime || '').startsWith('audio/')
  || AUDIO_EXT.test(m.attachment_url)
);

const fmtClock = (secs) => {
  const s = Math.max(0, Math.round(secs || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// Pick a recording format this browser can actually make (Safari = mp4, Chrome/Firefox = webm/ogg).
function pickRecorderMime() {
  if (typeof MediaRecorder === 'undefined') return '';
  const options = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  return options.find((t) => MediaRecorder.isTypeSupported?.(t)) || '';
}

function LongText({ text, className }) {
  const [open, setOpen] = useState(false);
  const lines = text.split('\n').length;
  const long = text.length > LONG_TEXT_CHARS || lines > LONG_TEXT_LINES;
  if (!long) return <p className={className}>{text}</p>;
  return (
    <div className={className}>
      <p className={`cv-longtext${open ? ' is-open' : ''}`}>{text}</p>
      <button type="button" className="cv-more" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? 'Show less' : 'Read more'}
      </button>
    </div>
  );
}

function VoicePlayer({ src, mine, knownDuration, saver }) {
  const audioRef = useRef(null);
  // Data saver: don't download someone else's voice note until it's tapped (same as photos).
  const [loaded, setLoaded] = useState(!(saver && !mine));
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(knownDuration || 0);

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) a.play().catch(() => setPlaying(false)); else a.pause();
  };
  const seek = (e) => {
    const a = audioRef.current;
    if (!a || !duration) return;
    a.currentTime = (Number(e.target.value) / 100) * duration;
  };
  // Browsers report Infinity for MediaRecorder webm until it's been scrubbed; handle that.
  const onMeta = (e) => {
    const a = e.currentTarget;
    if (Number.isFinite(a.duration)) setDuration(a.duration);
    else { a.currentTime = 1e7; }
  };
  const onTime = (e) => {
    const a = e.currentTarget;
    if (!Number.isFinite(duration) || !duration) {
      if (Number.isFinite(a.duration)) { setDuration(a.duration); a.currentTime = 0; }
      return;
    }
    setProgress((a.currentTime / duration) * 100);
  };

  if (!loaded && !(src && !saver)) {
    return (
      <button type="button" className="cv-once cv-once--open" onClick={() => setLoaded(true)}>
        🎤 Tap to load voice message {knownDuration ? `(${fmtClock(knownDuration)}) ` : ''}<span>(saves data)</span>
      </button>
    );
  }

  return (
    <div className={`cv-voice${mine ? ' cv-voice--mine' : ''}`}>
      <button type="button" className="cv-voice__btn" onClick={toggle} aria-label={playing ? 'Pause voice message' : 'Play voice message'}>
        {playing ? <PauseIcon size={16} /> : <PlayIcon size={16} />}
      </button>
      <input type="range" className="cv-voice__bar" min="0" max="100" step="0.5" value={progress}
        onChange={seek} aria-label="Voice message position" />
      <span className="cv-voice__time">{fmtClock(playing || progress > 0 ? (progress / 100) * duration : duration)}</span>
      <audio ref={audioRef} src={src} preload={saver ? 'none' : 'metadata'} autoPlay={saver && !mine}
        onLoadedMetadata={onMeta} onTimeUpdate={onTime} onDurationChange={(e) => Number.isFinite(e.currentTarget.duration) && setDuration(e.currentTarget.duration)}
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setProgress(0); }} />
    </div>
  );
}

const NAME_COLORS = ['#c2410c', '#0f766e', '#6d28d9', '#be123c', '#1d4ed8', '#a16207', '#047857'];
const colorFor = (uid) => {
  let h = 0;
  for (const ch of String(uid)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return NAME_COLORS[h % NAME_COLORS.length];
};
let outboxSeq = 0;
const newTempId = () => `out-${Date.now()}-${(outboxSeq += 1)}`;
const STALE_SOCKET_MS = 8000; // a socket send with no echo after this long is checked, then marked failed

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
  const [missing, setMissing] = useState(false); // the server says this conversation does not exist for this account
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
  // Voice note recorder: 'idle' | 'recording'
  const navigate = useNavigate();
  const [conv, setConv] = useState(null);              // conversation detail (groups: title, members, my_role)
  const [memberProfiles, setMemberProfiles] = useState({}); // { [userId]: profile } for group members
  const [showMembers, setShowMembers] = useState(false);    // phone: member sheet under the header
  const [pickerOpen, setPickerOpen] = useState(false);
  const [groupBusy, setGroupBusy] = useState(false);
  const [joinRequests, setJoinRequests] = useState([]);   // admins: people waiting to be let in
  const location = useLocation();
  const [outbox, setOutbox] = useState([]);            // messages still sending or that failed (Resend)
  const [recState, setRecState] = useState('idle');
  const [recSecs, setRecSecs] = useState(0);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [reactTarget, setReactTarget] = useState(null); // { id, full }
  const [pinsOpen, setPinsOpen] = useState(false);       // pinned bar: one line, or all of them
  const [menuFor, setMenuFor] = useState(null);         // id of the message whose action bar is open
  // Reactions are stored in this browser only (see note in chat.css / README).
  // Shape: { [messageId]: ['❤️', '😂'] } = the emoji *I* reacted with.
  const [reactions, setReactions] = useState({});

  const logRef = useRef(null);
  const stickRef = useRef(true);      // is the reader at the bottom of the log?
  const incomingRef = useRef(0);      // how many messages from the other person we've seen
  const seededRef = useRef(false);    // false until the first load of this conversation has been counted
  const fileInputRef = useRef(null);
  const inputRef = useRef(null);
  const messagesRef = useRef(null);
  const outboxRef = useRef([]);
  const profilesLoadedRef = useRef(new Set());
  const recorderRef = useRef(null);   // MediaRecorder
  const recChunksRef = useRef([]);
  const recStreamRef = useRef(null);
  const recTimerRef = useRef(null);
  const recCancelRef = useRef(false);

  useEffect(() => {
    setMissing(false);
    setConv(null);
    setMemberProfiles({});
    profilesLoadedRef.current = new Set();
    setOutbox([]);
    setShowMembers(false);
    setJoinRequests([]);
    chatApi.getConversation(id)
      .then((c) => {
        setConv(c);
        if (c.is_group) {
          setOtherUserId(null);
          setOtherProfile({ username: c.title || 'Group chat' });
          return null;
        }
        setOtherUserId(c.other_user_id);
        return accountsApi.getPublicProfile(c.other_user_id).then(setOtherProfile);
      })
      .catch((err) => {
        if (err?.status === 404) setMissing(true);
        else setOtherProfile({ username: 'Unknown user' });
      });

    incomingRef.current = 0;
    seededRef.current = false;
    stickRef.current = true;
    setMessages(null); // never count the previous conversation's messages as new here
    chatApi.listMessages(id).then((data) => setMessages(sortOldestFirst(data.results ?? data))).catch(setError);
    chatApi.markConversationRead(id).catch(() => {});
    setReactions(readJSON(reactionsKey(id), {}));
  }, [id]);

  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { outboxRef.current = outbox; }, [outbox]);

  const isGroup = Boolean(conv?.is_group);
  const convLoaded = Boolean(conv);

  // Names for the people in a group. Fetched once per person (not on every refresh).
  const loadMemberProfiles = useCallback((c) => {
    if (saver.active) return; // names come with the member list; profiles are only for pictures
    const wanted = (c?.members || []).map((m) => m.user_id).filter((uid) => uid !== user.id && !profilesLoadedRef.current.has(uid));
    wanted.forEach((uid) => profilesLoadedRef.current.add(uid));
    wanted.forEach((uid) => {
      accountsApi.getPublicProfile(uid)
        .then((p) => setMemberProfiles((cur) => ({ ...cur, [uid]: p })))
        .catch(() => setMemberProfiles((cur) => ({ ...cur, [uid]: { username: 'Member' } })));
    });
  }, [user.id, saver.active]);
  useEffect(() => { if (conv?.is_group) loadMemberProfiles(conv); }, [conv, loadMemberProfiles]);

  const reloadConversation = useCallback(
    () => chatApi.getConversation(id).then(setConv).catch((err) => { if (err?.status === 404) navigate('/chat'); }),
    [id, navigate]
  );

  const memberOf = (uid) => (conv?.members || []).find((x) => String(x.user_id) === String(uid));
  // Every member's name comes from the group itself, so it shows for everyone, not just people
  // whose profile you are allowed to open. The profile is only a fallback.
  const nameOfSender = (uid) => {
    const m = memberOf(uid);
    const p = memberProfiles[uid];
    return m?.display_name || m?.username || p?.display_name || p?.username || 'Member';
  };

  const senderMood = (uid) => moodOf(memberOf(uid));

  // Admins: who is waiting to be let in. Reloaded when the group says it changed.
  const reloadJoinRequests = useCallback(() => {
    if (!conv?.is_group || conv.my_role !== 'admin') { setJoinRequests([]); return Promise.resolve(); }
    return chatApi.listJoinRequests(id).then((r) => setJoinRequests(r.results ?? r)).catch(() => {});
  }, [id, conv?.is_group, conv?.my_role]);
  useEffect(() => { reloadJoinRequests(); }, [reloadJoinRequests]);

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
    if (stickRef.current || last?.sender === user.id || outbox.length) log.scrollTop = log.scrollHeight;
  }, [messages, outbox.length, user.id]);

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
    if (!paletteOpen && !reactTarget && !menuFor) return undefined;
    const onDown = (e) => {
      if (e.target.closest('[data-emoji-pop]') || e.target.closest('[data-react-pop]') || e.target.closest('[data-msg-menu]')) return;
      setPaletteOpen(false);
      setReactTarget(null);
      setMenuFor(null);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setPaletteOpen(false);
        setReactTarget(null);
        setMenuFor(null);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [paletteOpen, reactTarget, menuFor]);

  // Text messages can arrive live over the socket; an attachment
  // always goes through REST (see handleSend) since it's a file
  // upload, but the resulting message still broadcasts over the
  // socket to the OTHER participant just the same -- both transports
  // funnel through the same broadcast_message() server-side.
  // Data saving: once the first page is loaded, ask only for messages created or changed since
  // the newest `updated_at` we hold (edits, deletes, pins and opened photos all bump it). A quiet
  // poll then returns an empty list instead of re-sending 30 messages every time.
  const refreshMessages = useCallback(
    () => {
      const known = messagesRef.current;
      const after = known && known.length
        ? known.reduce((max, m) => (m.updated_at && m.updated_at > max ? m.updated_at : max), '')
        : '';
      return chatApi.listMessages(id, after || undefined)
        .then((data) => setMessages((prev) => mergeMessages(prev, data.results ?? data)))
        .catch(() => {});
    },
    [id]
  );

  // ---- Outbox: what is still sending, or failed and waiting for Resend ----
  const patchOutbox = useCallback((tempId, patch) => {
    setOutbox((list) => list.map((o) => (o.tempId === tempId ? { ...o, ...patch } : o)));
  }, []);
  const markFailed = useCallback((tempId, detail) => {
    patchOutbox(tempId, { status: 'failed', error: detail || 'Could not send.' });
  }, [patchOutbox]);
  const dropOutbox = useCallback((tempId) => {
    const gone = outboxRef.current.find((o) => o.tempId === tempId);
    if (gone?.preview) URL.revokeObjectURL(gone.preview);
    setOutbox((list) => list.filter((o) => o.tempId !== tempId));
  }, []);

  const { connected, sendOverSocket } = useChatSocket(missing ? null : id, {
    onOpen: refreshMessages, // catch up on anything missed while the socket was down
    onMessage: (data) => {
      if (data.type === 'message') {
        setMessages((prev) => (prev?.some((m) => m.id === data.id) ? prev : [...(prev || []), {
          id: data.id, conversation: data.conversation_id, sender: data.sender_id,
          body: data.body, attachment_url: data.attachment_url ?? null,
          attachment_view_once: data.attachment_view_once ?? false,
          attachment_viewed: data.attachment_viewed ?? false,
          attachment_type: data.attachment_type ?? null, attachment_mime: data.attachment_mime ?? null,
          duration: data.duration ?? null,
          created_at: data.created_at, is_deleted: false, edited_at: null,
        }]));
      } else if (data.type === 'message_deleted') {
        setMessages((prev) => prev?.map((m) => (m.id === data.id
          ? { ...m, is_deleted: true, body: '', attachment_url: null, attachment_view_once: false }
          : m)));
      } else if (data.type === 'attachment_viewed') {
        setMessages((prev) => prev?.map((m) => (m.id === data.message_id ? { ...m, attachment_viewed: true } : m)));
      } else if (data.type === 'pins_changed') {
        // The event carries the (max 3) pinned messages, so no extra request is needed.
        setConv((c) => (c ? { ...c, pinned_messages: data.pinned_messages || [] } : c));
        setMessages((prev) => {
          if (!prev) return prev;
          const pinnedIds = new Set((data.pinned_messages || []).map((p) => p.id));
          return prev.map((m) => (Boolean(m.pinned) === pinnedIds.has(m.id) ? m : { ...m, pinned: pinnedIds.has(m.id) }));
        });
      } else if (data.type === 'mood_changed') {
        // Silent update of one person's colour: no sound, no unread count, no refetch.
        setConv((c) => (c ? {
          ...c,
          members: (c.members || []).map((m) => (String(m.user_id) === String(data.user_id)
            ? { ...m, mood: data.mood, mood_set_at: data.mood_set_at }
            : m)),
        } : c));
      } else if (data.type === 'members_changed') {
        reloadConversation();
      } else if (data.type === 'join_requests_changed') {
        reloadJoinRequests();
      } else if (data.type === 'member_removed') {
        if (String(data.user_id) === String(user.id)) navigate('/chat'); // you were removed from this group
      } else if (data.type === 'error') {
        // A rejected socket send: show it on the message that failed so it can be resent.
        const pending = [...outboxRef.current].reverse().find((o) => o.viaSocket && o.status === 'sending');
        if (pending) markFailed(pending.tempId, data.detail);
        else setError(new Error(data.detail));
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

  // Send one outbox item. Text prefers the live socket; if there is no echo in a few seconds it is
  // checked against the server and, if it never arrived, marked failed so the person can Resend.
  const deliver = async (item, forceRest = false) => {
    const mineSameBody = (messagesRef.current || []).filter((m) => m.sender === user.id && m.body === item.body).map((m) => m.id);
    patchOutbox(item.tempId, { status: 'sending', error: null, knownIds: mineSameBody });
    try {
      if (item.kind === 'text' && !forceRest && navigator.onLine !== false && sendOverSocket(item.body)) {
        patchOutbox(item.tempId, { viaSocket: true, sentAt: Date.now() });
        return;
      }
      patchOutbox(item.tempId, { viaSocket: false });
      let message;
      if (item.kind === 'text') {
        message = await chatApi.sendMessage(id, item.body);
      } else {
        const form = new FormData();
        form.append('attachment', item.file);
        if (item.body) form.append('body', item.body);
        if (item.kind === 'voice') {
          form.append('attachment_type', 'audio');
          form.append('duration', String(Math.round(item.duration || 0)));
        } else if (item.viewOnce) {
          form.append('view_once', 'true');
        }
        message = await apiFetch(`/api/chat/conversations/${id}/messages/`, { method: 'POST', body: form });
      }
      setMessages((prev) => mergeMessages(prev, [message])); // dedupes: the socket may have delivered it first
      dropOutbox(item.tempId);
    } catch (err) {
      markFailed(item.tempId, err?.message);
    }
  };

  const queueSend = (fields) => {
    const item = { tempId: newTempId(), status: 'sending', createdLocal: Date.now(), ...fields };
    setOutbox((list) => [...list, item]);
    deliver(item);
  };

  const resend = (item) => deliver(item, true); // a resend always goes by REST: it reports success or failure itself
  const resendAllFailed = () => outboxRef.current.filter((o) => o.status === 'failed').forEach((o) => deliver(o, true));

  // A socket text counts as delivered once it shows up in the log (from the socket or a poll).
  useEffect(() => {
    if (!messages || !outbox.length) return;
    outbox.forEach((o) => {
      if (o.kind !== 'text' || !o.knownIds) return;
      const echoed = messages.some((m) => m.sender === user.id && m.body === o.body && !o.knownIds.includes(m.id));
      if (echoed) dropOutbox(o.tempId);
    });
  }, [messages, outbox, user.id, dropOutbox]);

  // Watchdog for socket sends that never echo: re-check with the server, then give up (Resend appears).
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      outboxRef.current.forEach((o) => {
        if (o.status !== 'sending' || !o.viaSocket || now - (o.sentAt || now) < STALE_SOCKET_MS) return;
        patchOutbox(o.tempId, { sentAt: now + 60000 }); // don't re-check every second
        refreshMessages().finally(() => {
          setOutbox((list) => list.map((x) => (x.tempId === o.tempId && x.status === 'sending' && x.viaSocket
            ? { ...x, status: 'failed', error: 'Not delivered.' } : x)));
        });
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [patchOutbox, refreshMessages]);

  // Free any preview images when leaving the page.
  useEffect(() => () => { outboxRef.current.forEach((o) => { if (o.preview) URL.revokeObjectURL(o.preview); }); }, []);

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

  const handleSend = (e) => {
    e.preventDefault();
    const body = draft.trim();
    if (!body && !attachment) return;
    setError(null);
    setPaletteOpen(false);
    if (attachment) {
      queueSend({ kind: 'image', body, file: attachment, preview: URL.createObjectURL(attachment), viewOnce: !isGroup && viewOnce });
    } else {
      queueSend({ kind: 'text', body });
    }
    setDraft('');
    clearAttachment();
  };

  // Auto-grow the message box with what's typed (up to a cap, then it scrolls inside).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [draft]);

  // Enter sends on a keyboard; Shift+Enter adds a new line. On phones Enter is a new line (use Send).
  const onDraftKeyDown = (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    const coarse = window.matchMedia?.('(pointer: coarse)').matches;
    if (coarse) return;
    e.preventDefault();
    if (draft.trim() || attachment) handleSend(e);
  };

  /* ---- Voice notes ---- */
  const stopTracks = () => {
    recStreamRef.current?.getTracks().forEach((t) => t.stop());
    recStreamRef.current = null;
    clearInterval(recTimerRef.current);
  };

  const sendVoice = (blob, secs, mime) => {
    const ext = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';
    const file = new File([blob], `voice-${Date.now()}.${ext}`, { type: mime || 'audio/webm' });
    setError(null);
    queueSend({ kind: 'voice', body: '', file, duration: secs });
  };

  const startRecording = async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError(new Error('Voice messages are not supported in this browser.'));
      return;
    }
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: saver.active ? { channelCount: 1 } : true });
      recStreamRef.current = stream;
      const mime = pickRecorderMime();
      // Data saver: ~12 kbps voice-quality audio (about 90 KB a minute) instead of the browser default.
      const rec = new MediaRecorder(stream, {
        ...(mime ? { mimeType: mime } : {}),
        audioBitsPerSecond: saver.active ? 12000 : 32000,
      });
      recChunksRef.current = [];
      recCancelRef.current = false;
      rec.ondataavailable = (e) => { if (e.data.size) recChunksRef.current.push(e.data); };
      rec.onstop = () => {
        const secs = (Date.now() - rec._startedAt) / 1000;
        const type = rec.mimeType || mime || 'audio/webm';
        const blob = new Blob(recChunksRef.current, { type });
        stopTracks();
        setRecState('idle');
        setRecSecs(0);
        recorderRef.current = null;
        if (!recCancelRef.current && secs >= 0.8 && blob.size) sendVoice(blob, secs, type);
      };
      rec._startedAt = Date.now();
      rec.start();
      recorderRef.current = rec;
      setRecState('recording');
      setRecSecs(0);
      recTimerRef.current = setInterval(() => {
        const secs = (Date.now() - rec._startedAt) / 1000;
        setRecSecs(secs);
        if (secs >= MAX_VOICE_SECONDS && rec.state === 'recording') rec.stop(); // auto-send at the limit
      }, 200);
    } catch (err) {
      stopTracks();
      setError(new Error(err?.name === 'NotAllowedError'
        ? 'Microphone access is blocked. Allow it in your browser settings to send voice messages.'
        : 'Could not start the microphone.'));
    }
  };

  const finishRecording = (cancel) => {
    recCancelRef.current = cancel;
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
    else { stopTracks(); setRecState('idle'); }
  };

  // Leaving the page mid-recording discards it and releases the mic.
  useEffect(() => () => {
    recCancelRef.current = true;
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
    recStreamRef.current?.getTracks().forEach((t) => t.stop());
    clearInterval(recTimerRef.current);
  }, []);

  const togglePin = async (m) => {
    try {
      const res = m.pinned ? await chatApi.unpinMessage(m.id) : await chatApi.pinMessage(m.id);
      const pinnedIds = new Set((res.pinned_messages || []).map((p) => p.id));
      setConv((c) => (c ? { ...c, pinned_messages: res.pinned_messages || [] } : c));
      setMessages((prev) => prev?.map((x) => (Boolean(x.pinned) === pinnedIds.has(x.id) ? x : { ...x, pinned: pinnedIds.has(x.id) })));
    } catch (err) {
      setError(err);
    }
  };

  const jumpToMessage = (messageId) => {
    const el = logRef.current?.querySelector(`[data-mid="${messageId}"]`);
    if (!el) return; // older than what is loaded; the bar still shows the text
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('cv-flash');
    window.setTimeout(() => el.classList.remove('cv-flash'), 1400);
  };

  const changeMood = async (mood) => {
    const prevMembers = conv?.members;
    // Optimistic: the colour changes at once, and is put back if the server says no.
    setConv((c) => (c ? {
      ...c,
      members: (c.members || []).map((m) => (m.user_id === user.id ? { ...m, mood: mood || null } : m)),
    } : c));
    try {
      await chatApi.setMood(id, mood);
    } catch (err) {
      setConv((c) => (c ? { ...c, members: prevMembers } : c));
      setError(err);
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
  // Calls are one-to-one only: never register a group (or a conversation still loading) as the
  // viewed one, or the call provider opens /ws/call/<id>/ and the server rejects it every time.
  useEffect(() => {
    if (missing || !convLoaded || isGroup) return undefined;
    setViewedConversation(id);
    return () => clearViewedConversation(id);
  }, [id, missing, convLoaded, isGroup, setViewedConversation, clearViewedConversation]);
  const peerName = otherProfile?.display_name || otherProfile?.username || '\u2026';
  const peerAvatar = otherProfile?.avatar || null;
  const peerLoaded = Boolean(otherProfile);
  useEffect(() => {
    if (peerLoaded && !isGroup) setPeer(id, { name: peerName, avatar: peerAvatar });
  }, [id, peerLoaded, peerName, peerAvatar, setPeer, isGroup]);

  // Arriving from "Reply privately": put the quoted message in the box and focus it.
  useEffect(() => {
    const d = location.state?.draft;
    if (!d) return;
    setDraft(d);
    navigate(location.pathname, { replace: true, state: null }); // so a refresh doesn't re-fill it
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [location.state, location.pathname, navigate]);

  // ---- Group actions ----
  const runGroup = async (fn) => {
    setGroupBusy(true);
    setError(null);
    try { await fn(); } catch (err) { setError(err); } finally { setGroupBusy(false); }
  };
  const addPeople = async (ids) => {
    const c = await chatApi.addGroupMembers(id, ids);
    setConv(c);
    setPickerOpen(false);
  };
  const removePerson = (uid, name) => {
    if (!window.confirm(`Remove ${name} from this group?`)) return;
    runGroup(async () => { await chatApi.removeGroupMember(id, uid); await reloadConversation(); });
  };
  const renameGroupTo = (title) => runGroup(async () => { setConv(await chatApi.renameGroup(id, title)); });
  const getInvite = async (reset) => (await chatApi.getInviteCode(id, reset)).invite_code;
  const decideRequest = (requestId, action) => runGroup(async () => {
    await chatApi.decideJoinRequest(id, requestId, action);
    await Promise.all([reloadConversation(), reloadJoinRequests()]);
  });
  // Answer one person on their own: open (or start) your 1-to-1 chat with them, with the message
  // you are answering quoted in the draft so they know what it is about. Nothing is posted to the group.
  const messagePrivately = async (uid, name, m) => {
    setError(null);
    try {
      const direct = await chatApi.startConversation(uid);
      let draftText = '';
      if (m) {
        const what = m.body ? m.body.replace(/\s+/g, ' ').trim() : (isAudioMessage(m) ? 'your voice message' : 'your photo');
        const short = what.length > 80 ? `${what.slice(0, 77)}…` : what;
        draftText = `Re "${short}" (in ${groupName}): `;
      }
      navigate(`/chat/${direct.id}`, { state: { draft: draftText, from: name } });
    } catch (err) {
      setError(err);
    }
  };
  const leaveGroup = () => {
    if (!window.confirm('Leave this group? You will stop getting its messages.')) return;
    runGroup(async () => { await chatApi.removeGroupMember(id, user.id); navigate('/chat'); });
  };

  if (missing) {
    return (
      <div className="page">
        <h1>Conversation not found</h1>
        <p className="muted">
          This conversation doesn&rsquo;t exist, or it belongs to a different account than the one you&rsquo;re signed in with.
        </p>
        <p><Link to="/chat">Back to your conversations</Link></p>
      </div>
    );
  }

  if (!messages) return <div className="page"><Spinner /></div>;

  const presence = presenceLabel(otherProfile);
  const online = Boolean(presence?.online);
  const memberCount = conv?.members?.length || 0;
  const groupName = conv?.title
    || (conv?.members || []).filter((m) => m.user_id !== user.id).slice(0, 3)
      .map((m) => m.display_name || m.username || memberProfiles[m.user_id]?.display_name || memberProfiles[m.user_id]?.username || '…').join(', ')
    || 'Group chat';
  const panelProps = conv ? {
    conv, profiles: memberProfiles, meId: user.id, saver: saver.active, busy: groupBusy,
    requests: joinRequests, onDecide: decideRequest, onGetInvite: getInvite,
    onMessage: (uid, name) => messagePrivately(uid, name, null),
    onAdd: () => setPickerOpen(true), onRemove: removePerson, onRename: renameGroupTo, onLeave: leaveGroup,
  } : null;
  const displayName = isGroup ? groupName : (otherProfile?.display_name || otherProfile?.username || '…');
  const callBusy = call.status !== 'idle' && call.status !== 'ended';
  const peerInfo = { name: displayName, avatar: otherProfile?.avatar || null };

  return (
    <div className="page cv">
      <div className="cv-shell">
        <section className="cv-chat" aria-label={`Conversation with ${displayName}`}>
          <header className={`cv-head${isGroup ? ' cv-head--group' : ''}`}>
            {isGroup ? (
              <span className="cv-head__avatar cv-head__avatar--group" aria-hidden="true">👥</span>
            ) : otherUserId ? (
              <Link to={`/profile/${otherUserId}`} className="cv-head__avatar" aria-label={`${displayName}'s profile`}>
                {otherProfile?.avatar
                  ? <img src={otherProfile.avatar} alt="" />
                  : <span aria-hidden="true">{initialOf(otherProfile)}</span>}
              </Link>
            ) : null}
            <div className="cv-head__text">
              <h1 className="cv-head__name" title={displayName}>{displayName}</h1>
              {isGroup ? (
                <p className="cv-status cv-status--small">{memberCount} {memberCount === 1 ? 'person' : 'people'}</p>
              ) : (
                <p className="cv-status cv-status--small">
                  <span className={`cv-dot${online ? ' cv-dot--on' : ''}`} aria-hidden="true" />
                  {online ? 'Online now' : (presence?.text || 'Offline')}
                </p>
              )}
            </div>
            <div className="cv-head__actions">
              {!isGroup && (
                <>
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
                </>
              )}
              {isGroup && (
                <button type="button" className="cv-members-btn" aria-expanded={showMembers}
                  aria-label={`Members (${memberCount})${joinRequests.length ? `, ${joinRequests.length} waiting to join` : ''}`}
                  onClick={() => setShowMembers((v) => !v)}>
                  <span aria-hidden="true" className="cv-members-btn__icon">👥</span>
                  <span className="cv-members-btn__count">{memberCount}</span>
                  {joinRequests.length > 0 && <span className="cv-members-btn__dot" aria-hidden="true" />}
                </button>
              )}
              <button type="button" className={`cv-call-btn${saver.active ? ' is-on' : ''}`} aria-pressed={saver.active}
                onClick={() => saver.setSetting(saver.active ? 'off' : 'on')}
                aria-label={`Data saver is ${saver.active ? 'on' : 'off'}. Tap to turn it ${saver.active ? 'off' : 'on'}.`}
                title="Data saver: smaller photos, lower call quality, slower refresh">
                <DataSaverIcon />
                {saver.active && <span className="cv-saver-badge" aria-hidden="true">ON</span>}
                <span className="cv-call-btn__text">Data saver</span>
              </button>
              <span className={`cv-live${connected ? ' cv-live--on' : ''}`} role="status">
                <span className="cv-live__text">{connected ? 'Live' : 'Reconnecting…'}</span>
              </span>
            </div>
          </header>

          {saver.active && (
            <div className="cv-saver-note" role="status">
              <DataSaverIcon />
              <span>
                <strong>Data saver is on.</strong> Photos load when you tap them and calls use less data.
              </span>
              <button type="button" onClick={() => saver.setSetting('off')}>Turn off</button>
            </div>
          )}

          {isGroup && showMembers && conv && (
            <>
              <div className="cv-members-backdrop" onClick={() => setShowMembers(false)} aria-hidden="true" />
              <div className="cv-members-sheet" role="dialog" aria-modal="true" aria-label="Group members">
                <GroupPanel {...panelProps} onClose={() => setShowMembers(false)}
                  onMessage={(uid, name) => { setShowMembers(false); messagePrivately(uid, name, null); }} />
              </div>
            </>
          )}

          <ErrorAlert error={error} />

          {isGroup && conv && (
            <div className="gx-top">
              <VibeBar members={conv.members || []} profiles={memberProfiles} meId={user.id} />
              <MoodPicker value={moodOf((conv.members || []).find((m) => m.user_id === user.id))} onPick={changeMood} />
            </div>
          )}

          {isGroup && (conv?.pinned_messages?.length > 0) && (
            <div className={`gx-pins${pinsOpen ? ' is-open' : ''}`} role="region" aria-label="Pinned messages">
              <span className="gx-pins__icon" aria-hidden="true">📌</span>
              <ul className="gx-pins__list">
                {conv.pinned_messages.map((p) => (
                  <li key={p.id}>
                    <button type="button" className="gx-pin" onClick={() => jumpToMessage(p.id)}>
                      <strong>{p.sender === user.id ? 'You' : nameOfSender(p.sender)}</strong>
                      <span>{p.preview || (p.attachment_type === 'audio' ? '🎤 Voice message' : '📷 Photo')}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {conv.pinned_messages.length > 1 && (
                <button type="button" className="gx-pins__more" aria-expanded={pinsOpen} onClick={() => setPinsOpen((o) => !o)}>
                  {pinsOpen ? 'Less' : `+${conv.pinned_messages.length - 1}`}
                </button>
              )}
            </div>
          )}

          <div className={`cv-log${isGroup ? ' cv-log--group' : ''}`} ref={logRef} onScroll={onLogScroll}>
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
                <div key={m.id} data-mid={m.id}>
                  {newDay && <p className="cv-day"><span>{dayLabel(m.created_at)}</span></p>}
                  <div className={`cv-msg${mine ? ' cv-msg--mine' : ''}${joinsPrev ? ' cv-msg--joined' : ''}`}>
                    {isGroup && !mine && !joinsPrev && !m.is_deleted && (
                      <p className="cv-sender" style={{ color: colorFor(m.sender) }}>
                        <span className="cv-sender__name">{nameOfSender(m.sender)}</span>
                        {senderMood(m.sender) && (
                          <span className={`gx-dot gx-dot--${senderMood(m.sender)}`}
                            title={MOODS[senderMood(m.sender)].label} aria-hidden="true" />
                        )}
                      </p>
                    )}
                    <div className="cv-msg__row">
                      <div
                        className={`cv-bubble${m.is_deleted ? ' cv-bubble--deleted' : ''}${!m.is_deleted && isAudioMessage(m) ? ' cv-bubble--voice' : ''}`}
                        data-msg-menu
                        tabIndex={m.is_deleted ? undefined : 0}
                        aria-expanded={m.is_deleted ? undefined : menuFor === m.id}
                        onKeyDown={(e) => {
                          if (m.is_deleted || e.target !== e.currentTarget) return;
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setReactTarget(null);
                            setMenuFor((cur) => (cur === m.id ? null : m.id));
                          }
                        }}
                        onDoubleClick={() => !m.is_deleted && toggleReaction(m.id, '❤️')}
                        onClick={(e) => {
                          if (m.is_deleted) return;
                          if (e.target.closest('a, button, input, audio, label')) return;
                          if (window.getSelection && String(window.getSelection()).length) return; // selecting text, not tapping
                          setReactTarget(null);
                          setMenuFor((cur) => (cur === m.id ? null : m.id));
                        }}
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
                            ) : isAudioMessage(m) ? (
                              <VoicePlayer src={mediaUrl(m.attachment_url)} mine={mine} knownDuration={m.duration} saver={saver.active} />
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
                              <LongText text={m.body}
                                className={m.attachment_url || m.attachment_view_once ? 'cv-bubble__caption' : undefined} />
                            )}
                          </>
                        )}
                      </div>

                    </div>

                    {menuFor === m.id && !m.is_deleted && (
                      <div className="cv-actions" role="toolbar" aria-label="Message actions" data-msg-menu>
                        <div className="cv-react" data-react-pop>
                          <button type="button" className="cv-actions__btn" aria-label="React to this message" aria-expanded={pickerHere}
                            onClick={() => setReactTarget(pickerHere ? null : { id: m.id, full: false })}>
                            <span aria-hidden="true">☺</span><span className="cv-actions__label">React</span>
                          </button>
                          {pickerHere && (
                            <div className="cv-react__pop" data-react-pop>
                              {reactTarget.full ? (
                                <EmojiPalette label="Pick a reaction" onPick={(e) => { toggleReaction(m.id, e); setMenuFor(null); }} />
                              ) : (
                                <div className="cv-quick" role="group" aria-label="Quick reactions">
                                  {QUICK_REACTIONS.map((e) => (
                                    <button key={e} type="button"
                                      className={`cv-quick__btn${mineReactions.includes(e) ? ' is-on' : ''}`}
                                      aria-label={`React with ${e}`} aria-pressed={mineReactions.includes(e)}
                                      onClick={() => { toggleReaction(m.id, e); setMenuFor(null); }}>{e}</button>
                                  ))}
                                  <button type="button" className="cv-quick__btn cv-quick__more" aria-label="More emoji"
                                    onClick={() => setReactTarget({ id: m.id, full: true })}>+</button>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                        {isGroup && !mine && (
                          <button type="button" className="cv-actions__btn" aria-label={`Reply privately to ${nameOfSender(m.sender)}`}
                            onClick={() => { setMenuFor(null); messagePrivately(m.sender, nameOfSender(m.sender), m); }}>
                            <span aria-hidden="true">↩</span><span className="cv-actions__label">Reply privately</span>
                          </button>
                        )}
                        {isGroup && (
                          <button type="button" className={`cv-actions__btn${m.pinned ? ' is-on' : ''}`} aria-pressed={Boolean(m.pinned)}
                            aria-label={m.pinned ? 'Unpin this message' : 'Pin this message'}
                            onClick={() => { setMenuFor(null); togglePin(m); }}>
                            <span aria-hidden="true">📌</span><span className="cv-actions__label">{m.pinned ? 'Unpin' : 'Pin'}</span>
                          </button>
                        )}
                        {mine && (
                          <button type="button" className="cv-actions__btn cv-actions__btn--danger" aria-label="Delete this message"
                            onClick={() => { setMenuFor(null); handleDelete(m); }}>
                            <span aria-hidden="true">🗑</span><span className="cv-actions__label">Delete</span>
                          </button>
                        )}
                      </div>
                    )}

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

            {outbox.map((o) => (
              <div key={o.tempId} className="cv-msg cv-msg--mine">
                <div className="cv-msg__row">
                  <div className={`cv-bubble cv-bubble--pending${o.status === 'failed' ? ' cv-bubble--failed' : ''}`}>
                    {o.kind === 'image' && o.preview && <img className="cv-bubble__img" src={o.preview} alt="Photo being sent" />}
                    {o.kind === 'voice' && <p>🎤 Voice message · {fmtClock(o.duration)}</p>}
                    {o.body && <LongText text={o.body} className={o.kind === 'image' ? 'cv-bubble__caption' : undefined} />}
                  </div>
                </div>
                {o.status === 'failed' ? (
                  <p className="cv-outbox cv-outbox--failed" role="alert">
                    <span>Not sent{o.error ? `: ${o.error}` : ''}</span>
                    <button type="button" onClick={() => resend(o)}>Resend</button>
                    <button type="button" onClick={() => dropOutbox(o.tempId)}>Discard</button>
                  </p>
                ) : (
                  <p className="cv-outbox" role="status">Sending…</p>
                )}
              </div>
            ))}
            {outbox.filter((o) => o.status === 'failed').length > 1 && (
              <p className="cv-outbox cv-outbox--failed">
                <button type="button" onClick={resendAllFailed}>Resend all not sent</button>
              </p>
            )}
          </div>

          {attachmentPreview && (
            <div className="cv-attach">
              <img src={attachmentPreview} alt="" />
              {!isGroup && (
                <label className="cv-once-toggle">
                  <input type="checkbox" checked={viewOnce} onChange={(e) => setViewOnce(e.target.checked)} />
                  View once
                </label>
              )}
              <button type="button" className="btn btn--ghost btn--sm" onClick={clearAttachment}>Remove</button>
            </div>
          )}

          <div className="cv-composer-wrap">
            {paletteOpen && (
              <div className="cv-composer-pop" data-emoji-pop>
                <EmojiPalette onPick={insertEmoji} />
              </div>
            )}
            {recState === 'recording' ? (
              <div className="cv-composer cv-composer--rec" role="status" aria-live="polite">
                <button type="button" className="cv-icon-btn" onClick={() => finishRecording(true)} aria-label="Cancel recording" title="Cancel">
                  <TrashIcon />
                </button>
                <span className="cv-rec__dot" aria-hidden="true" />
                <span className="cv-rec__time">{fmtClock(recSecs)}</span>
                <span className="cv-rec__hint">Recording… max {fmtClock(MAX_VOICE_SECONDS)}</span>
                <button type="button" className="cv-send cv-send--rec" onClick={() => finishRecording(false)} aria-label="Stop and send voice message">
                  <StopIcon size={14} /> Send
                </button>
              </div>
            ) : (
            <form onSubmit={handleSend} className="cv-composer">
              <label className="cv-icon-btn" aria-label="Attach an image">
                <PaperclipIcon />
                <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={handleFileChange} />
              </label>
              <textarea
                ref={inputRef}
                className="cv-composer__input"
                placeholder="Write a message…"
                aria-label="Message"
                rows={1}
                enterKeyHint="send"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onDraftKeyDown}
                maxLength={4000}
              />
              {draft.length > 3500 && (
                <span className={`cv-count${draft.length >= 3950 ? ' is-max' : ''}`} aria-live="polite">{4000 - draft.length}</span>
              )}
              <button
                type="button"
                className={`cv-icon-btn cv-icon-btn--emoji${paletteOpen ? ' is-open' : ''}`}
                aria-label="Open emoji palette"
                aria-expanded={paletteOpen}
                data-emoji-pop
                onClick={() => { setReactTarget(null); setPaletteOpen((o) => !o); }}
              >☺</button>
              {draft.trim() || attachment ? (
                <button className="cv-send" type="submit">Send</button>
              ) : (
                <button className="cv-icon-btn cv-mic" type="button" onClick={startRecording}
                  aria-label="Record a voice message" title="Record a voice message">
                  <MicIcon />
                </button>
              )}
            </form>
            )}
          </div>
        </section>

        {isGroup ? (
          <aside className="cv-canvas cv-canvas--group" aria-label="Group members">
            {conv && <GroupPanel {...panelProps} />}
          </aside>
        ) : (
          <PortraitCanvas profile={otherProfile} otherUserId={otherUserId} presence={presence} />
        )}
      </div>
      {pickerOpen && conv && (
        <PeoplePicker
          title="Add people"
          submitLabel="Add to group"
          minPick={1}
          maxPick={20 - (conv.members?.length || 0)}
          excludeIds={(conv.members || []).map((m) => m.user_id)}
          saver={saver.active}
          onSubmit={addPeople}
          onClose={() => setPickerOpen(false)}
        />
      )}
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