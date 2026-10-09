import '../../styles/index.css';
import './myprofile.css';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import * as accountsApi from '../../api/accounts';
import { API_BASE } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { ErrorAlert, Spinner } from '../../components/ui';
import PasswordPanel from './PasswordPanel';
import Modal from '../../components/Modal';
import { useAlerts } from '../../context/AlertsContext';

/* ------------------------------------------------------------------ */
/* Static content                                                      */
/* ------------------------------------------------------------------ */

// Sidebar shortcuts. `alert` names a live count from the header alerts.
const GO_LINKS = [
  { to: '/providers', icon: '🧭', title: 'Find people' },
  { to: '/services', icon: '🎟️', title: 'Browse plans' },
  { to: '/services/mine', icon: '🎉', title: 'Your plans' },
  { to: '/bookings', icon: '📅', title: 'Bookings' },
  { to: '/chat', icon: '💬', title: 'Messages', alert: 'messages' },
  { to: '/calls', icon: '📞', title: 'Call log', alert: 'missedCalls' },
  { to: '/wallet', icon: '👛', title: 'Wallet' },
  { to: '/profile/blocked', icon: '🚫', title: 'Blocked people' },
];

const PLAN_STEPS = [
  { title: 'Ask to join', text: 'Open a plan and send a request, with a note if you like.' },
  { title: 'Host says yes', text: 'The host accepts or declines your request.' },
  { title: 'You pay', text: 'Your payment is held safely until the plan is done.' },
  { title: 'Plan happens', text: 'The host starts it and marks it as done.' },
  { title: 'You release', text: 'Release the money to the host, or raise a dispute. Then leave a review.' },
];

const VISIBILITY_OPTIONS = [
  { value: 'PUBLIC', title: 'Anyone', text: 'Even people who are not signed in can find you.' },
  { value: 'REGISTERED_USERS', title: 'Signed-in people', text: 'Only people with an account can see you.' },
  { value: 'PRIVATE', title: 'Only me', text: 'You are hidden from search and other profiles.' },
];

const MESSAGE_OPTIONS = [
  { value: 'EVERYONE', label: 'Everyone' },
  { value: 'NOBODY', label: 'Nobody' },
];

const PROFILE_FIELDS = [
  { key: 'avatar', label: 'a profile photo' },
  { key: 'display_name', label: 'a display name' },
  { key: 'bio', label: 'a short bio' },
  { key: 'general_location', label: 'your general location' },
  { key: 'availability', label: 'when you are free' },
];

/* ------------------------------------------------------------------ */
/* Small pieces                                                        */
/* ------------------------------------------------------------------ */

// Falls back to the initial letter when the image file is gone (e.g. wiped media disk).
function Avatar({ user, className = '' }) {
  const [failed, setFailed] = useState(false);

  // A new upload gets a new URL, so give it a fresh chance to load.
  useEffect(() => { setFailed(false); }, [user.avatar]);

  const name = user.display_name || user.username || '?';
  return user.avatar && !failed
    ? (
      <img className={`mp-avatar ${className}`} src={`${API_BASE}${user.avatar}`} alt=""
        onError={() => setFailed(true)} />
    )
    : <span className={`mp-avatar ${className}`} aria-hidden="true">{name[0].toUpperCase()}</span>;
}

