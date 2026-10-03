import '../../styles/index.css';
import './myprofile.css';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import * as accountsApi from '../../api/accounts';
import { API_BASE } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { ErrorAlert, Spinner } from '../../components/ui';

/* ------------------------------------------------------------------ */
/* Static content                                                      */
/* ------------------------------------------------------------------ */

const SECTIONS = [
  { id: 'guide', label: 'Getting around' },
  { id: 'details', label: 'Your details' },
  { id: 'privacy', label: 'Privacy' },
  { id: 'security', label: 'Security' },
];

const GUIDE_TILES = [
  { to: '/providers', icon: '🧭', title: 'Find people', text: 'See who is hosting near you and say hi.' },
  { to: '/services', icon: '🎟️', title: 'Browse plans', text: 'What people are hosting this week, by category.' },
  { to: '/chat', icon: '💬', title: 'Messages', text: 'Pick up your conversations.' },
  { to: '/bookings', icon: '📅', title: 'Bookings', text: 'Requests you have sent, and ones you are hosting.' },
  { to: '/services/mine', icon: '🎉', title: 'Your plans', text: 'Post or edit things you are hosting.' },
  { to: '/wallet', icon: '👛', title: 'Wallet', text: 'Add funds and see where your money is.' },
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

function Avatar({ user, className = '' }) {
  const name = user.display_name || user.username || '?';
  return user.avatar
    ? <img className={`mp-avatar ${className}`} src={`${API_BASE}${user.avatar}`} alt="" />
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

  const handleProfileSubmit = async (e) => {
    e.preventDefault();
    setSavingProfile(true);
    setError(null);
    setSavedMessage('');
    try {
      await accountsApi.updateMyProfile(form);
      await refreshSession();
      setSavedMessage('Profile updated.');
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

  if (error && !privacy) return (
    <div className="page page--narrow">
      <h1>My profile</h1>
      <ErrorAlert error={error} />
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

  return (
    <div className="page mp">
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
              <StatusChip tone={user.two_factor_enabled ? 'good' : 'review'}>
                Two-factor {user.two_factor_enabled ? 'on' : 'off'}
              </StatusChip>
              <Link to={`/profile/${user.id}`} className="mp-hero__view">See your public page</Link>
            </p>
          </div>
        </div>

        <div className="mp-meter">
          <div className="mp-meter__row">
            <strong>{percent === 100 ? 'Profile complete' : `Profile ${percent}% complete`}</strong>
          </div>
          <div className="mp-meter__bar" role="progressbar" aria-valuemin={0} aria-valuemax={100}
            aria-valuenow={percent} aria-label="Profile completeness">
            <span style={{ width: `${percent}%` }} />
          </div>
          <p className="mp-meter__hint">
            {missing.length === 0
              ? 'People can see exactly who you are. Nice.'
              : <>Add {missing[0].label} so people know who they are talking to. <a href="#details">Go to details</a></>}
          </p>
        </div>
      </header>

      <ErrorAlert error={error} />
      {savedMessage && <div className="alert alert--success" role="status">{savedMessage}</div>}

      <div className="mp-layout">
        <nav className="mp-nav" aria-label="On this page">
          {SECTIONS.map((s) => <a key={s.id} href={`#${s.id}`}>{s.label}</a>)}
        </nav>

        <div className="mp-main">
          {/* ---------- Getting around ---------- */}
          <section id="guide" className="mp-section" aria-labelledby="guide-h">
            <h2 id="guide-h" className="mp-h">Getting around</h2>
            <p className="mp-lede">Everything lives a click away. Here is what each part of the site is for.</p>

            <div className="mp-tiles">
              {GUIDE_TILES.map((t) => (
                <Link key={t.to} to={t.to} className="mp-tile">
                  <span className="mp-tile__icon" aria-hidden="true">{t.icon}</span>
                  <strong>{t.title}</strong>
                  <span>{t.text}</span>
                </Link>
              ))}
              {isStaff && (
                <Link to="/moderation" className="mp-tile mp-tile--staff">
                  <span className="mp-tile__icon" aria-hidden="true">🛡️</span>
                  <strong>Moderation</strong>
                  <span>Reports and disputes waiting for review.</span>
                </Link>
              )}
            </div>

            <h3 className="mp-h3">How a plan works</h3>
            <ol className="mp-steps">
              {PLAN_STEPS.map((s, i) => (
                <li key={s.title}>
                  <span className="mp-steps__n" aria-hidden="true">{i + 1}</span>
                  <strong>{s.title}</strong>
                  <span>{s.text}</span>
                </li>
              ))}
            </ol>
          </section>

          {/* ---------- Details ---------- */}
          <section id="details" className="mp-section" aria-labelledby="details-h">
            <h2 id="details-h" className="mp-h">Your details</h2>
            <p className="mp-lede">This is what appears on your public page.</p>

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
          </section>

          {/* ---------- Privacy ---------- */}
          <section id="privacy" className="mp-section" aria-labelledby="privacy-h">
            <h2 id="privacy-h" className="mp-h">Privacy</h2>
            <p className="mp-lede">You are in charge of who can see you and who can reach you. Changes save as soon as you make them.</p>

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

              <ProfilePreview user={user} form={form} privacy={privacy} />
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
                can look into it. Never share your password or a login code with anyone, in chat or anywhere else.
              </p>
            </aside>
          </section>

          {/* ---------- Security ---------- */}
          <section id="security" className="mp-section" aria-labelledby="security-h">
            <h2 id="security-h" className="mp-h">Security</h2>
            <p className="mp-lede">Keep your account yours.</p>

            <div className="mp-secure">
              <Link to="/profile/2fa" className="mp-secure__card">
                <span className="mp-secure__icon" aria-hidden="true">🔐</span>
                <strong>Two-factor authentication</strong>
                <StatusChip tone={user.two_factor_enabled ? 'good' : 'review'}>
                  {user.two_factor_enabled ? 'On' : 'Off'}
                </StatusChip>
                <span>{user.two_factor_enabled
                  ? 'Signing in needs a code from your authenticator app.'
                  : 'Use an authenticator app to add a code to every sign-in.'}</span>
              </Link>
              <Link to="/profile/sessions" className="mp-secure__card">
                <span className="mp-secure__icon" aria-hidden="true">💻</span>
                <strong>Active sessions</strong>
                <span>See the devices that are signed in and end any you do not recognise.</span>
              </Link>
              <Link to="/password-reset" className="mp-secure__card">
                <span className="mp-secure__icon" aria-hidden="true">🔑</span>
                <strong>Change your password</strong>
                <span>We will email you a link to set a new one.</span>
              </Link>
            </div>

            <h3 className="mp-h3">Good habits</h3>
            <ul className="mp-habits">
              <li>Use a password you do not use anywhere else.</li>
              <li>Keep plans and payments on the site, where they are protected.</li>
              <li>Sign out on shared or public computers.</li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
