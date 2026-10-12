import '../../styles/index.css';
import './discover.css';
import { usePageBackdrop } from '../../hooks/usePageBackdrop';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import * as accountsApi from '../../api/accounts';
import * as chatApi from '../../api/chat';
import { ROLE_META } from '../../utils/roles';
import { lookFor } from '../../utils/bubbleLook';
import '../../components/age-glow.css';
import { ageGlowProps } from '../../utils/ageGroups';
import { useAuth } from '../../context/AuthContext';
import { ErrorAlert, ChillLoader, Spinner } from '../../components/ui';

// Where a signed-in person edits their privacy toggles (MyProfile page).
// Change this if your router mounts MyProfile somewhere else.
const PRIVACY_SETTINGS_PATH = '/profile/me';

// On phones the two notes start folded so people are one swipe away, not four.
const ROLE_FILTERS = [
  { value: '', label: 'Everyone' },
  { value: 'PROVIDER', label: ROLE_META.PROVIDER.plural },
  { value: 'CUSTOMER', label: ROLE_META.CUSTOMER.plural },
];

// Bubbles per page. The server decides the real size (DRF PAGE_SIZE); this is only a request hint.
const pageSizeNow = () => (window.matchMedia('(max-width: 720px)').matches ? 12 : 24);
// One random order per visit: every page of a visit follows the same order (no repeats between pages),
// and a new visit or "Shuffle" gives a different order, so different people get seen by different visitors.
const newSeed = () => Math.random().toString(36).slice(2, 10);
const startsOpen = () => !window.matchMedia('(max-width: 720px)').matches;

