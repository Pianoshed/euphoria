import '../../styles/index.css';
import './discover.css';
import { usePageBackdrop } from '../../hooks/usePageBackdrop';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import * as accountsApi from '../../api/accounts';
import { useAuth } from '../../context/AuthContext';
import { ErrorAlert, ChillLoader, Spinner } from '../../components/ui';

// Where a signed-in person edits their privacy toggles (MyProfile page).
// Change this if your router mounts MyProfile somewhere else.
const PRIVACY_SETTINGS_PATH = '/profile/me';

// On phones the two notes start folded so people are one swipe away, not four.
const ROLE_FILTERS = [
  { value: '', label: 'Everyone' },
  { value: 'PROVIDER', label: 'Providers' },
  { value: 'CUSTOMER', label: 'Consumers' },
];
const ROLE_LABEL = { PROVIDER: 'Provider', CUSTOMER: 'Consumer' };

const startsOpen = () => !window.matchMedia('(max-width: 720px)').matches;

/* ------------------------------------------------------------------ */
/* Per-person "random" look. Seeded from the person's id so a card     */
/* keeps its shape between renders; "Shuffle" bumps the seed.          */
/* ------------------------------------------------------------------ */

// border-radius values that turn a box into an oblong / pebble / egg.
const SHAPES = [
  '58% 42% 63% 37% / 45% 55% 45% 55%',
  '40% 60% 55% 45% / 60% 40% 60% 40%',
  '999px',
  '30% 70% 45% 55% / 50% 30% 70% 50%',
  '70% 30% 50% 50% / 30% 60% 40% 70%',
  '50% 50% 50% 50% / 62% 62% 38% 38%',
  '46% 54% 38% 62% / 56% 44% 56% 44%',
];

const TINTS = [
  { name: 'gold', bg: 'linear-gradient(145deg, #fff0b8, #f6c945)', ring: '#c99a12' },
  { name: 'coral', bg: 'linear-gradient(145deg, #ffe3dd, #ffb9ab)', ring: '#e2394a' },
  { name: 'lilac', bg: 'linear-gradient(145deg, #ece7ff, #cbbff7)', ring: '#6a58d6' },
  { name: 'mint', bg: 'linear-gradient(145deg, #dcf7ea, #a5e3c6)', ring: '#1f9d6a' },
  { name: 'sky', bg: 'linear-gradient(145deg, #dff0ff, #a9d3f7)', ring: '#2f7fc4' },
];

const WIDTHS = [236, 272, 312, 348];
const LAYOUTS = ['row', 'row-reverse', 'stack'];

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seededRandom(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lookFor(id, shuffle) {
  const rand = seededRandom(hashString(`${id}:${shuffle}`));
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const shapeIndex = Math.floor(rand() * SHAPES.length);
  return {
    shape: SHAPES[shapeIndex],
    avatarShape: SHAPES[(shapeIndex + 3) % SHAPES.length],
    tint: pick(TINTS),
    width: pick(WIDTHS),
    layout: pick(LAYOUTS),
    rotate: (rand() * 6 - 3).toFixed(1),
    drop: Math.round(rand() * 36),
  };
}

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
  const [error, setError] = useState(null);
  const [shuffle, setShuffle] = useState(0);
  const [notesOpen] = useState(startsOpen);

  useEffect(() => {
    let cancelled = false;
    setResults(null);
    setError(null);
    accountsApi.discoverProfiles({ role: role || undefined, q })
      .then((data) => { if (!cancelled) setResults(data.results); })
      .catch((err) => { if (!cancelled) setError(err); });
    return () => { cancelled = true; };
  }, [q, role]);

  const pickRole = (value) => {
    const next = new URLSearchParams(params);
    if (value) next.set('role', value); else next.delete('role');
    setParams(next, { replace: true });
  };

  const looks = useMemo(
    () => Object.fromEntries((results || []).map((p) => [p.id, lookFor(p.id, shuffle)])),
    [results, shuffle],
  );

  const surpriseMe = () => {
    if (!results?.length) return;
    const pick = results[Math.floor(Math.random() * results.length)];
    navigate(`/profile/${pick.id}`);
  };

  return (
    <div className="page dp">
      <div className="dp-head">
        <div>
          <h1 className="dp-title">Find people</h1>
          <p className="dp-sub">Pick a face, say hi, and plan something together.</p>
        </div>
        <div className="dp-actions">
          <button type="button" className="dp-btn" onClick={() => setShuffle((s) => s + 1)} disabled={!results?.length}>
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
          className="input"
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
            <span className="dp-note__long">You decide what people see</span>
            <span className="dp-note__short">Your privacy</span>
          </summary>
          <ul>
            <li>Show your profile to everyone, only to signed-in people, or keep it private.</li>
            <li>Your online status and last seen are hidden unless you turn them on.</li>
            <li>People only see your general area. Your exact location stays with you.</li>
            <li>Choose who is allowed to start a chat with you.</li>
          </ul>
          {user && <Link className="dp-note__link" to={PRIVACY_SETTINGS_PATH}>Review your privacy settings</Link>}
        </details>
      </section>

      <ErrorAlert error={error} />
      {!results && <ChillLoader kind="people" />}
      {results?.length === 0 && <div className="empty-state"><p>No one found. Try a different name, area or filter.</p></div>}

      <div className="dp-field">
        {results?.map((p) => {
          const look = looks[p.id];
          const name = p.display_name || p.username || 'Someone';
          return (
            <Link
              key={p.id}
              to={`/profile/${p.id}`}
              className={`dp-card dp-card--${look.layout}`}
              data-size={look.width >= 348 ? 'wide' : 'small'}
              style={{
                '--shape': look.shape,
                '--avatar-shape': look.avatarShape,
                '--tint': look.tint.bg,
                '--ring': look.tint.ring,
                '--w': `${look.width}px`,
                '--rot': `${look.rotate}deg`,
                '--drop': `${look.drop}px`,
              }}
            >
              <span className="dp-avatar">
                {p.avatar
                  ? <img src={p.avatar} alt="" loading="lazy" />
                  : <span aria-hidden="true">{name[0].toUpperCase()}</span>}
                {p.online && <span className="dp-online" role="img" aria-label="Online" />}
              </span>
              <span className="dp-card__text">
                <strong className="dp-card__name">{name}</strong>
                {ROLE_LABEL[p.role] && <span className={`dp-card__role dp-card__role--${p.role.toLowerCase()}`}>{ROLE_LABEL[p.role]}</span>}
                {p.general_location && <span className="dp-card__line">{p.general_location}</span>}
                {p.availability && <span className="dp-card__line dp-card__line--soft">{p.availability}</span>}
                {p.bio && <span className="dp-card__bio">{p.bio}</span>}
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}