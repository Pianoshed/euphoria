import '../../styles/index.css';
import './chat.css';
import { usePageBackdrop } from '../../hooks/usePageBackdrop';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import * as chatApi from '../../api/chat';
import * as accountsApi from '../../api/accounts';
import { useAuth } from '../../context/AuthContext';
import { useChatSocket } from '../../hooks/useChatSocket';
import { useVideoCall } from '../../hooks/useVideoCall';
import VideoCallPanel from './VideoCallPanel';
import { ErrorAlert, Spinner } from '../../components/ui';
import { PaperclipIcon } from '../../components/icons';
import { presenceLabel } from '../../utils/presence';

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
  const call = useVideoCall({ conversationId: id, myId: user.id });
  const [messages, setMessages] = useState(null);
  const [otherProfile, setOtherProfile] = useState(null);
  const [otherUserId, setOtherUserId] = useState(null);
  const [error, setError] = useState(null);
  const [draft, setDraft] = useState('');
  const [attachment, setAttachment] = useState(null);
  const [attachmentPreview, setAttachmentPreview] = useState(null);
  const [sending, setSending] = useState(false);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [reactTarget, setReactTarget] = useState(null); // { id, full }
  // Reactions are stored in this browser only (see note in chat.css / README).
  // Shape: { [messageId]: ['❤️', '😂'] } = the emoji *I* reacted with.
  const [reactions, setReactions] = useState({});

  const logRef = useRef(null);
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

    chatApi.listMessages(id).then((data) => setMessages(data.results ?? data)).catch(setError);
    chatApi.markConversationRead(id).catch(() => {});
    setReactions(readJSON(reactionsKey(id), {}));
  }, [id]);

  // Scroll the message list itself. scrollIntoView() also scrolled the whole page,
  // which on a phone yanked the header out of view every time a message arrived.
  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [messages]);

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
  const { connected, sendOverSocket } = useChatSocket(id, {
    onMessage: (data) => {
      if (data.type === 'message') {
        setMessages((prev) => (prev?.some((m) => m.id === data.id) ? prev : [...(prev || []), {
          id: data.id, conversation: data.conversation_id, sender: data.sender_id,
          body: data.body, attachment_url: data.attachment_url ?? null,
          created_at: data.created_at, is_deleted: false, edited_at: null,
        }]));
      } else if (data.type === 'error') {
        setError(new Error(data.detail));
      }
    },
  });

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    setAttachment(file || null);
    setAttachmentPreview(file ? URL.createObjectURL(file) : null);
  };

  const clearAttachment = () => {
    setAttachment(null);
    setAttachmentPreview(null);
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
    setDraft('');
    clearAttachment();
    try {
      if (pendingAttachment) {
        // File uploads can't go over the plain-text WS protocol this
        // app uses -- always REST for these.
        const message = await chatApi.sendMessage(id, body, pendingAttachment);
        setMessages((prev) => [...(prev || []), message]);
      } else if (!sendOverSocket(body)) {
        // Prefer the live socket for plain text (near-instant echo to
        // both sides); fall back to REST if it isn't connected.
        const message = await chatApi.sendMessage(id, body);
        setMessages((prev) => [...(prev || []), message]);
      }
    } catch (err) {
      setError(err);
      setDraft(body);
    } finally {
      setSending(false);
    }
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

  if (!messages) return <div className="page"><Spinner /></div>;

  const presence = presenceLabel(otherProfile);
  const online = Boolean(presence?.online);
  const displayName = otherProfile?.display_name || otherProfile?.username || '…';

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
              <h1 className="cv-head__name break">{displayName}</h1>
              <p className="cv-status cv-status--small">
                <span className={`cv-dot${online ? ' cv-dot--on' : ''}`} aria-hidden="true" />
                {online ? 'Online now' : (presence?.text || 'Offline')}
              </p>
            </div>
            <button
              type="button"
              className="cv-call-btn"
              onClick={call.startCall}
              disabled={!call.signalReady || call.status !== 'idle'}
              aria-label={`Start a video call with ${displayName}`}
            >
              📹 Video
            </button>
            <span className={`cv-live${connected ? ' cv-live--on' : ''}`} role="status">
              {connected ? 'Live' : 'Reconnecting…'}
            </span>
          </header>

          <ErrorAlert error={error} />

          <div className="cv-log" ref={logRef}>
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
                            {m.attachment_url && (
                              <a href={m.attachment_url} target="_blank" rel="noreferrer">
                                <img className="cv-bubble__img" src={m.attachment_url} alt="Attachment" loading="lazy" />
                              </a>
                            )}
                            {m.body && <p className={m.attachment_url ? 'cv-bubble__caption' : undefined}>{m.body}</p>}
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
      <VideoCallPanel call={call} name={displayName} avatar={otherProfile?.avatar} />
    </div>
  );
}