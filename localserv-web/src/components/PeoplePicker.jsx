import { useEffect, useMemo, useRef, useState } from 'react';
import * as accountsApi from '../api/accounts';
import { useAuth } from '../context/AuthContext';
import { ErrorAlert } from './ui';
import '../pages/chat/group.css';

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
 */
export default function PeoplePicker({
  title, submitLabel, minPick = 1, maxPick = 19, excludeIds = [], suggestions = [],
  saver = false, askTitle = false, onSubmit, onClose,
}) {
  const { user } = useAuth();
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState({});
  const [groupTitle, setGroupTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const searchRef = useRef(null);

  const hidden = useMemo(() => new Set([String(user.id), ...excludeIds.map(String)]), [user.id, excludeIds]);
  const query = q.trim();

  useEffect(() => { searchRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

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
  };

  const submit = async (e) => {
    e.preventDefault();
    if (count < minPick || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(pickedList.map((p) => p.id), groupTitle.trim());
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <div className="gp-overlay" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <form className="gp-box" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <header className="gp-head">
          <h2>{title}</h2>
          <button type="button" className="gp-x" onClick={onClose} aria-label="Close">×</button>
        </header>

        {askTitle && (
          <input className="gp-input" placeholder="Group name (optional)" aria-label="Group name"
            value={groupTitle} maxLength={80} onChange={(e) => setGroupTitle(e.target.value)} />
        )}

        {count > 0 && (
          <ul className="gp-chips" aria-label="Selected people">
            {pickedList.map((p) => (
              <li key={p.id}>
                <button type="button" className="gp-chip" onClick={() => toggle(p)} aria-label={`Remove ${p.name}`}>
                  {p.name} <span aria-hidden="true">×</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <input ref={searchRef} className="gp-input" type="search" placeholder="Search people…" aria-label="Search people"
          value={q} onChange={(e) => setQ(e.target.value)} />

        <ul className="gp-list">
          {searching && <li className="gp-note">Searching…</li>}
          {!searching && list.length === 0 && (
            <li className="gp-note">
              {query.length >= 2 ? 'Nobody found.' : saver ? 'Type a name to search (Data saver is on).' : 'Search for someone to add.'}
            </li>
          )}
          {list.map((p) => {
            const on = Boolean(picked[p.id]);
            return (
              <li key={p.id}>
                <label className={`gp-row${on ? ' is-on' : ''}`}>
                  <input type="checkbox" checked={on} disabled={!on && full} onChange={() => toggle(p)} />
                  <span className="gp-avatar" aria-hidden="true">
                    {p.avatar && !saver ? <img src={p.avatar} alt="" loading="lazy" /> : p.name[0]?.toUpperCase()}
                  </span>
                  <span className="gp-who"><strong>{p.name}</strong>{p.handle && <small>@{p.handle}</small>}</span>
                </label>
              </li>
            );
          })}
        </ul>

        <ErrorAlert error={error} />
        <footer className="gp-foot">
          <span className="gp-count" role="status">
            {count} picked{minPick > 1 && count < minPick ? ` · pick at least ${minPick}` : ''}{full ? ' · limit reached' : ''}
          </span>
          <button type="submit" className="btn btn--primary" disabled={count < minPick || busy}>
            {busy ? 'Working…' : submitLabel}
          </button>
        </footer>
      </form>
    </div>
  );
}
