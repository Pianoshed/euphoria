import { useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useAlerts } from '../context/AlertsContext';
import { API_BASE } from '../api/client';
import { isStaff } from '../utils/permissions';
import { Icon } from './icons';
import { ThemeToggle } from './ThemeToggle';
import { TONE_LIST, askDeviceNotifications, getTone, isSoundOn, nextTone, playMessageSound, setSoundOn } from '../utils/notifySound';
import './sidenav.css';

const cap = (n) => (n > 99 ? '99+' : String(n));

function Avatar({ user, initial }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [user.avatar]);
  return user.avatar && !failed
    ? <img className="sn-av" src={`${API_BASE}${user.avatar}`} alt="" onError={() => setFailed(true)} />
    : <span className="sn-av" aria-hidden="true">{initial}</span>;
}

/**
 * Desktop app sidebar (>= 1100px, signed in). It replaces the top bar on every page:
 * body.has-sidenav pushes the page right and hides .navbar (see sidenav.css). Phones and
 * tablets keep the top bar + menu sheet, so nothing changes there.
 */
export default function SideNav() {
  const { user, logout } = useAuth();
  const { messages, missedCalls } = useAlerts();
  const navigate = useNavigate();
  const [soundOn, setSoundOnState] = useState(isSoundOn);
  const [tone, setToneState] = useState(getTone);

  useEffect(() => {
    if (!user) return undefined;
    document.body.classList.add('has-sidenav');
    return () => document.body.classList.remove('has-sidenav');
  }, [user]);

  if (!user) return null;

  const name = user.display_name || user.username || 'Me';
  const initial = name.charAt(0).toUpperCase();
  const toneLabel = TONE_LIST.find((t) => t.id === tone)?.label || 'Chime';

  const toggleSound = () => {
    const next = !soundOn;
    setSoundOn(next);
    setSoundOnState(next);
    if (next) { playMessageSound(); askDeviceNotifications(); }
  };
  const cycleTone = () => {
    const id = nextTone();
    setToneState(id);
    if (!soundOn) { setSoundOn(true); setSoundOnState(true); }
    playMessageSound(id);
  };
  const out = async () => { await logout(); navigate('/login'); };

  const items = [
    { to: '/', icon: 'home', label: 'Home', end: true },
    { to: '/square', icon: 'tree', label: 'Square' },
    { to: '/chat', icon: 'chat', label: 'Messages', count: messages },
    { to: '/services', icon: 'ticket', label: 'Browse plans', end: true },
    { to: '/services/mine', icon: 'hand', label: 'Hosting' },
    { to: '/bookings', icon: 'check', label: 'Your plans' },
    { to: '/calls', icon: 'phone', label: 'Call log', count: missedCalls },
    { to: '/providers', icon: 'compass', label: 'Find people' },
    { to: '/wallet', icon: 'wallet', label: 'Wallet' },
  ];
  if (isStaff(user)) items.push({ to: '/moderation', icon: 'users', label: 'Moderation' });

  return (
    <aside className="sidenav" aria-label="Main">
      <NavLink to="/" className="sn-brand">Euphoria<span>.</span></NavLink>

      <nav className="sn-links">
        {items.map((it) => (
          <NavLink key={it.to} to={it.to} end={it.end} className="sn-link">
            <span className="sn-ico"><Icon name={it.icon} size={19} /></span>
            <span className="sn-lbl">{it.label}</span>
            {it.count > 0 && <b className="nb-count">{cap(it.count)}</b>}
          </NavLink>
        ))}
      </nav>

      <div className="sn-foot">
        <NavLink to="/profile/me" className="sn-me">
          <Avatar user={user} initial={initial} />
          <span className="sn-who"><b className="truncate">{name}</b><small>View profile</small></span>
        </NavLink>
        <div className="sn-tools">
          <ThemeToggle />
          <button type="button" className="sn-tool" onClick={toggleSound} aria-pressed={soundOn} title={soundOn ? 'Sound on' : 'Sound off'} aria-label={soundOn ? 'Turn sound off' : 'Turn sound on'}>
            <Icon name={soundOn ? 'bell' : 'bellOff'} size={17} />
          </button>
          <button type="button" className="sn-tool" onClick={cycleTone} title={`Message tone: ${toneLabel} (tap to change)`} aria-label={`Message tone: ${toneLabel}. Tap to change`}>♪</button>
          <button type="button" className="sn-out" onClick={out}>Log out</button>
        </div>
      </div>
    </aside>
  );
}
