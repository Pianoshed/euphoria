import '../../styles/index.css';
import { usePageBackdrop } from '../../hooks/usePageBackdrop';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import * as accountsApi from '../../api/accounts';
import * as chatApi from '../../api/chat';
import { useAuth } from '../../context/AuthContext';
import { ErrorAlert, Spinner } from '../../components/ui';
import { ReportButton } from '../../components/ReportButton';

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

  return (
    <div className="page page--narrow">
      <div className="profile-head">
        {profile.avatar
          ? <img className="avatar avatar--xl" src={profile.avatar} alt="" />
          : <span className="avatar avatar--xl" aria-hidden="true">{(profile.display_name || profile.username || '?')[0].toUpperCase()}</span>}
        <div className="min-w-0">
          <h1>{profile.display_name}</h1>
          <p className="text-sm muted m-0 break">@{profile.username} · {profile.role.toLowerCase()}</p>
        </div>
      </div>
      {profile.general_location && <p className="text-sm muted">{profile.general_location}</p>}
      {profile.bio && <p className="break">{profile.bio}</p>}
      {profile.availability && <p className="text-sm"><strong>Availability:</strong> {profile.availability}</p>}

      {!isSelf && user && !blocked && (
        <div className="row row--wrap" style={{ marginTop: 'var(--space-4)' }}>
          <button className="btn btn--primary" disabled={busy} onClick={handleMessage}>Message</button>
          <button className="btn" disabled={busy} onClick={handleBlock}>Block</button>
          <ReportButton targetType="USER" targetId={profile.id} />
        </div>
      )}
      {blocked && <p className="alert alert--info" style={{ marginTop: 'var(--space-4)' }}>You've blocked this user.</p>}
    </div>
  );
}