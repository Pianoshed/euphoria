import '../../styles/index.css';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import * as accountsApi from '../../api/accounts';
import AuthCard from './AuthCard';
import { ErrorAlert, Spinner } from '../../components/ui';

export default function VerifyEmail() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const [status, setStatus] = useState('pending'); // pending | success | error
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!token) {
      setStatus('error');
      setError(new Error('This verification link is missing its token.'));
      return;
    }
    accountsApi.verifyEmail(token)
      .then(() => setStatus('success'))
      .catch((err) => { setStatus('error'); setError(err); });
  }, [token]);

  return (
    <AuthCard>
      <h1>Verify your email</h1>
      {status === 'pending' && <p><Spinner /> Verifying…</p>}
      {status === 'success' && (
        <p>Your email is verified. You can now <Link to="/login">log in</Link>.</p>
      )}
      {status === 'error' && (
        <>
          <ErrorAlert error={error} />
          <p className="text-sm muted">
            The link may have expired. <Link to="/login">Log in</Link> and request a new one from your account settings.
          </p>
        </>
      )}
    </AuthCard>
  );
}
