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
import { Icon } from '../components/icons';

const initial = (s) => (s || '?').trim().charAt(0).toUpperCase();
const ago = (iso) => {
  const m = Math.max(1, Math.round((Date.now() - new Date(iso)) / 60000));
  if (m < 60) return `${m}m`;
  return m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};
const greeting = () => {
  const h = new Date().getHours();
  if (h < 5) return 'Still up';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  if (h < 21) return 'Good evening';
  return 'Late one';
};
const ACTIVE_BOOKING = new Set(['PENDING', 'ACCEPTED', 'FUNDED', 'IN_PROGRESS']);
const SWATCH = ['gold', 'coral', 'lilac', 'mint', 'sky'];
const swatchFor = (key) => { let h = 0; String(key).split('').forEach((c) => { h = (h * 31 + c.charCodeAt(0)) >>> 0; }); return SWATCH[h % SWATCH.length]; };

const ACTIONS = [
  { to: '/square', icon: 'tree', label: 'Square', tone: 'mint' },
  { to: '/chat', icon: 'chat', label: 'Chats', tone: 'lilac', alert: 'messages' },
  { to: '/services', icon: 'ticket', label: 'Plans', tone: 'gold' },
  { to: '/providers', icon: 'compass', label: 'Find people', tone: 'sky' },
  { to: '/calls', icon: 'phone', label: 'Calls', tone: 'coral', alert: 'missedCalls' },
  { to: '/wallet', icon: 'wallet', label: 'Wallet', tone: 'gold' },
];

function Section({ title, to, cta = 'See all', children }) {
  return (
    <section className="hf-sec">
      <header className="hf-sec__head">
        <h2>{title}</h2>
        {to && <Link to={to}>{cta}<Icon name="chevron" size={14} /></Link>}
      </header>
      {children}
    </section>
  );
}

