import '../styles/index.css';
import './home-feed.css';
import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useAlerts } from '../context/AlertsContext';
import * as squareApi from '../api/square';
import * as chatApi from '../api/chat';
import * as accountsApi from '../api/accounts';
import * as servicesApi from '../api/services';
import * as bookingsApi from '../api/bookings';
import * as walletApi from '../api/wallet';
import { formatPrice } from '../utils/money';
import { lookFor } from '../utils/bubbleLook';
import { usePageBackdrop } from '../hooks/usePageBackdrop';

const initial = (s) => (s || '?').trim().charAt(0).toUpperCase();
const ago = (iso) => {
  const m = Math.max(1, Math.round((Date.now() - new Date(iso)) / 60000));
  if (m < 60) return `${m}m`;
  return m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};
const greeting = () => {
  const h = new Date().getHours();
  if (h < 5) return ['Still up', '🌙'];
  if (h < 12) return ['Good morning', '☀️'];
  if (h < 17) return ['Good afternoon', '🌤️'];
  if (h < 21) return ['Good evening', '🌆'];
  return ['Late vibes', '✨'];
};
const ACTIVE_BOOKING = new Set(['PENDING', 'ACCEPTED', 'FUNDED', 'IN_PROGRESS']);

const ACTIONS = [
  { to: '/square', icon: '🌳', label: 'Square', tone: 'mint' },
  { to: '/chat', icon: '💬', label: 'Chats', tone: 'lilac', alert: 'messages' },
  { to: '/services', icon: '🎟️', label: 'Plans', tone: 'gold' },
  { to: '/providers', icon: '🧭', label: 'Find people', tone: 'sky' },
  { to: '/calls', icon: '📞', label: 'Calls', tone: 'coral', alert: 'missedCalls' },
  { to: '/wallet', icon: '👛', label: 'Wallet', tone: 'gold' },
];

function Section({ title, to, cta = 'See all', children, delay = 0 }) {
  return (
    <section className="hf-sec" style={{ '--d': delay }}>
      <header className="hf-sec__head">
        <h2>{title}</h2>
        {to && <Link to={to}>{cta} ›</Link>}
      </header>
      {children}
    </section>
  );
}

