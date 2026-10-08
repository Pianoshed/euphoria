import '../styles/index.css';
import { useState, useEffect } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { API_BASE } from '../api/client';
import { isStaff } from '../utils/permissions';
import { usePresenceHeartbeat } from '../hooks/usePresenceHeartbeat';
import { isSoundOn, playMessageSound, setSoundOn } from '../utils/notifySound';
import { MenuIcon, CloseIcon } from './icons';

// Shows the initial if the photo file is missing (e.g. media wiped by a redeploy).
function NavAvatar({ user, initial }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [user.avatar]);
  return user.avatar && !failed
    ? <img className="avatar avatar--sm" src={`${API_BASE}${user.avatar}`} alt="" onError={() => setFailed(true)} />
    : <span className="avatar avatar--sm" aria-hidden="true">{initial}</span>;
}

// Keep in step with the breakpoint in components.css (.navbar mobile sheet).
const DESKTOP_QUERY = '(min-width: 1100px)';

export function NavBar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [soundOn, setSoundOnState] = useState(isSoundOn);

  usePresenceHeartbeat();

  const closeMenu = () => setMenuOpen(false);

  const toggleSound = () => {
    const next = !soundOn;
    setSoundOn(next);
    setSoundOnState(next);
    if (next) playMessageSound(); // a click is a gesture, so this also unlocks audio and previews the beep
  };

  const handleLogout = async () => {
    closeMenu();
    await logout();
    navigate('/login');
  };

  // While the sheet is open: lock page scroll, let Escape close it, and close it if the
  // window grows to desktop width (otherwise the scroll lock would be stranded on).
  useEffect(() => {
    if (!menuOpen) return undefined;
    document.body.style.overflow = 'hidden';
    const onKey = (e) => e.key === 'Escape' && closeMenu();
    const media = window.matchMedia(DESKTOP_QUERY);
    const onChange = (e) => e.matches && closeMenu();
    window.addEventListener('keydown', onKey);
    media.addEventListener('change', onChange);
    return () => {
      document.body.style.overflow = '';
      window.removeEventListener('keydown', onKey);
      media.removeEventListener('change', onChange);
    };
  }, [menuOpen]);

  // one short name keeps the menu footer uncramped
  const shortName = ((user?.display_name || user?.username || '').trim().split(/\s+/)[0]) || 'Me';
  const initial = (user?.display_name || user?.username || '?').charAt(0).toUpperCase();

  return (
    <header className="navbar">
      <div className="navbar__inner">
        <NavLink to="/" className="navbar__brand" onClick={closeMenu}>Euphoria</NavLink>

        {user ? (
          <>
            <button
              type="button"
              className="navbar__toggle"
              aria-expanded={menuOpen}
              aria-controls="primary-nav"
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              onClick={() => setMenuOpen((open) => !open)}
            >
              {menuOpen ? <CloseIcon /> : <MenuIcon />}
            </button>

            {/* Backdrop: tap to close, sits behind the sheet */}
            <div
              className={`navbar__backdrop${menuOpen ? ' navbar__backdrop--open' : ''}`}
              onClick={closeMenu}
              aria-hidden="true"
            />

            <nav id="primary-nav" aria-label="Main" className={`navbar__links${menuOpen ? ' navbar__links--open' : ''}`}>
              {/* `end` stops "Browse" staying highlighted on /services/mine */}
              <NavLink to="/services" end onClick={closeMenu}>Browse</NavLink>
              <NavLink to="/services/mine" onClick={closeMenu}>Things you're hosting</NavLink>
              <NavLink to="/bookings" onClick={closeMenu}>Your plans</NavLink>
              <NavLink to="/chat" onClick={closeMenu}>Messages</NavLink>
              <NavLink to="/calls" onClick={closeMenu}>Call log</NavLink>
              <NavLink to="/wallet" onClick={closeMenu}>Wallet</NavLink>
              <NavLink to="/providers" onClick={closeMenu}>Find people</NavLink>
              <NavLink to="/square" onClick={closeMenu}>Square</NavLink>
              {isStaff(user) && <NavLink to="/moderation" onClick={closeMenu}>Moderation</NavLink>}

              <div className="navbar__user navbar__user--menu">
                <NavLink to="/profile/me" className="navbar__me" onClick={closeMenu}>
                  <NavAvatar user={user} initial={initial} />
                  <span className="navbar__who">
                    <b className="truncate">{shortName}</b>
                    <small>View profile</small>
                  </span>
                  <span className="navbar__chev" aria-hidden="true">›</span>
                </NavLink>
                <div className="navbar__acts">
                  <button
                    type="button"
                    className="navbar__act"
                    onClick={toggleSound}
                    aria-pressed={soundOn}
                    title="Beep when a new message arrives"
                  >
                    <span aria-hidden="true">{soundOn ? '\u{1F514}' : '\u{1F515}'}</span> {soundOn ? 'Sound on' : 'Sound off'}
                  </button>
                  <button type="button" className="navbar__act navbar__act--out" onClick={handleLogout}>Log out</button>
                </div>
              </div>
            </nav>
          </>
        ) : (
          <div className="navbar__user">
            <NavLink to="/login" className="btn btn--ghost btn--sm">Log in</NavLink>
            <NavLink to="/register" className="btn btn--primary btn--sm">Sign up</NavLink>
          </div>
        )}
      </div>
    </header>
  );
}
