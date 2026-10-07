import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './group.css';
import './group-panel.css';

const MAX_MEMBERS = 20;

/* ---- Mood colours: a quiet way to show how you feel without sending a message ---- */
export const MOODS = {
  happy: { label: 'Happy', hint: 'feeling good' },
  calm: { label: 'Calm', hint: 'relaxed' },
  meh: { label: 'Bleh', hint: 'just okay' },
  low: { label: 'Low', hint: 'a bit down' },
  upset: { label: 'Upset', hint: 'stressed or upset' },
};
const MOOD_TTL_MS = 24 * 60 * 60 * 1000; // matches the server: a mood fades after a day

/** The member's current mood key, or null (unset, unknown, or faded). */
export const moodOf = (member) => {
  if (!member?.mood || !MOODS[member.mood]) return null;
  if (member.mood_set_at && Date.now() - new Date(member.mood_set_at).getTime() > MOOD_TTL_MS) return null;
  return member.mood;
};

/** My own mood: tap, pick a colour. Nobody is notified and no message is posted. */
export function MoodPicker({ value, onPick }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="gx-mood">
      <button type="button" className="gx-mood__btn" aria-expanded={open} aria-haspopup="true"
        title="Share how you feel, quietly" onClick={() => setOpen((o) => !o)}>
        <span className={`gx-dot gx-dot--lg ${value ? `gx-dot--${value}` : 'gx-dot--none'}`} aria-hidden="true" />
        <span className="gx-mood__text">{value ? MOODS[value].label : 'My mood'}</span>
      </button>
      {open && (
        <div className="gx-mood__pop" role="group" aria-label="Pick your mood colour">
          <div className="gx-mood__swatches">
            {Object.entries(MOODS).map(([key, m]) => (
              <button key={key} type="button" className={`gx-swatch gx-dot--${key}${value === key ? ' is-on' : ''}`}
                aria-pressed={value === key} aria-label={`${m.label} (${m.hint})`} title={`${m.label}: ${m.hint}`}
                onClick={() => { onPick(key); setOpen(false); }} />
            ))}
          </div>
          {value && (
            <button type="button" className="gx-mood__clear" onClick={() => { onPick(''); setOpen(false); }}>Clear my mood</button>
          )}
          <p className="gx-mood__note">Just a colour. Nobody is notified, and it fades after a day.</p>
        </div>
      )}
    </div>
  );
}

/** A thin strip of everyone's colours, so the group's mood can be felt at a glance. */
export function VibeBar({ members }) {
  const counts = {};
  let total = 0;
  (members || []).forEach((m) => {
    const k = moodOf(m);
    if (k) { counts[k] = (counts[k] || 0) + 1; total += 1; }
  });
  if (!total) return <p className="gx-vibe gx-vibe--empty">No mood colours yet</p>;
  const summary = Object.entries(counts).map(([k, n]) => `${n} ${MOODS[k].label.toLowerCase()}`).join(', ');
  return (
    <div className="gx-vibe" role="img" aria-label={`Group mood: ${summary}`} title={summary}>
      {Object.entries(counts).map(([k, n]) => (
        <span key={k} className={`gx-vibe__seg gx-dot--${k}`} style={{ flexGrow: n }} />
      ))}
    </div>
  );
}

/** Invite link (admins): make it, copy it, or replace it if it leaked. People who open it can only ASK to join. */
function InviteBox({ onGetInvite, busy }) {
  const [link, setLink] = useState('');
  const [note, setNote] = useState('');
  const [working, setWorking] = useState(false);

  const make = async (reset) => {
    if (reset && !window.confirm('Replace the invite link? The old link will stop working.')) return;
    setWorking(true);
    setNote('');
    try {
      const code = await onGetInvite(reset);
      setLink(`${window.location.origin}/chat/join/${code}`);
      if (reset) setNote('New link made. The old one no longer works.');
    } catch (err) {
      setNote(err?.message || 'Could not make a link.');
    } finally {
      setWorking(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setNote('Link copied.');
    } catch {
      setNote('Press and hold the link to copy it.');
    }
  };
  const share = () => navigator.share({ title: 'Join my group', url: link }).catch(() => {});

  return (
    <div className="gpanel__section">
      <h3 className="gpanel__h">Invite link</h3>
      {!link ? (
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => make(false)} disabled={busy || working}>
          Get invite link
        </button>
      ) : (
        <>
          <input className="gp-input gpanel__link-input" readOnly value={link} aria-label="Invite link"
            onFocus={(e) => e.target.select()} />
          <div className="gpanel__actions">
            <button type="button" className="btn btn--sm btn--primary" onClick={copy}>Copy</button>
            {typeof navigator !== 'undefined' && navigator.share && (
              <button type="button" className="btn btn--sm btn--ghost" onClick={share}>Share</button>
            )}
            <button type="button" className="gpanel__link gpanel__link--danger" onClick={() => make(true)} disabled={working}>
              Replace link
            </button>
          </div>
        </>
      )}
      <p className="gpanel__hint" role="status">{note || 'Anyone with the link can ask to join. You decide who gets in.'}</p>
    </div>
  );
}