export default function HomeFeed() {
  usePageBackdrop('couples');
  const { user } = useAuth();
  const alerts = useAlerts();
  const fullName = user?.display_name || user?.username || '';
  const firstName = fullName.trim().split(/\s+/)[0] || 'there';
  const [hello, wave] = useMemo(greeting, []);

  const [statuses, setStatuses] = useState(null);
  const [thoughts, setThoughts] = useState(null);
  const [trees, setTrees] = useState(null);
  const [chats, setChats] = useState(null);
  const [names, setNames] = useState({});
  const [plans, setPlans] = useState(null);
  const [next, setNext] = useState(null);
  const [balance, setBalance] = useState(null);

  useEffect(() => {
    let off = false;
    const set = (fn) => (v) => { if (!off) fn(v); };
    squareApi.listStatuses().then(set(setStatuses)).catch(set(() => setStatuses([])));
    squareApi.listThoughts().then(set(setThoughts)).catch(set(() => setThoughts([])));
    squareApi.listTrees().then(set(setTrees)).catch(set(() => setTrees([])));
    servicesApi.listServices({}).then((d) => set(setPlans)(d.results ?? d)).catch(set(() => setPlans([])));
    walletApi.getBalance().then((b) => set(setBalance)(b.balance)).catch(() => {});
    bookingsApi.listBookings({ role: 'customer' })
      .then((d) => set(setNext)((d.results ?? d).find((b) => ACTIVE_BOOKING.has(b.status)) || null)).catch(() => {});
    chatApi.listConversations().then(async (d) => {
      const list = (d.results ?? d).slice(0, 4);
      if (off) return;
      setChats(list);
      const ids = [...new Set(list.filter((c) => !c.is_group && c.other_user_id).map((c) => c.other_user_id))];
      const got = await Promise.all(ids.map((id) => accountsApi.getPublicProfile(id).then((p) => [id, p.username || p.display_name]).catch(() => [id, null])));
      if (!off) setNames(Object.fromEntries(got));
    }).catch(set(() => setChats([])));
    return () => { off = true; };
  }, []);

  // one ring per person, newest first, unwatched before watched
  const rings = useMemo(() => {
    const seen = new Set();
    return (statuses || []).filter((s) => (seen.has(s.user.id) ? false : seen.add(s.user.id)))
      .sort((a, b) => Number(Boolean(a.seen)) - Number(Boolean(b.seen))).slice(0, 14);
  }, [statuses]);
  const mine = (statuses || []).some((s) => s.user.id === user?.id);
  const ownTrees = (trees || []).filter((t) => t.mine).length;
  const taggedTrees = (trees || []).length - ownTrees;
  const topThoughts = [...(thoughts || [])].sort((a, b) => (b.total || 0) - (a.total || 0)).slice(0, 3);
  const attention = (alerts.messages || 0) + (alerts.missedCalls || 0);

  return (
    <div className="page hf">
      {/* ---------- hero ---------- */}
      <header className="hf-hero">
        <span className="hf-float hf-float--a" aria-hidden="true">🎉</span>
        <span className="hf-float hf-float--b" aria-hidden="true">🚁</span>
        <span className="hf-float hf-float--c" aria-hidden="true">✨</span>
        <p className="hf-hero__eyebrow">{hello} {wave}</p>
        <h1>Hey {firstName}, what's the move?</h1>
        <div className="hf-hero__chips">
          {alerts.messages > 0 && <Link to="/chat" className="hf-chip hf-chip--msg">💬 {alerts.messages} new {alerts.messages === 1 ? 'message' : 'messages'}</Link>}
          {alerts.missedCalls > 0 && <Link to="/calls" className="hf-chip hf-chip--call">📵 {alerts.missedCalls} missed {alerts.missedCalls === 1 ? 'call' : 'calls'}</Link>}
          {attention === 0 && <span className="hf-chip">✅ You're all caught up</span>}
          {balance != null && <Link to="/wallet" className="hf-chip hf-chip--wallet">👛 {formatPrice(balance)}</Link>}
        </div>
        <div className="hf-hero__cta">
          <Link to="/services" className="hf-btn hf-btn--solid">🎟️ Find a plan</Link>
          <Link to="/square" className="hf-btn">🌳 Open the Square</Link>
        </div>
      </header>

      {/* ---------- quick actions ---------- */}
      <nav className="hf-actions" aria-label="Quick actions">
        {ACTIONS.map((a) => (
          <Link key={a.to} to={a.to} className={`hf-act hf-act--${a.tone}`}>
            <span className="hf-act__icon" aria-hidden="true">{a.icon}</span>
            <span>{a.label}</span>
            {a.alert && alerts[a.alert] > 0 && <b className="nb-count">{alerts[a.alert] > 99 ? '99+' : alerts[a.alert]}</b>}
          </Link>
        ))}
      </nav>

      {/* ---------- next plan ---------- */}
      {next && (
        <Link to={`/bookings/${next.id}`} className="hf-next" style={{ '--tint': lookFor(next.id, 0).tint.bg, '--ring': lookFor(next.id, 0).tint.ring }}>
          <span className="hf-next__pulse" aria-hidden="true" />
          <span className="hf-next__text">
            <small>Your next plan</small>
            <strong>{next.service_title}</strong>
            <small>with {next.provider?.username} · {String(next.status).replace(/_/g, ' ').toLowerCase()}</small>
          </span>
          <span aria-hidden="true">›</span>
        </Link>
      )}

      {/* ---------- Square: stories ---------- */}
      <Section title="🌳 On the Square" to="/square" cta="Open" delay={1}>
        <div className="hf-rings" aria-label="Statuses from your people">
          <Link to="/square" className="hf-ring hf-ring--add">
            <span className="hf-ring__o"><span className="hf-ring__i">{mine ? initial(fullName) : '＋'}</span></span>
            <small>{mine ? 'Your vibe' : 'Add status'}</small>
          </Link>
          {rings.map((s) => (
            <Link key={s.user.id} to="/square" className={`hf-ring${s.seen ? ' is-seen' : ''}`}>
              <span className="hf-ring__o"><span className="hf-ring__i">{initial(s.user.name)}</span></span>
              <small>{s.user.id === user?.id ? 'You' : s.user.name}</small>
            </Link>
          ))}
          {statuses && rings.length === 0 && <p className="hf-hint">No statuses yet. Be the first to drop one.</p>}
        </div>

        <div className="hf-trees">
          <span aria-hidden="true">🌳</span>
          <p>
            {trees == null ? 'Loading your trees…'
              : ownTrees + taggedTrees === 0 ? 'Plant a friend tree to see your people\'s statuses.'
                : `${ownTrees} tree${ownTrees === 1 ? '' : 's'} planted${taggedTrees ? ` · tagged in ${taggedTrees}` : ''}`}
          </p>
          <Link to="/square" className="hf-btn hf-btn--sm">{ownTrees + taggedTrees === 0 ? 'Plant one' : 'View'}</Link>
        </div>
      </Section>

      {/* ---------- chats ---------- */}
      <Section title="💬 Chats" to="/chat" cta="Inbox" delay={2}>
        {chats && chats.length === 0 && <p className="hf-hint">No chats yet. Say hi to someone from <Link to="/providers">Find people</Link>.</p>}
        <ul className="hf-chats">
          {(chats || []).map((c) => {
            const name = c.is_group ? (c.title || 'Group chat') : (names[c.other_user_id] || '…');
            const unread = c.unread_count > 0;
            const last = c.last_message;
            const text = last ? (last.body === null ? 'Message deleted' : last.body || (last.attachment_type === 'audio' ? '🎤 Voice message' : '📷 Photo')) : 'Nothing yet. Say hi 👋';
            return (
              <li key={c.id}>
                <Link to={`/chat/${c.id}`} className={`hf-chat${unread ? ' is-unread' : ''}`}>
                  <span className="hf-av">{c.is_group ? '👥' : initial(name)}</span>
                  <span className="hf-chat__text"><strong>{name}</strong><small>{text}</small></span>
                  {unread && <b className="nb-count">{c.unread_count}</b>}
                </Link>
              </li>
            );
          })}
        </ul>
      </Section>

      {/* ---------- thoughts ---------- */}
      {topThoughts.length > 0 && (
        <Section title="💭 Top thoughts" to="/square" cta="Join in" delay={3}>
          <div className="hf-thoughts">
            {topThoughts.map((t) => (
              <Link to="/square" key={t.id} className="hf-thought">
                <p>{t.text.length > 120 ? `${t.text.slice(0, 120)}…` : t.text}</p>
                <small><b>{t.user.name}</b> · {ago(t.created_at)} · 🔥 {t.total || 0}</small>
              </Link>
            ))}
          </div>
        </Section>
      )}

      {/* ---------- plans ---------- */}
      <Section title="🎟️ Fresh plans" to="/services" cta="Browse" delay={4}>
        {plans && plans.length === 0 && <p className="hf-hint">No plans posted yet. <Link to="/services/mine/new">Host the first one</Link>.</p>}
        <div className="hf-plans">
          {(plans || []).slice(0, 8).map((p) => {
            const look = lookFor(p.id, 0);
            return (
              <Link key={p.id} to={`/services/${p.id}`} className="hf-plan" style={{ '--tint': look.tint.bg, '--ring': look.tint.ring }}>
                <span className="hf-plan__top">
                  <small>{p.category?.icon} {p.category?.name}</small>
                  <b>{formatPrice(p.price)}</b>
                </span>
                <strong>{p.title}</strong>
                <small>Hosted by {p.provider?.username || 'someone'}</small>
              </Link>
            );
          })}
        </div>
      </Section>

      {/* ---------- mobile dock ---------- */}
      <nav className="hf-dock" aria-label="Primary">
        <NavLink to="/" end><span aria-hidden="true">🏠</span>Home</NavLink>
        <NavLink to="/square"><span aria-hidden="true">🌳</span>Square</NavLink>
        <NavLink to="/chat" className="hf-dock__mid">
          <span aria-hidden="true">💬</span>Chats
          {alerts.messages > 0 && <b className="nb-count">{alerts.messages > 99 ? '99+' : alerts.messages}</b>}
        </NavLink>
        <NavLink to="/services"><span aria-hidden="true">🎟️</span>Plans</NavLink>
        <NavLink to="/profile/me"><span aria-hidden="true">🙂</span>Me</NavLink>
      </nav>
    </div>
  );
}
