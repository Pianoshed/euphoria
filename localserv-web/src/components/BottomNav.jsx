import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useAlerts } from '../context/AlertsContext';
import { Icon } from './icons';
import './bottom-nav.css';

/**
 * The phone/tablet tab bar from the home page, now on every signed-in page (< 1000px).
 * Desktop uses SideNav / the top bar instead, so this is hidden there by CSS.
 *
 * It steps aside where it would be in the way: inside an open conversation (the message box
 * lives at the bottom) and while a text field is focused (the keyboard is up).
 */
const TABS = [
  { to: '/', icon: 'home', label: 'Home', on: (p) => p === '/' },
  { to: '/square', icon: 'tree', label: 'Square', on: (p) => p.startsWith('/square') },
  { to: '/chat', icon: 'chat', label: 'Chats', alert: 'messages', on: (p) => p.startsWith('/chat') || p.startsWith('/calls') },
  { to: '/services', icon: 'ticket', label: 'Plans', on: (p) => p.startsWith('/services') || p.startsWith('/bookings') },
  { to: '/profile/me', icon: 'user', label: 'Me', on: (p) => p.startsWith('/profile') || p.startsWith('/wallet') || p.startsWith('/moderation') },
];

const OPEN_CONVERSATION = /^\/chat\/(?!join\/)[^/]+\/?$/;
const isField = (el) => el && (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable
  || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'range', 'file', 'color'].includes(el.type)));

export default function BottomNav() {
  const { user } = useAuth();
  const alerts = useAlerts();
  const { pathname } = useLocation();
  const [typing, setTyping] = useState(false);

  const show = Boolean(user) && !OPEN_CONVERSATION.test(pathname);

  useEffect(() => {
    if (!show) return undefined;
    document.body.classList.add('has-bottomnav');
    const onIn = (e) => isField(e.target) && setTyping(true);
    const onOut = () => setTyping(false);
    document.addEventListener('focusin', onIn);
    document.addEventListener('focusout', onOut);
    return () => {
      document.body.classList.remove('has-bottomnav');
      document.removeEventListener('focusin', onIn);
      document.removeEventListener('focusout', onOut);
    };
  }, [show]);

  if (!show) return null;

  return (
    <nav className={`bn${typing ? ' bn--hidden' : ''}`} aria-label="Primary">
      {TABS.map((t) => {
        const n = t.alert ? alerts[t.alert] : 0;
        return (
          <Link key={t.to} to={t.to} className={t.on(pathname) ? 'active' : undefined} aria-current={t.on(pathname) ? 'page' : undefined}>
            <Icon name={t.icon} size={22} /><span>{t.label}</span>
            {n > 0 && <b className="nb-count">{n > 99 ? '99+' : n}</b>}
          </Link>
        );
      })}
    </nav>
  );
}