/* ------------------------------------------------------------------ */
/* Per-person "random" look. Seeded from the person's id so a card     */
/* keeps its shape between renders; "Shuffle" bumps the seed.          */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function Discover() {
  usePageBackdrop('couples');
  const navigate = useNavigate();
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') || '';
  // Everyone by default. "Providers" and "Consumers" narrow it down; both kinds of people are findable.
  const roleParam = params.get('role');
  const role = ROLE_FILTERS.some((f) => f.value === roleParam) ? roleParam : '';
  const [results, setResults] = useState(null);
  const [hasNext, setHasNext] = useState(false);
  const [total, setTotal] = useState(null);
  const [error, setError] = useState(null);
  const [shuffle, setShuffle] = useState(0);
  const [seed, setSeed] = useState(newSeed);
  const [notesOpen] = useState(startsOpen);
  const [pageSize] = useState(pageSizeNow);
  // Typing waits 300 ms before asking the server, so a million-row search isn't hit on every keystroke.
  const [dq, setDq] = useState(q);
  useEffect(() => {
    const t = setTimeout(() => setDq(q), 300);
    return () => clearTimeout(t);
  }, [q]);
  // The page number belongs to one search+filter+shuffle; changing any of them starts again at page 1.
  const queryKey = `${dq}|${role}|${seed}`;
  const [pageState, setPageState] = useState({ key: queryKey, page: 1 });
  const page = pageState.key === queryKey ? pageState.page : 1;
  const setPage = (n) => setPageState({ key: queryKey, page: n });
  const [openId, setOpenId] = useState(null);
  const [messaging, setMessaging] = useState(false);
  const [popupError, setPopupError] = useState(null);
  const lastTrigger = useRef(null);
  const closeRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setResults(null);
    setError(null);
    accountsApi.discoverProfiles({
      role: role || undefined,
      q: dq || undefined,
      page,
      page_size: pageSize,
      ordering: 'random',
      seed,
    })
      .then((data) => {
        if (cancelled) return;
        const list = Array.isArray(data) ? data : (data.results || []);
        setResults(list);
        setHasNext(Array.isArray(data) ? false : Boolean(data.next));
        setTotal(Array.isArray(data) ? list.length : (data.count ?? null));
      })
      .catch((err) => { if (!cancelled) setError(err); });
    return () => { cancelled = true; };
  }, [dq, role, page, seed, pageSize]);

  const pickRole = (value) => {
    const next = new URLSearchParams(params);
    if (value) next.set('role', value); else next.delete('role');
    setParams(next, { replace: true });
  };

  // The server already sends exactly one page, so there is nothing to slice here.
  const shownPeople = results || [];
  const goPage = (n) => { setPage(n); window.scrollTo({ top: 0, behavior: 'smooth' }); };

  const looks = useMemo(
    () => Object.fromEntries((results || []).map((p) => [p.id, lookFor(p.id, shuffle)])),
    [results, shuffle],
  );

  const openPerson = (id, el) => {
    lastTrigger.current = el;
    setPopupError(null);
    setOpenId(id);
  };
  const closePerson = () => {
    setOpenId(null);
    lastTrigger.current?.focus?.();
  };

  // Esc closes the popup; the page behind it doesn't scroll while it is open.
  useEffect(() => {
    if (!openId) return undefined;
    closeRef.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape') closePerson(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [openId]); // eslint-disable-line react-hooks/exhaustive-deps

  const sayHi = async (person) => {
    setMessaging(true);
    setPopupError(null);
    try {
      const conversation = await chatApi.startConversation(person.id);
      navigate(`/chat/${conversation.id}`);
    } catch (err) {
      setPopupError(err);
    } finally {
      setMessaging(false);
    }
  };

  const surpriseMe = () => {
    if (!results?.length) return;
    const pick = results[Math.floor(Math.random() * results.length)];
    navigate(`/profile/${pick.id}`);
  };

  const active = useMemo(() => {
    const p = results?.find((r) => r.id === openId);
    return p ? { p, name: p.display_name || p.username || 'Someone', look: looks[p.id] } : null;
  }, [results, openId, looks]);

  return (
    <div className="page dp">
      <header className="dp-hero">
      <div className="dp-head">
        <div>
          <h1 className="dp-title">Find people</h1>
          <p className="dp-sub">Pick a face, say hi, and plan something together.</p>
        </div>
        <div className="dp-actions">
          <button type="button" className="dp-btn" onClick={() => { setShuffle((n) => n + 1); setSeed(newSeed()); }} disabled={!results?.length}>
            Shuffle
          </button>
          <button type="button" className="dp-btn dp-btn--solid" onClick={surpriseMe} disabled={!results?.length}>
            Surprise me
          </button>
        </div>
      </div>

      <div className="e-browse-filters">
        <input
          type="search"
          className="input dp-search"
          aria-label="Search by name or area"
          placeholder="Search by name or area…"
          enterKeyHint="search"
          defaultValue={q}
          onChange={(e) => {
            const next = new URLSearchParams(params);
            if (e.target.value) next.set('q', e.target.value); else next.delete('q');
            setParams(next, { replace: true });
          }}
        />
        <div className="e-chip-row" role="group" aria-label="Who to show">
          {ROLE_FILTERS.map((f) => (
            <button
              key={f.value || 'all'}
              type="button"
              className={role === f.value ? 'active' : ''}
              aria-pressed={role === f.value}
              onClick={() => pickRole(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>
      </header>

      <section className="dp-notes" aria-label="Chat safety and privacy">
        <details className="dp-note dp-note--safety" open={notesOpen}>
          <summary>
            <span aria-hidden="true">🛡️</span>{' '}
            <span className="dp-note__long">Keeping chats respectful</span>
            <span className="dp-note__short">Chat safety</span>
          </summary>
          <ul>
            <li>Block anyone from their profile. You stop seeing each other in search.</li>
            <li>Report people or plans for spam, harassment, scams, impersonation or prohibited content. Our moderation team looks at every report.</li>
            <li>Accounts that break the rules can be suspended or banned.</li>
            <li>Never share your password or a login code in chat. Nobody here will ask for one.</li>
          </ul>
        </details>

        <details className="dp-note dp-note--privacy" open={notesOpen}>
          <summary>
            <span aria-hidden="true">🔒</span>{' '}
            <span className="dp-note__long">Your privacy comes first</span>
            <span className="dp-note__short">Your privacy</span>
          </summary>
          <ul>
            <li>Your messages are encrypted on the way and stored encrypted on our servers.</li>
            <li>We don't use your chats or profile for analytics or advertising, and we never sell your data.</li>
            <li>Show your profile to everyone, only to signed-in people, or keep it private.</li>
            <li>Your online status and last seen are hidden unless you turn them on.</li>
            <li>People only see your general area. Your exact location stays with you.</li>
            <li>Choose who is allowed to start a chat with you.</li>
          </ul>
          {user && <Link className="dp-note__link" to={PRIVACY_SETTINGS_PATH}>Review your privacy settings</Link>}
        </details>
      </section>

      <ErrorAlert error={error} onRetry={() => window.location.reload()} />
      {!results && <ChillLoader kind="people" />}
      {results?.length === 0 && <div className="empty-state"><p>No one found. Try a different name, area or filter.</p></div>}

      {results?.length > 0 && (
        <p className="dp-count">
          {total != null ? `${total.toLocaleString()} ${total === 1 ? 'person' : 'people'}` : `Showing ${results.length} people`}
        </p>
      )}
      <div className="dp-field">
        {shownPeople.map((p) => {
          const look = looks[p.id];
          const name = p.display_name || p.username || 'Someone';
          const meta = ROLE_META[p.role];
          return (
            <button
              key={p.id}
              type="button"
              className="dp-card"
              aria-haspopup="dialog"
              {...ageGlowProps(p.age_range)}
              onClick={(e) => openPerson(p.id, e.currentTarget)}
              style={{
                '--shape': look.shape,
                '--avatar-shape': look.avatarShape,
                '--tint': look.tint.bg,
                '--ring': look.tint.ring,
                '--rot': `${look.rotate}deg`,
              }}
            >
              <Avatar person={p} name={name} />
              <strong className="dp-card__name">{name}</strong>
              {meta && <span className={`dp-card__role dp-card__role--${p.role.toLowerCase()}`}>{meta.label}</span>}
            </button>
          );
        })}
      </div>

      {(page > 1 || hasNext) && (
        <nav className="dp-pager" aria-label="More people">
          <button type="button" className="dp-pager__btn" disabled={page === 1} onClick={() => goPage(page - 1)} aria-label="Previous page">‹</button>
          <span className="dp-pager__txt" role="status">Page {page}</span>
          <button type="button" className="dp-pager__btn" disabled={!hasNext} onClick={() => goPage(page + 1)} aria-label="Next page">›</button>
        </nav>
      )}

      {active && (
        <div className="dp-pop" onClick={closePerson}>
          <div
            className="dp-pop__card"
            role="dialog"
            aria-modal="true"
            aria-label={`${active.name}'s card`}
            {...ageGlowProps(active.p.age_range)}
            onClick={(e) => e.stopPropagation()}
            style={{ '--tint': active.look.tint.bg, '--ring': active.look.tint.ring, '--avatar-shape': active.look.avatarShape }}
          >
            <button ref={closeRef} type="button" className="dp-pop__close" aria-label="Close" onClick={closePerson}>×</button>
            <Avatar person={active.p} name={active.name} large />
            <h2 className="dp-pop__name">{active.name}</h2>
            {ROLE_META[active.p.role] && (
              <p className="dp-pop__role">
                {ROLE_META[active.p.role].label} · {ROLE_META[active.p.role].blurb}
              </p>
            )}
            {active.p.general_location && <p className="dp-pop__line">📍 {active.p.general_location}</p>}
            {active.p.availability && <p className="dp-pop__line">🕒 {active.p.availability}</p>}
            {active.p.bio && <p className="dp-pop__bio">{active.p.bio}</p>}
            <ErrorAlert error={popupError} />
            <div className="dp-pop__actions">
              <Link className="dp-btn" to={`/profile/${active.p.id}`}>View profile</Link>
              {active.p.id !== user?.id && (
                <button type="button" className="dp-btn dp-btn--solid" disabled={messaging} onClick={() => sayHi(active.p)}>
                  {messaging ? <Spinner /> : '👋 Say hi'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Avatar({ person, name, large = false }) {
  return (
    <span className={`dp-avatar${large ? ' dp-avatar--lg' : ''}`}>
      {person.avatar
        ? <img src={person.avatar} alt="" loading="lazy" />
        : <span aria-hidden="true">{name[0].toUpperCase()}</span>}
      {person.online && <span className="dp-online" role="img" aria-label="Online" />}
    </span>
  );
}