function Switch({ id, title, text, checked, disabled, onChange }) {
  return (
    <label className="mp-switch" htmlFor={id}>
      <span className="mp-switch__text">
        <strong>{title}</strong>
        <small>{text}</small>
      </span>
      <input id={id} type="checkbox" role="switch" checked={checked} disabled={disabled}
        onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

function StatusChip({ tone, children }) {
  return <span className={`mp-chip mp-chip--${tone}`}>{children}</span>;
}

/* What other signed-in people see, updated live as the form and toggles change. */
function ProfilePreview({ user, form, privacy }) {
  const name = form.display_name || user.username;
  const hidden = privacy.profile_visibility === 'PRIVATE';
  const draft = { ...user, display_name: form.display_name };

  return (
    <figure className={`mp-preview${hidden ? ' mp-preview--hidden' : ''}`}>
      <figcaption className="mp-preview__cap">
        {hidden ? 'Hidden from everyone but you' : 'How others see you'}
      </figcaption>
      <div className="mp-preview__card" aria-hidden={hidden}>
        <span className="mp-preview__avatar">
          <Avatar user={draft} />
          {privacy.show_online_status && <span className="mp-preview__online" />}
        </span>
        <span className="mp-preview__text">
          <strong>{name}</strong>
          {form.general_location && <span>{form.general_location}</span>}
          {form.availability && <span className="soft">{form.availability}</span>}
          {privacy.show_online_status && <span className="live">Online now</span>}
          {!privacy.show_online_status && privacy.show_last_seen && <span className="soft">Last seen recently</span>}
          {form.bio && <span className="bio">{form.bio}</span>}
        </span>
      </div>
      <ul className="mp-preview__notes">
        {privacy.profile_visibility === 'PUBLIC' && <li>Visible to anyone, including visitors who are not signed in.</li>}
        {privacy.profile_visibility === 'REGISTERED_USERS' && <li>Visible to signed-in people only.</li>}
        {hidden && <li>You will not appear in "Find people".</li>}
        {privacy.who_can_message === 'NOBODY' && <li>No one can start a new chat with you.</li>}
        {!privacy.show_online_status && !privacy.show_last_seen && <li>Your activity is hidden.</li>}
      </ul>
    </figure>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function MyProfile() {
  const { user, refreshSession } = useAuth();
  const [form, setForm] = useState(null);
  const [privacy, setPrivacy] = useState(null);
  const [error, setError] = useState(null);
  const [savedMessage, setSavedMessage] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingPrivacy, setSavingPrivacy] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [modal, setModal] = useState(null);      // 'details' | 'privacy' | 'security' | 'plans'
  const [sideOpen, setSideOpen] = useState(false); // phone drawer
  const alerts = useAlerts();

  useEffect(() => {
    if (user) {
      setForm({
        display_name: user.display_name || '', bio: user.bio || '',
        general_location: user.general_location || '', availability: user.availability || '',
      });
    }
  }, [user]);

  useEffect(() => {
    accountsApi.getMyPrivacy().then(setPrivacy).catch(setError);
  }, []);

  // Links like /profile/me#password open the right panel.
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (!form || !hash) return;
    const map = { details: 'details', privacy: 'privacy', security: 'security', password: 'security', plans: 'plans' };
    if (map[hash]) setModal(map[hash]);
  }, [form]);

  const openModal = (name) => { setModal(name); setSideOpen(false); };
  const closeModal = () => {
    setModal(null);
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname + window.location.search);
  };

  // phone drawer: Escape closes it and page scroll is locked while it is open
  useEffect(() => {
    if (!sideOpen) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const key = (e) => { if (e.key === 'Escape') setSideOpen(false); };
    window.addEventListener('keydown', key);
    return () => { document.body.style.overflow = prev; window.removeEventListener('keydown', key); };
  }, [sideOpen]);

  const handleProfileSubmit = async (e) => {
    e.preventDefault();
    setSavingProfile(true);
    setError(null);
    setSavedMessage('');
    try {
      await accountsApi.updateMyProfile(form);
      await refreshSession();
      setSavedMessage('Profile updated.');
      closeModal();
    } catch (err) {
      setError(err);
    } finally {
      setSavingProfile(false);
    }
  };

  const handlePrivacyChange = async (key, value) => {
    setSavingPrivacy(true);
    setError(null);
    try {
      const updated = await accountsApi.updateMyPrivacy({ [key]: value });
      setPrivacy(updated);
    } catch (err) {
      setError(err);
    } finally {
      setSavingPrivacy(false);
    }
  };

  const handleAvatarChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingAvatar(true);
    setError(null);
    try {
      await accountsApi.uploadAvatar(file);
      await refreshSession();
    } catch (err) {
      setError(err);
    } finally {
      setUploadingAvatar(false);
    }
  };

  // The session can expire (idle timeout / browser closed), leaving user null.
  // All hooks are above, so this early return is safe. The route guard / API client
  // should redirect to /login; this just prevents a crash while that happens.
  if (!user) return null;

  if (error && !privacy) return (
    <div className="page page--narrow">
      <h1>My profile</h1>
      <ErrorAlert error={error} onRetry={() => window.location.reload()} />
    </div>
  );

  if (!form || !privacy) return <div className="page"><Spinner /></div>;

  const name = user.display_name || user.username;
  const isStaff = Boolean(user.is_staff) || ['MODERATOR', 'ADMIN'].includes(user.role);

  const missing = PROFILE_FIELDS.filter((f) => !user[f.key]);
  const percent = Math.round(((PROFILE_FIELDS.length - missing.length) / PROFILE_FIELDS.length) * 100);

  const requestsSetting = privacy.who_can_send_service_requests ?? 'EVERYONE';

  const checkup = [
    {
      id: 'visibility',
      tone: privacy.profile_visibility === 'PUBLIC' ? 'review' : 'good',
      status: privacy.profile_visibility === 'PUBLIC' ? 'Worth a look' : 'Looks good',
      title: 'Who can find you',
      text: privacy.profile_visibility === 'PUBLIC'
        ? 'Your profile is open to anyone on the internet. If you only want people on the site to see it, switch to "Signed-in people".'
        : 'Your profile is limited to people you would expect. You can change this any time above.',
    },
    {
      id: 'activity',
      tone: privacy.show_online_status || privacy.show_last_seen ? 'review' : 'good',
      status: privacy.show_online_status || privacy.show_last_seen ? 'Worth a look' : 'Looks good',
      title: 'Your activity',
      text: privacy.show_online_status || privacy.show_last_seen
        ? 'Others can tell when you are around. Turn these off if you would rather reply on your own time.'
        : 'No one can see when you are online or when you were last here.',
    },
    {
      id: 'twofa',
      tone: user.two_factor_enabled ? 'good' : 'review',
      status: user.two_factor_enabled ? 'On' : 'Recommended',
      title: 'Two-factor authentication',
      text: user.two_factor_enabled
        ? 'A code from your authenticator app is needed to sign in, even if someone learns your password.'
        : 'Adds a one-time code to signing in, so a stolen password is not enough.',
      to: '/profile/2fa',
      cta: user.two_factor_enabled ? 'Manage' : 'Turn on',
    },
    {
      id: 'sessions',
      tone: 'info',
      status: 'Check now and then',
      title: 'Where you are signed in',
      text: 'If a device or browser looks unfamiliar, sign it out.',
      to: '/profile/sessions',
      cta: 'Review sessions',
    },
  ];

  const secureOn = Boolean(user.two_factor_enabled);
  const privacyLabel = VISIBILITY_OPTIONS.find((o) => o.value === privacy.profile_visibility)?.title || '';
  const attention = (alerts.messages || 0) + (alerts.missedCalls || 0);

  const cards = [
    { id: 'details', icon: '🪪', title: 'Your details', text: missing.length ? `Add ${missing[0].label}` : 'Everything filled in', chip: percent === 100 ? ['good', 'Complete'] : ['review', `${percent}%`] },
    { id: 'privacy', icon: '🙈', title: 'Privacy', text: `Visible to: ${privacyLabel.toLowerCase()}`, chip: checkup.some((c) => c.id !== 'sessions' && c.tone === 'review') ? ['review', 'Worth a look'] : ['good', 'Looks good'] },
    { id: 'security', icon: '🔐', title: 'Security', text: secureOn ? 'Two-factor is on' : 'Two-factor is off', chip: secureOn ? ['good', 'On'] : ['review', 'Recommended'] },
    { id: 'plans', icon: '🎟️', title: 'How a plan works', text: 'Ask to join, pay, meet, review', chip: ['info', '5 steps'] },
  ];

  return (
    <div className="page mp mp--compact">
      {/* ---------- Hero ---------- */}
      <header className="mp-hero">
        <div className="mp-hero__who">
          <div className="mp-hero__avatar">
            <Avatar user={user} />
            <label className="mp-hero__upload">
              {uploadingAvatar ? 'Uploading…' : 'Change photo'}
              <input type="file" accept="image/*" hidden disabled={uploadingAvatar} onChange={handleAvatarChange} />
            </label>
          </div>
          <div className="mp-hero__text">
            <h1 className="mp-hero__name break">{name}</h1>
            <p className="mp-hero__handle break">@{user.username}</p>
            <p className="mp-hero__chips">
              {user.role && <StatusChip tone="info">{user.role.toLowerCase()}</StatusChip>}
              <Link to={`/profile/${user.id}`} className="mp-hero__view">Public page</Link>
            </p>
          </div>
        </div>
        <button type="button" className="mp-menu-btn" onClick={() => setSideOpen(true)} aria-expanded={sideOpen} aria-controls="mp-side">
          <span aria-hidden="true">☰</span> Menu{attention > 0 && <b className="nb-count">{attention > 99 ? '99+' : attention}</b>}
        </button>
        <div className="mp-meter">
          <div className="mp-meter__row"><strong>{percent === 100 ? 'Profile complete' : `Profile ${percent}%`}</strong></div>
          <div className="mp-meter__bar" role="progressbar" aria-valuemin={0} aria-valuemax={100}
            aria-valuenow={percent} aria-label="Profile completeness"><span style={{ width: `${percent}%` }} /></div>
        </div>
      </header>

      <ErrorAlert error={error} />
      {savedMessage && <div className="alert alert--success" role="status">{savedMessage}</div>}

      <div className="mp-layout">
        {/* ---------- Sidebar (drawer on phones) ---------- */}
        <div className={`mp-scrim${sideOpen ? ' is-open' : ''}`} onClick={() => setSideOpen(false)} aria-hidden="true" />
        <aside id="mp-side" className={`mp-side${sideOpen ? ' is-open' : ''}`} aria-label="Profile menu">
          <div className="mp-side__top">
            <strong>Menu</strong>
            <button type="button" className="mp-side__close" onClick={() => setSideOpen(false)} aria-label="Close menu">✕</button>
          </div>
          <p className="mp-side__h">Settings</p>
          {cards.filter((c) => c.id !== 'plans').map((c) => (
            <button key={c.id} type="button" className="mp-side__item" onClick={() => openModal(c.id)}>
              <span aria-hidden="true">{c.icon}</span>{c.title}
            </button>
          ))}
          <p className="mp-side__h">Go to</p>
          {GO_LINKS.map((l) => (
            <Link key={l.to} to={l.to} className="mp-side__item" onClick={() => setSideOpen(false)}>
              <span aria-hidden="true">{l.icon}</span>{l.title}
              {l.alert && alerts[l.alert] > 0 && <b className="nb-count">{alerts[l.alert] > 99 ? '99+' : alerts[l.alert]}</b>}
            </Link>
          ))}
          {isStaff && (
            <Link to="/moderation" className="mp-side__item mp-side__item--staff" onClick={() => setSideOpen(false)}><span aria-hidden="true">🛡️</span>Moderation</Link>
          )}
        </aside>

        {/* ---------- Main: short summary cards, each opens a panel ---------- */}
        <div className="mp-main">
          {attention > 0 && (
            <section className="mp-alerts" aria-label="Needs your attention">
              {alerts.messages > 0 && <Link to="/chat" className="mp-alert mp-alert--msg">💬 {alerts.messages} unread {alerts.messages === 1 ? 'message' : 'messages'}</Link>}
              {alerts.missedCalls > 0 && <Link to="/calls" className="mp-alert mp-alert--call">📵 {alerts.missedCalls} missed {alerts.missedCalls === 1 ? 'call' : 'calls'}</Link>}
            </section>
          )}

          <div className="mp-cards">
            {cards.map((c) => (
              <button key={c.id} type="button" className="mp-card" onClick={() => openModal(c.id)}>
                <span className="mp-card__icon" aria-hidden="true">{c.icon}</span>
                <span className="mp-card__text"><strong>{c.title}</strong><small>{c.text}</small></span>
                <StatusChip tone={c.chip[0]}>{c.chip[1]}</StatusChip>
                <span className="mp-card__chev" aria-hidden="true">›</span>
              </button>
            ))}
            <Link to="/profile/blocked" className="mp-card" style={{ textDecoration: 'none', color: 'inherit' }}>
              <span className="mp-card__icon" aria-hidden="true">🚫</span>
              <span className="mp-card__text"><strong>Blocked people</strong><small>See who you've blocked and unblock them within 6 months.</small></span>
              <span className="mp-card__chev" aria-hidden="true">›</span>
            </Link>
          </div>

          <ProfilePreview user={user} form={form} privacy={privacy} />
        </div>
      </div>

      {/* ---------- Panels ---------- */}
      {modal === 'details' && (
        <Modal title="Your details" subtitle="This is what appears on your public page." onClose={closeModal}>
          <form onSubmit={handleProfileSubmit} className="stack">
            <div className="field">
              <label htmlFor="display_name">Display name</label>
              <input id="display_name" className="input" maxLength={50}
                value={form.display_name} onChange={(e) => setForm((f) => ({ ...f, display_name: e.target.value }))} />
            </div>
            <div className="field">
              <label htmlFor="bio">Bio</label>
              <textarea id="bio" className="textarea" maxLength={1000}
                value={form.bio} onChange={(e) => setForm((f) => ({ ...f, bio: e.target.value }))} />
            </div>
            <div className="field">
              <label htmlFor="general_location">General location</label>
              <input id="general_location" className="input" maxLength={100} placeholder="e.g. Yaba, Lagos"
                value={form.general_location} onChange={(e) => setForm((f) => ({ ...f, general_location: e.target.value }))} />
              <span className="hint">Shown publicly. Your exact address is never shared.</span>
            </div>
            <div className="field">
              <label htmlFor="availability">Availability</label>
              <input id="availability" className="input" maxLength={200} placeholder="e.g. Weekends and weekday evenings"
                value={form.availability} onChange={(e) => setForm((f) => ({ ...f, availability: e.target.value }))} />
            </div>
            <button className="btn btn--primary btn--block" disabled={savingProfile} type="submit">
              {savingProfile ? 'Saving…' : 'Save profile'}
            </button>
          </form>
        </Modal>
      )}

      {modal === 'privacy' && (
        <Modal title="Privacy" subtitle="You decide who can see and reach you. Changes save as you make them." wide onClose={closeModal}>
          <div className="mp-privacy">
            <div className="mp-privacy__controls">
              <fieldset className="mp-choices" disabled={savingPrivacy}>
                <legend>Who can see my profile</legend>
                {VISIBILITY_OPTIONS.map((o) => (
                  <label key={o.value} className={`mp-choice${privacy.profile_visibility === o.value ? ' is-on' : ''}`}>
                    <input type="radio" name="profile_visibility" value={o.value}
                      checked={privacy.profile_visibility === o.value}
                      onChange={() => handlePrivacyChange('profile_visibility', o.value)} />
                    <strong>{o.title}</strong>
                    <span>{o.text}</span>
                  </label>
                ))}
              </fieldset>

              <fieldset className="mp-segment" disabled={savingPrivacy}>
                <legend>Who can message me</legend>
                <div>
                  {MESSAGE_OPTIONS.map((o) => (
                    <label key={o.value} className={privacy.who_can_message === o.value ? 'is-on' : ''}>
                      <input type="radio" name="who_can_message" value={o.value}
                        checked={privacy.who_can_message === o.value}
                        onChange={() => handlePrivacyChange('who_can_message', o.value)} />
                      {o.label}
                    </label>
                  ))}
                </div>
                <small>Applies when someone starts a new chat. Chats you already have stay open.</small>
              </fieldset>

              <fieldset className="mp-segment" disabled={savingPrivacy}>
                <legend>Who can ask to join my plans</legend>
                <div>
                  {MESSAGE_OPTIONS.map((o) => (
                    <label key={o.value} className={requestsSetting === o.value ? 'is-on' : ''}>
                      <input type="radio" name="who_can_send_service_requests" value={o.value}
                        checked={requestsSetting === o.value}
                        onChange={() => handlePrivacyChange('who_can_send_service_requests', o.value)} />
                      {o.label}
                    </label>
                  ))}
                </div>
              </fieldset>

              <div className="mp-switches">
                <Switch id="show_online_status" title="Show when I'm online"
                  text="A green dot appears next to your name while you are active."
                  checked={privacy.show_online_status} disabled={savingPrivacy}
                  onChange={(v) => handlePrivacyChange('show_online_status', v)} />
                <Switch id="show_last_seen" title="Show when I was last seen"
                  text="Others can see roughly when you were last here."
                  checked={privacy.show_last_seen} disabled={savingPrivacy}
                  onChange={(v) => handlePrivacyChange('show_last_seen', v)} />
              </div>
            </div>
          </div>

          <h3 className="mp-h3">Privacy checkup</h3>
          <ul className="mp-checkup">
            {checkup.map((c) => (
              <li key={c.id} className={`mp-checkup__item mp-checkup__item--${c.tone}`}>
                <div>
                  <p className="mp-checkup__title">
                    <strong>{c.title}</strong>
                    <StatusChip tone={c.tone}>{c.status}</StatusChip>
                  </p>
                  <p className="mp-checkup__text">{c.text}</p>
                </div>
                {c.to && <Link to={c.to} className="btn btn--sm">{c.cta}</Link>}
              </li>
            ))}
          </ul>

          <aside className="mp-callout">
            <strong>If someone bothers you</strong>
            <p>
              Open their profile and choose <em>Block</em> to stop seeing each other, or <em>Report</em> so our moderators
              can look into it. Never share your password or a login code with anyone.
            </p>
            <p><Link to="/profile/blocked">Blocked people</Link></p>
          </aside>
        </Modal>
      )}

      {modal === 'security' && (
        <Modal title="Security" subtitle="Keep your account yours." wide onClose={closeModal}>
          <div className="mp-secure">
            <Link to="/profile/2fa" className="mp-secure__card">
              <span className="mp-secure__icon" aria-hidden="true">🔐</span>
              <strong>Two-factor authentication</strong>
              <StatusChip tone={secureOn ? 'good' : 'review'}>{secureOn ? 'On' : 'Off'}</StatusChip>
              <span>{secureOn
                ? 'Signing in needs a code from your authenticator app.'
                : 'Use an authenticator app to add a code to every sign-in.'}</span>
            </Link>
            <Link to="/profile/sessions" className="mp-secure__card">
              <span className="mp-secure__icon" aria-hidden="true">💻</span>
              <strong>Active sessions</strong>
              <span>See the devices that are signed in and end any you do not recognise.</span>
            </Link>
          </div>

          <PasswordPanel />

          <h3 className="mp-h3">Good habits</h3>
          <ul className="mp-habits">
            <li>Use a password you do not use anywhere else.</li>
            <li>Keep plans and payments on the site, where they are protected.</li>
            <li>Sign out on shared or public computers.</li>
          </ul>
        </Modal>
      )}

      {modal === 'plans' && (
        <Modal title="How a plan works" subtitle="From asking to join, to leaving a review." onClose={closeModal}>
          <ol className="mp-steps">
            {PLAN_STEPS.map((s, i) => (
              <li key={s.title}>
                <span className="mp-steps__n" aria-hidden="true">{i + 1}</span>
                <strong>{s.title}</strong>
                <span>{s.text}</span>
              </li>
            ))}
          </ol>
          <div className="mp-modal-acts">
            <Link to="/services" className="btn btn--primary btn--sm" onClick={closeModal}>Browse plans</Link>
            <Link to="/services/mine" className="btn btn--sm" onClick={closeModal}>Your plans</Link>
          </div>
        </Modal>
      )}
    </div>
  );
}
