import '../../styles/index.css';
import './inbox.css';
import { usePageBackdrop } from '../../hooks/usePageBackdrop';
import { useArchivedChats } from '../../hooks/useArchivedChats';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import * as chatApi from '../../api/chat';
import * as accountsApi from '../../api/accounts';
import { ChillLoader, ErrorAlert } from '../../components/ui';
import PeoplePicker from '../../components/PeoplePicker';
import { useDataSaver } from '../../hooks/useDataSaver';
import { useAuth } from '../../context/AuthContext';
import './group.css';
import Chopper from '../../components/Chopper';
import { presenceLabel } from '../../utils/presence';
import { archiveHint, isShelved, startedLabel } from '../../utils/chatAge';
import { Icon } from '../../components/icons';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export default function ConversationList() {
  usePageBackdrop('couples');
  const [conversations, setConversations] = useState(null);
  const [profiles, setProfiles] = useState({});
  const [error, setError] = useState(null);
  const navigate = useNavigate();
  const saver = useDataSaver();
  const { user } = useAuth();
  const [groupOpen, setGroupOpen] = useState(false);
  const [flight, setFlight] = useState(0); // bump to send the chopper round again
  const [view, setView] = useState('inbox'); // 'inbox' | 'archived'
  const [undo, setUndo] = useState(null);    // { ids, label } for the "Archived. Undo" line
  const { archived, archive, restore } = useArchivedChats();

  const profilesRef = useRef({});

  // Fetch the list, plus profiles for anyone new. Profiles of the first few people are
  // refreshed each time so the "Online" dots and "Active 5m ago" don't go stale.
  const load = useCallback(async () => {
    const data = await chatApi.listConversations();
    const list = data.results ?? data;
    setConversations(list);

    const ids = [...new Set(list.map((c) => (c.is_group
      ? (c.last_message && c.last_message.sender_id !== String(user?.id) ? c.last_message.sender_id : null)
      : c.other_user_id)).filter(Boolean))];
    const wanted = ids.filter((id, i) => !profilesRef.current[id] || i < 12);
    if (!wanted.length) return;
    const entries = await Promise.all(
      wanted.map((id) =>
        accountsApi.getPublicProfile(id)
          .then((p) => [id, p])
          .catch(() => [id, profilesRef.current[id] ?? { username: 'Unknown user' }])
      )
    );
    profilesRef.current = { ...profilesRef.current, ...Object.fromEntries(entries) };
    setProfiles(profilesRef.current);
  }, [user?.id]);

  // Keep the inbox live without a refresh: poll while visible, and refresh the moment
  // the tab regains focus or the network comes back.
  useEffect(() => {
    load().catch(setError);
    const tick = () => { if (document.visibilityState === 'visible') load().catch(() => {}); };
    const timer = setInterval(tick, 15000);
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('focus', tick);
    window.addEventListener('online', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
      window.removeEventListener('focus', tick);
      window.removeEventListener('online', tick);
    };
  }, [load]);

  useEffect(() => {
    if (!undo) return undefined;
    const t = setTimeout(() => setUndo(null), 7000);
    return () => clearTimeout(t);
  }, [undo]);

  const { inbox, shelf } = useMemo(() => {
    const all = conversations ?? [];
    return {
      inbox: all.filter((c) => !isShelved(c, archived[c.id])),
      shelf: all.filter((c) => isShelved(c, archived[c.id])),
    };
  }, [conversations, archived]);

  const unreadTotal = inbox.reduce((sum, c) => sum + (c.unread_count || 0), 0);
  const suggested = useMemo(() => inbox.filter((c) => archiveHint(c)), [inbox]);
  const shown = view === 'inbox' ? inbox : shelf;

  const nameOf = (c) => (c.is_group ? (c.title || 'that group') : (profiles[c.other_user_id]?.username || 'that chat'));

  // People you already talk to, offered first when picking group members.
  const suggestions = useMemo(
    () => (conversations ?? []).filter((c) => !c.is_group && profiles[c.other_user_id])
      .map((c) => ({ id: c.other_user_id, ...profiles[c.other_user_id] })),
    [conversations, profiles],
  );
  const createGroup = async (ids, title) => {
    const c = await chatApi.createGroup(ids, title);
    setGroupOpen(false);
    navigate(`/chat/${c.id}`);
  };

  const archiveOne = (c) => {
    archive(c.id);
    setUndo({ ids: [c.id], label: `Archived ${nameOf(c)}` });
  };
  const archiveQuiet = () => {
    archive(suggested.map((c) => c.id));
    setUndo({ ids: suggested.map((c) => c.id), label: `Archived ${plural(suggested.length, "chat", "chats")}` });
  };
  const undoArchive = () => {
    undo.ids.forEach(restore);
    setUndo(null);
  };

  let tagline = 'Everyone you have been talking to, fresh off the chopper.';
  if (inbox.length && unreadTotal > 0) {
    tagline = `${plural(unreadTotal, 'new drop', 'new drops')} waiting. Go collect.`;
  } else if (inbox.length) {
    tagline = 'All caught up. The pilot is on his lunch break.';
  }

  return (
    <div className="page inbox">
      <Chopper key={flight} />

      <header className="inbox__head">
        <h1 className="inbox__title">Gist, airdropped.</h1>
        <div className="inbox__sub">
          <p>{tagline}</p>
          <button type="button" className="inbox__link" onClick={() => setFlight((n) => n + 1)}>
            Send the chopper again
          </button>
          <button type="button" className="btn btn--sm btn--primary" onClick={() => setGroupOpen(true)}>
            New group
          </button>
        </div>
      </header>

      <ErrorAlert error={error} />

      {conversations?.length > 0 && (
        <div className="inbox__tabs" role="group" aria-label="Which chats to show">
          <button type="button" className="inbox__tab" aria-pressed={view === 'inbox'} onClick={() => setView('inbox')}>
            Inbox <span>{inbox.length}</span>
          </button>
          <button type="button" className="inbox__tab" aria-pressed={view === 'archived'} onClick={() => setView('archived')}>
            Archived <span>{shelf.length}</span>
          </button>
        </div>
      )}

      <div className="inbox__live" role="status" aria-live="polite">
        {undo && (
          <p className="inbox__undo">
            {undo.label}{' '}
            <button type="button" className="inbox__link" onClick={undoArchive}>Undo</button>
          </p>
        )}
      </div>

      {view === 'inbox' && suggested.length > 0 && (
        <div className="inbox__tidy">
          <p>
            {suggested.length === 1
              ? '1 chat has gone quiet or run long.'
              : `${suggested.length} chats have gone quiet or run long.`}
          </p>
          <button type="button" className="btn btn--sm btn--primary" onClick={archiveQuiet}>
            Archive {suggested.length === 1 ? 'it' : 'them'}
          </button>
        </div>
      )}

      {!conversations && !error && (
        <ChillLoader kind="chat" rows={4} />
      )}

      {conversations?.length === 0 && (
        <div className="inbox__empty">
          <p className="inbox__empty-title">No gist yet.</p>
          <p>The chopper flew past twice and nobody answered the door. Message someone from their listing and give it something to carry.</p>
          <Link to="/services" className="btn btn--primary">Go find someone to talk to</Link>
        </div>
      )}

      {conversations?.length > 0 && shown.length === 0 && (
        <div className="inbox__empty">
          <p className="inbox__empty-title">{view === 'archived' ? 'Nothing in the archive.' : 'Inbox zero.'}</p>
          <p>
            {view === 'archived'
              ? 'Chats you archive wait here, and come back on their own if the other person writes again.'
              : 'Everything is archived. Check the Archived tab if you miss someone.'}
          </p>
        </div>
      )}

      <ul className="inbox__list">
        {shown.map((c, i) => {
          const isGroup = Boolean(c.is_group);
          const profile = isGroup ? null : profiles[c.other_user_id];
          const presence = isGroup ? null : presenceLabel(profile);
          const unread = c.unread_count > 0;
          const hint = view === 'inbox' ? archiveHint(c) : null;
          const started = startedLabel(c.created_at);
          const name = isGroup ? (c.title || 'Group chat') : (profile?.username || '…');
          const preview = c.last_message
            ? (c.last_message.body === null ? 'Message deleted'
              : c.last_message.body || (c.last_message.attachment_type === 'audio' ? 'Voice message' : 'Photo'))
            : 'Nothing yet. Be brave, say hi.';
          // In a group, say who wrote the last message.
          const lastSender = isGroup && c.last_message
            ? (c.last_message.sender_id === String(user?.id) ? 'You' : (profiles[c.last_message.sender_id]?.username || 'Someone'))
            : null;
          const previewText = lastSender ? `${lastSender}: ${preview}` : preview;

          return (
            <li key={c.id} className="inbox__item" style={{ '--i': Math.min(i, 10) }}>
              <Link to={`/chat/${c.id}`} className={`drop-row${unread ? ' drop-row--unread' : ''}${view === 'archived' ? ' drop-row--shelved' : ''}`}>
                <span className="avatar-wrap">
                  <span className="avatar" aria-hidden="true">{isGroup ? <Icon name="users" size={20} /> : name[0]?.toUpperCase()}</span>
                  {presence?.online && <span className="dot-online" role="img" aria-label="Online" />}
                </span>

                <span className="bubble">
                  <span className="bubble__top">
                    <strong className="bubble__name truncate">{name}</strong>
                    {presence?.text && (
                      <span className="bubble__aside">{presence.online ? 'Online' : presence.text}</span>
                    )}
                  </span>
                  <span className={`bubble__text truncate${c.last_message ? '' : ' bubble__text--empty'}`}>
                    {previewText}
                  </span>
                  <span className="bubble__meta">
                    {unread && <span className="bubble__badge">{plural(c.unread_count, 'new drop', 'new drops')}</span>}
                    {isGroup && <span className="bubble__started">{c.members?.length || 0} people</span>}
                    {started && <span className="bubble__started">Started {started}</span>}
                    {hint && <span className={`bubble__hint bubble__hint--${hint.kind}`}>{hint.label}</span>}
                  </span>
                </span>
              </Link>

              {view === 'inbox' ? (
                <button
                  type="button"
                  className="inbox__archive"
                  onClick={() => archiveOne(c)}
                  aria-label={`Archive chat with ${name}`}
                >
                  <Icon name="archive" size={18} /><span className="inbox__archive-txt">Archive</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="inbox__archive"
                  onClick={() => restore(c.id)}
                  aria-label={`Move chat with ${name} back to inbox`}
                >
                  <Icon name="unarchive" size={18} /><span className="inbox__archive-txt">Unarchive</span>
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {groupOpen && (
        <PeoplePicker
          title="New group"
          submitLabel="Create group"
          minPick={2}
          maxPick={19}
          askTitle
          suggestions={suggestions}
          saver={saver.active}
          onSubmit={createGroup}
          onClose={() => setGroupOpen(false)}
        />
      )}
    </div>
  );
}