const Ico = ({ children, size = 18 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{children}</svg>
);
const PencilIcon = () => <Ico><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z" /><path d="M13.5 6.5l4 4" /></Ico>;
const ChatIcon = () => <Ico><path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.1A8 8 0 1 1 20 12z" /></Ico>;
const DotsIcon = () => (
  <Ico><circle cx="5" cy="12" r="1.3" fill="currentColor" /><circle cx="12" cy="12" r="1.3" fill="currentColor" /><circle cx="19" cy="12" r="1.3" fill="currentColor" /></Ico>
);
const PlusIcon = () => <Ico size={16}><path d="M12 5v14M5 12h14" /></Ico>;
const UserMinusIcon = () => <Ico><circle cx="9" cy="8" r="3.2" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" /><path d="M17 11h5" /></Ico>;

/** The "..." on a member row (admins): small menu with Remove. Rendered in <body> so the scrolling list can't clip it. */
function RowMenu({ name, onRemove, busy }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, right: 8 });
  const btnRef = useRef(null);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = () => setOpen(false);
    const onDown = (e) => {
      if (menuRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return;
      close();
    };
    const onKey = (e) => { if (e.key === 'Escape') { close(); btnRef.current?.focus(); } };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [open]);

  const toggle = () => {
    if (open) { setOpen(false); return; }
    const r = btnRef.current.getBoundingClientRect();
    const h = 62;                                              // one item + padding
    const fitsBelow = window.innerHeight - r.bottom > h + 12;
    setPos({ top: fitsBelow ? r.bottom + 6 : r.top - 6 - h, right: Math.max(8, window.innerWidth - r.right) });
    setOpen(true);
  };

  return (
    <>
      <button ref={btnRef} type="button" className="gpanel__rowbtn" aria-haspopup="menu" aria-expanded={open}
        aria-label={`More options for ${name}`} disabled={busy} onClick={toggle}>
        <DotsIcon />
      </button>
      {open && createPortal(
        <div ref={menuRef} className="gpanel-menu" role="menu" style={{ top: pos.top, right: pos.right }}>
          <button type="button" role="menuitem" className="gpanel-menu__item gpanel-menu__item--danger"
            onClick={() => { setOpen(false); onRemove(); }}>
            <UserMinusIcon /> Remove from group
          </button>
        </div>,
        document.body,
      )}
    </>
  );
}

