import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import * as chatApi from '../../api/chat';
import { ErrorAlert, Spinner } from '../../components/ui';
import './group.css';

/**
 * Where an invite link lands: /chat/join/:code
 * Shows the group's name and size, lets the person ASK to join, and says where the request stands.
 * An admin still has to accept, so a forwarded link never lets a stranger straight in.
 */
export default function JoinGroup() {
  const { code } = useParams();
  const navigate = useNavigate();
  const [info, setInfo] = useState(null);      // { title, member_count, status, conversation_id }
  const [invalid, setInvalid] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    chatApi.previewGroupInvite(code)
      .then((d) => {
        if (cancelled) return;
        if (d.status === 'member' && d.conversation_id) navigate(`/chat/${d.conversation_id}`, { replace: true });
        else setInfo(d);
      })
      .catch((err) => { if (!cancelled) { if (err?.status === 404) setInvalid(true); else setError(err); } });
    return () => { cancelled = true; };
  }, [code, navigate]);

  const ask = async () => {
    setBusy(true);
    setError(null);
    try {
      setInfo(await chatApi.requestToJoin(code));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (invalid) {
    return (
      <div className="join-card">
        <h1>This link isn&rsquo;t valid any more</h1>
        <p>The group&rsquo;s admin may have replaced it. Ask them for a new one.</p>
        <Link to="/chat" className="btn btn--sm btn--primary">Back to chats</Link>
      </div>
    );
  }
  if (!info) return <div className="page">{error ? <ErrorAlert error={error} /> : <Spinner />}</div>;

  return (
    <div className="join-card">
      <span aria-hidden="true" style={{ fontSize: '2rem' }}>👥</span>
      <h1>{info.title}</h1>
      <p>{info.member_count} {info.member_count === 1 ? 'person' : 'people'}</p>
      <ErrorAlert error={error} />
      {info.status === 'pending' ? (
        <p role="status">Request sent. You&rsquo;ll be able to open the group once an admin accepts you.</p>
      ) : (
        <>
          {info.status === 'declined' && <p role="status">Your last request wasn&rsquo;t accepted. You can ask again.</p>}
          <button type="button" className="btn btn--primary" onClick={ask} disabled={busy}>
            {busy ? 'Sending…' : 'Ask to join'}
          </button>
        </>
      )}
      <Link to="/chat" className="gpanel__link">Back to chats</Link>
    </div>
  );
}
