import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as accountsApi from '../api/accounts';
import { useAuth } from '../context/AuthContext';
import { ErrorAlert } from './ui';
import '../pages/chat/group.css';
import './people-picker.css';

const toPerson = (p) => ({
  id: String(p.id),
  name: p.display_name || p.username || 'Someone',
  handle: p.username || '',
  avatar: p.avatar || null,
});

/**
 * Modal for choosing several people: used to start a group and to add people to one.
 * `suggestions` are people the user already talks to; typing 2+ letters searches everyone.
 * Data saver: no avatar images are downloaded (initials only) and nothing is searched until you type.
 * Mobile: opens as a bottom sheet; desktop: centred card. Smooth enter/exit, shadows, safe-area aware.
 */
export default function PeoplePicker({
  title, submitLabel, minPick = 1, maxPick = 19, excludeIds = [], suggestions = [],
  saver = false, askTitle = false, titlePlaceholder = 'Group name (optional)', titleLabel = 'Name', onSubmit, onClose,
  // Optional: give every picked person a label (e.g. Family, Workmates). onSubmit gets {id: key} as a 3rd argument.
  labelOptions = null, defaultLabel = '', compact = false,
}) {
  const { user } = useAuth();
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState({});
  const [labels, setLabels] = useState({});
  const [groupTitle, setGroupTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [leaving, setLeaving] = useState(false);
  const searchRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const closeTimer = useRef(null);

  const hidden = useMemo(() => new Set([String(user.id), ...excludeIds.map(String)]), [user.id, excludeIds]);
  const query = q.trim();

  // animated close (works for backdrop, Escape and the X button)
  const close = useCallback(() => {
    if (closeTimer.current) return;
    setLeaving(true);
    closeTimer.current = setTimeout(() => onCloseRef.current(), 190);
  }, []);

  useEffect(() => {
    // avoid popping the keyboard open on phones before the sheet has slid in
    const t = setTimeout(() => searchRef.current?.focus({ preventScroll: true }), 250);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      clearTimeout(closeTimer.current);
      document.body.style.overflow = prevOverflow;
      document.removeEventListener('keydown', onKey);
    };
  }, [close]);

  useEffect(() => {
    if (query.length < 2) { setResults(null); return undefined; }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(() => {
      accountsApi.discoverProfiles({ q: query })
        .then((data) => { if (!cancelled) setResults((data.results ?? data).map(toPerson)); })
        .catch(() => { if (!cancelled) setResults([]); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query]);

  const list = (query.length >= 2 ? (results || []) : suggestions.map(toPerson)).filter((p) => !hidden.has(p.id));
  const pickedList = Object.values(picked);
  const count = pickedList.length;
  const full = count >= maxPick;

  const toggle = (p) => {
    setPicked((cur) => {
      const next = { ...cur };
      if (next[p.id]) delete next[p.id];
      else if (Object.keys(next).length < maxPick) next[p.id] = p;
      return next;
    });
    if (labelOptions) setLabels((cur) => (cur[p.id] ? cur : { ...cur, [p.id]: defaultLabel || labelOptions[0].key }));
  };

  const submit = async (e) => {
    e.preventDefault();
    if (count < minPick || busy) return;
    setBusy(true);
    setError(null);
    try {
      const ids = pickedList.map((p) => p.id);
      const chosen = labelOptions ? Object.fromEntries(ids.map((id) => [id, labels[id] || defaultLabel || labelOptions[0].key])) : undefined;
      await onSubmit(ids, groupTitle.trim(), chosen);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <div className={`gp-overlay pp${compact ? ' pp--compact' : ''}${leaving ? ' is-leaving' : ''}`} role="dialog" aria-modal="true" aria-label={title}
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <form className="gp-box pp-box" onSubmit={submit}>
        <span className="pp-grab" aria-hidden="true" />
        <header className="gp-head pp-head">
          <h2>{title}</h2>
          <button type="button" className="gp-x pp-x" onClick={close} aria-label="Close">×</button>
        </header>

        {askTitle && (
          <label className="pp-name">
            <span className="pp-name__lab">{titleLabel}</span>
            <input className="gp-input pp-input pp-input--name" type="text" placeholder={titlePlaceholder} aria-label={titleLabel}
              value={groupTitle} maxLength={80} onChange={(e) => setGroupTitle(e.target.value)} />
          </label>
        )}

        {count > 0 && (
          <ul className="gp-chips pp-chips" aria-label="Selected people">
            {pickedList.map((p) => (
              <li key={p.id}>
                <button type="button" className="gp-chip pp-chip" onClick={() => toggle(p)} aria-label={`Remove ${p.name}`}>
                  <span className="pp-chip__name">{p.name}</span> <span aria-hidden="true">×</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="pp-search">
          <span className="pp-search__ico" aria-hidden="true">🔍</span>
          <input ref={searchRef} className="gp-input pp-input pp-input--search" type="search" placeholder="Search people to add…" aria-label="Search people"
            value={q} onChange={(e) => setQ(e.target.value)} />
        </div>

        <ul className="gp-list pp-list">
          {searching && <li className="gp-note pp-note">Searching…</li>}
          {!searching && list.length === 0 && (
            <li className="gp-note pp-note">
              {query.length >= 2 ? 'Nobody found.' : saver ? 'Type a name to search (Data saver is on).' : 'Search for someone to add.'}
            </li>
          )}
          {list.map((p) => {
            const on = Boolean(picked[p.id]);
            return (
              <li key={p.id} className="pp-item">
                <label className={`gp-row pp-row${on ? ' is-on' : ''}${!on && full ? ' is-off' : ''}`}>
                  <input type="checkbox" checked={on} disabled={!on && full} onChange={() => toggle(p)} />
                  <span className="gp-avatar pp-avatar" aria-hidden="true">
                    {p.avatar && !saver ? <img src={p.avatar} alt="" loading="lazy" /> : p.name[0]?.toUpperCase()}
                  </span>
                  <span className="gp-who pp-who"><strong>{p.name}</strong>{p.handle && <small>@{p.handle}</small>}</span>
                  <span className="pp-tick" aria-hidden="true">{on ? '✓' : ''}</span>
                </label>
                {on && labelOptions && (
                  <div className="pp-labels" role="radiogroup" aria-label={`How do you know ${p.name}?`}>
                    {labelOptions.map((o) => (
                      <button key={o.key} type="button" role="radio" aria-checked={labels[p.id] === o.key}
                        className={`pp-lab${labels[p.id] === o.key ? ' is-on' : ''}`} style={{ '--c': o.color }}
                        onClick={() => setLabels((cur) => ({ ...cur, [p.id]: o.key }))}>
                        <span aria-hidden="true">{o.emoji}</span> {o.label}
                      </button>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        <ErrorAlert error={error} />
        <footer className="gp-foot pp-foot">
          <span className="gp-count pp-count" role="status">
            {count} picked{minPick > 1 && count < minPick ? ` · pick at least ${minPick}` : ''}{full ? ' · limit reached' : ''}
          </span>
          <button type="submit" className="btn btn--primary pp-submit" disabled={count < minPick || busy}>
            {busy ? 'Working…' : submitLabel}
          </button>
        </footer>
      </form>
    </div>
  );
}
