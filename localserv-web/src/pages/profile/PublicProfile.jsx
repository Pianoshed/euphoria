import '../../styles/index.css';
import './publicprofile.css';
import { usePageBackdrop } from '../../hooks/usePageBackdrop';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import * as accountsApi from '../../api/accounts';
import * as chatApi from '../../api/chat';
import { useAuth } from '../../context/AuthContext';
import { ErrorAlert, Spinner } from '../../components/ui';
import { ReportButton } from '../../components/ReportButton';
import { ROLE_META } from '../../utils/roles';
import { lookFor } from '../../utils/bubbleLook';

export default function PublicProfile() {
  usePageBackdrop('couples');
  const { id } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState(null);
  const [blocked, setBlocked] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    accountsApi.getPublicProfile(id).then(setProfile).catch(setError);
  }, [id]);

  const handleMessage = async () => {
    setBusy(true);
    setError(null);
    try {
      const conversation = await chatApi.startConversation(id);
      navigate(`/chat/${conversation.id}`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const handleBlock = async () => {
    setBusy(true);
    setError(null);
    try {
      await accountsApi.blockUser(id);
      setBlocked(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (error) return <div className="page"><ErrorAlert error={error} /></div>;
  if (!profile) return <div className="page"><Spinner /></div>;

  const isSelf = user?.id === profile.id;
  const name = profile.display_name || profile.username || 'Someone';
  const meta = ROLE_META[profile.role];
  const look = lookFor(profile.id, 0); // same colour and shape as their bubble in Find people

  return (
    <div className="page pf" style={{ '--tint': look.tint.bg, '--ring': look.tint.ring, '--avatar-shape': look.avatarShape }}>
      <header className="pf-hero">
        <span className="pf-avatar">
          {profile.avatar
            ? <img src={profile.avatar} alt="" />
            : <span aria-hidden="true">{name[0].toUpperCase()}</span>}
          {profile.online && <span className="pf-online" role="img" aria-label="Online" />}
        </span>
        <h1 className="pf-name">{name}</h1>
        <p className="pf-handle">@{profile.username}</p>
        <p className="pf-chips">
          {meta && <span className={`pf-chip pf-chip--${profile.role.toLowerCase()}`}>{meta.label}</span>}
          {profile.general_location && <span className="pf-chip">📍 {profile.general_location}</span>}
          {profile.availability && <span className="pf-chip">🕒 {profile.availability}</span>}
        </p>
        {meta && <p className="pf-blurb">{meta.blurb}</p>}
      </header>

      {profile.bio && (
        <section className="pf-card" aria-label="About">
          <h2>About</h2>
          <p className="break">{profile.bio}</p>
        </section>
      )}

      {!isSelf && user && !blocked && (
        <div className="pf-actions">
          <button type="button" className="pf-btn pf-btn--solid" disabled={busy} onClick={handleMessage}>👋 Message</button>
          <button type="button" className="pf-btn" disabled={busy} onClick={handleBlock}>Block</button>
          <ReportButton targetType="USER" targetId={profile.id} />
        </div>
      )}
      {blocked && <p className="alert alert--info" style={{ marginTop: 'var(--space-4)' }}>You've blocked this user.</p>}
    </div>
  );
}