export default function HomeFeed() {
  usePageBackdrop('scene'); // same night-scene artwork as the page before login
  const { user } = useAuth();
  const alerts = useAlerts();
  const fullName = user?.display_name || user?.username || '';
  const firstName = fullName.trim().split(/\s+/)[0] || 'there';
  const hello = useMemo(greeting, []);

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
      {/* ---------- header: flat colour block, numbers that matter ---------- */}
      <header className="hf-hero">
        <div className="hf-hero__main">
          <p className="hf-hero__hello">{hello}</p>
          <h1>Hey {firstName}.<br />What&rsquo;s the move?</h1>
          <div className="hf-hero__cta">
            <Link to="/services" className="hf-btn hf-btn--ink"><Icon name="ticket" size={18} />Find a plan</Link>
            <Link to="/square" className="hf-btn hf-btn--paper"><Icon name="tree" size={18} />Open the Square</Link>
          </div>
        </div>
        <div className="hf-stats" role="group" aria-label="Today">
          <Link to="/chat" className={`hf-stat${alerts.messages > 0 ? ' is-hot' : ''}`}>
            <b>{alerts.messages || 0}</b><span>{alerts.messages === 1 ? 'New message' : 'New messages'}</span>
          </Link>
          <Link to="/calls" className={`hf-stat${alerts.missedCalls > 0 ? ' is-hot' : ''}`}>
            <b>{alerts.missedCalls || 0}</b><span>{alerts.missedCalls === 1 ? 'Missed call' : 'Missed calls'}</span>
          </Link>
          <Link to="/wallet" className="hf-stat">
            <b>{balance != null ? formatPrice(balance) : '–'}</b><span>Wallet</span>
          </Link>
        </div>
      </header>

      {/* ---------- quick actions ---------- */}
      <nav className="hf-actions" aria-label="Quick actions">
        {ACTIONS.map((a) => (
          <Link key={a.to} to={a.to} className="hf-act" data-tint={a.tone}>
            <span className="hf-act__icon" aria-hidden="true"><Icon name={a.icon} size={22} /></span>
            <span>{a.label}</span>
            {a.alert && alerts[a.alert] > 0 && <b className="nb-count">{alerts[a.alert] > 99 ? '99+' : alerts[a.alert]}</b>}
          </Link>
        ))}
      </nav>

      {/* ---------- next plan ---------- */}
      {next && (
        <Link to={`/bookings/${next.id}`} className="hf-next" data-tint={lookFor(next.id, 0).tint.name}>
          <span className="hf-next__tag">Your next plan</span>
          <span className="hf-next__text">
            <strong>{next.service_title}</strong>
            <small>with {next.provider?.username}</small>
          </span>
          <span className="hf-next__status">{String(next.status).replace(/_/g, ' ').toLowerCase()}</span>
          <Icon name="chevron" size={18} />
        </Link>
      )}

      <div className="hf-cols">
        {/* ---------- Square ---------- */}
        <Section title="On the Square" to="/square" cta="Open">
          <div className="hf-rings" aria-label="Statuses from your people">
            <Link to="/square" className="hf-ring hf-ring--add">
              <span className="hf-ring__o"><span className="hf-ring__i">{mine ? initial(fullName) : <Icon name="plus" size={22} />}</span></span>
              <small>{mine ? 'Your status' : 'Add status'}</small>
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
            <span className="hf-trees__icon" aria-hidden="true"><Icon name="tree" size={20} /></span>
            <p>
              {trees == null ? 'Loading your trees…'
                : ownTrees + taggedTrees === 0 ? 'Plant a friend tree to see your people\'s statuses.'
                  : `${ownTrees} tree${ownTrees === 1 ? '' : 's'} planted${taggedTrees ? ` · tagged in ${taggedTrees}` : ''}`}
            </p>
            <Link to="/square" className="hf-btn hf-btn--sm">{ownTrees + taggedTrees === 0 ? 'Plant one' : 'View'}</Link>
          </div>
        </Section>

        {/* ---------- chats ---------- */}
        <Section title="Chats" to="/chat" cta="Inbox">
          {chats && chats.length === 0 && <p className="hf-hint">No chats yet. Say hi to someone from <Link to="/providers">Find people</Link>.</p>}
          <ul className="hf-chats">
            {(chats || []).map((c) => {
              const name = c.is_group ? (c.title || 'Group chat') : (names[c.other_user_id] || '…');
              const unread = c.unread_count > 0;
              const last = c.last_message;
              const text = last ? (last.body === null ? 'Message deleted' : last.body || (last.attachment_type === 'audio' ? 'Voice message' : 'Photo')) : 'Nothing yet. Say hi.';
              return (
                <li key={c.id}>
                  <Link to={`/chat/${c.id}`} className={`hf-chat${unread ? ' is-unread' : ''}`}>
                    <span className="hf-av" data-tint={swatchFor(c.id)}>{c.is_group ? <Icon name="users" size={20} /> : initial(name)}</span>
                    <span className="hf-chat__text"><strong>{name}</strong><small>{text}</small></span>
                    {unread && <b className="nb-count">{c.unread_count}</b>}
                  </Link>
                </li>
              );
            })}
          </ul>
        </Section>
      </div>

      {/* ---------- thoughts ---------- */}
      {topThoughts.length > 0 && (
        <Section title="Top thoughts" to="/square" cta="Join in">
          <div className="hf-thoughts">
            {topThoughts.map((t) => (
              <Link to="/square" key={t.id} className="hf-thought">
                <p>{t.text.length > 120 ? `${t.text.slice(0, 120)}…` : t.text}</p>
                <small><b>{t.user.name}</b> · {ago(t.created_at)} · <Icon name="flame" size={13} /> {t.total || 0}</small>
              </Link>
            ))}
          </div>
        </Section>
      )}

      {/* ---------- plans ---------- */}
      <Section title="Fresh plans" to="/services" cta="Browse">
        {plans && plans.length === 0 && <p className="hf-hint">No plans posted yet. <Link to="/services/mine/new">Host the first one</Link>.</p>}
        <div className="hf-plans">
          {(plans || []).slice(0, 8).map((p) => (
            <Link key={p.id} to={`/services/${p.id}`} className="hf-plan" data-tint={lookFor(p.id, 0).tint.name}>
              <span className="hf-plan__top">
                <small>{p.category?.name}</small>
                <b>{formatPrice(p.price)}</b>
              </span>
              <strong>{p.title}</strong>
              <small className="hf-plan__host">Hosted by {p.provider?.username || 'someone'}</small>
            </Link>
          ))}
        </div>
      </Section>

      {/* ---------- mobile dock ---------- */}
      <nav className="hf-dock" aria-label="Primary">
        <NavLink to="/" end><Icon name="home" size={22} />Home</NavLink>
        <NavLink to="/square"><Icon name="tree" size={22} />Square</NavLink>
        <NavLink to="/chat">
          <Icon name="chat" size={22} />Chats
          {alerts.messages > 0 && <b className="nb-count">{alerts.messages > 99 ? '99+' : alerts.messages}</b>}
        </NavLink>
        <NavLink to="/services"><Icon name="ticket" size={22} />Plans</NavLink>
        <NavLink to="/profile/me"><Icon name="user" size={22} />Me</NavLink>
      </nav>
    </div>
  );
}