/** Member list for a group chat: names, roles, private message, and (for admins) rename / add / remove / join requests. */
export default function GroupPanel({
  conv, profiles, meId, saver, busy,
  requests = [], onDecide, onGetInvite, onMessage, onClose,
  onAdd, onRemove, onRename, onLeave,
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(conv.title || '');
  const isAdmin = conv.my_role === 'admin';
  const members = conv.members || [];
  const countText = `${members.length} ${members.length === 1 ? 'person' : 'people'}`;

  const save = (e) => {
    e.preventDefault();
    onRename(title.trim());
    setEditing(false);
  };

  return (
    <div className="gpanel">
      <header className="gpanel__head">
        <span className="gpanel__icon" aria-hidden="true">👥</span>
        <div className="gpanel__headtxt">
          {editing ? (
            <form onSubmit={save} className="gpanel__rename">
              <input className="gp-input" value={title} maxLength={80} aria-label="Group name"
                onChange={(e) => setTitle(e.target.value)} autoFocus />
              <button type="submit" className="btn btn--sm btn--primary">Save</button>
            </form>
          ) : (
            <>
              <h2 className="gpanel__title" title={conv.title || 'Group chat'}>{conv.title || 'Group chat'}</h2>
              <p className="gpanel__count">{countText}</p>
            </>
          )}
        </div>
        {isAdmin && !editing && (
          <button type="button" className="gpanel__iconbtn" aria-label="Rename group" title="Rename group"
            onClick={() => { setTitle(conv.title || ''); setEditing(true); }}>
            <PencilIcon />
          </button>
        )}
        {onClose && (
          <button type="button" className="gpanel__iconbtn gpanel__close" onClick={onClose} aria-label="Close member list">&times;</button>
        )}
      </header>

      <div className="gpanel__body">
        {isAdmin && requests.length > 0 && (
          <div className="gpanel__section gpanel__section--requests" role="region" aria-label="Requests to join">
            <h3 className="gpanel__h">Asking to join ({requests.length})</h3>
            <ul className="gpanel__reqs">
              {requests.map((r) => {
                const rname = r.display_name || r.username || 'Someone';
                return (
                  <li key={r.id} className="gpanel__req">
                    <span className="gpanel__req-name break">
                      {rname}
                      {r.username && r.display_name && r.display_name !== r.username && <small> @{r.username}</small>}
                    </span>
                    <span className="gpanel__req-btns">
                      <button type="button" className="btn btn--sm btn--primary" disabled={busy}
                        onClick={() => onDecide(r.id, 'approve')} aria-label={`Let ${rname} in`}>Accept</button>
                      <button type="button" className="btn btn--sm btn--ghost" disabled={busy}
                        onClick={() => onDecide(r.id, 'decline')} aria-label={`Decline ${rname}`}>Decline</button>
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <div className="gpanel__sechead">
          <h3>Members</h3>
          {isAdmin && members.length < MAX_MEMBERS && (
            <button type="button" className="gpanel__add" onClick={onAdd} disabled={busy}><PlusIcon /> Add people</button>
          )}
        </div>

        <ul className="gpanel__list">
          {members.map((m) => {
            const p = profiles[m.user_id];
            const isMe = m.user_id === meId;
            // The server sends each member's name, so everyone in the group sees real names.
            const name = isMe ? 'You' : (m.display_name || m.username || p?.display_name || p?.username || 'Member');
            const mood = moodOf(m);
            return (
              <li key={m.user_id} className="gpanel__row">
                <span className="gpanel__avatar-slot">
                  <span className={`gp-avatar${mood ? ` gx-ring gx-ring--${mood}` : ''}`} aria-hidden="true">
                    {p?.avatar && !saver ? <img src={p.avatar} alt="" loading="lazy" /> : name[0]?.toUpperCase()}
                  </span>
                </span>
                <span className="gpanel__who">
                  <span className="gpanel__nameline">
                    <span className="gpanel__name-text" title={name}>{name}</span>
                    {m.role === 'admin' && <span className="gpanel__badge">Admin</span>}
                  </span>
                  {mood && (
                    <span className="gpanel__sub">
                      <span className={`gx-dot gx-dot--${mood}`} aria-hidden="true" />{MOODS[mood].label}
                    </span>
                  )}
                </span>
                {!isMe && (onMessage || isAdmin) && (
                  <span className="gpanel__row-actions">
                    {onMessage && (
                      <button type="button" className="gpanel__rowbtn" disabled={busy} title="Message privately"
                        onClick={() => onMessage(m.user_id, name)} aria-label={`Message ${name} privately`}>
                        <ChatIcon />
                      </button>
                    )}
                    {isAdmin && <RowMenu name={name} busy={busy} onRemove={() => onRemove(m.user_id, name)} />}
                  </span>
                )}
              </li>
            );
          })}
        </ul>

        {isAdmin && onGetInvite && <InviteBox onGetInvite={onGetInvite} busy={busy} />}
      </div>

      <footer className="gpanel__foot">
        <button type="button" className="gpanel__leave" onClick={onLeave} disabled={busy}>Leave group</button>
      </footer>
    </div>
  );
}
