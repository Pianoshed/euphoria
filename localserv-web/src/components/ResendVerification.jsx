import { useEffect, useState } from 'react';
import * as accountsApi from '../api/accounts';

const COOLDOWN_SECONDS = 60;

/**
 * "Didn't get the email? Send it again." Waits 60 seconds between sends (the server also
 * rate-limits). If no email is given it asks for one, so it works from any page.
 */
export default function ResendVerification({ email: initialEmail = '' }) {
  const [email, setEmail] = useState(initialEmail);
  const [wait, setWait] = useState(0);
  const [state, setState] = useState('idle'); // idle | sending | sent | error
  const [message, setMessage] = useState('');

  useEffect(() => { setEmail(initialEmail); }, [initialEmail]);

  useEffect(() => {
    if (wait <= 0) return undefined;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  const send = async () => {
    if (!email.trim() || wait > 0 || state === 'sending') return;
    setState('sending');
    try {
      await accountsApi.resendVerification(email.trim());
      setState('sent');
      setMessage('If that address has an unverified account, a new link is on its way. Check spam too.');
      setWait(COOLDOWN_SECONDS);
    } catch (err) {
      setState('error');
      setMessage(err?.status === 429
        ? 'Too many tries. Please wait a few minutes and try again.'
        : 'Could not send right now. Please try again shortly.');
    }
  };

  return (
    <div className="resend">
      {!initialEmail && (
        <input
          className="input"
          type="email"
          placeholder="Your email address"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
        />
      )}
      <button type="button" className="btn btn--ghost btn--sm" onClick={send}
        disabled={!email.trim() || wait > 0 || state === 'sending'}>
        {state === 'sending' ? 'Sending…' : wait > 0 ? `Send again in ${wait}s` : 'Resend verification email'}
      </button>
      {message && (
        <p className={`text-sm ${state === 'error' ? '' : 'muted'}`} role="status">{message}</p>
      )}
    </div>
  );
}
