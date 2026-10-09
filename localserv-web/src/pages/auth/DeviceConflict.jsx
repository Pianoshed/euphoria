import '../../styles/index.css';
import { ErrorAlert } from '../../components/ui';

const since = (iso) => {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 2) return 'active just now';
  if (mins < 60) return `active ${mins} minutes ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `active ${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  return `active ${Math.round(hrs / 24)} days ago`;
};

/**
 * Shown when the account is already signed in somewhere else. Only one device can be signed in at a time,
 * so the person chooses: sign the other device out and continue here, or cancel (nothing changes).
 * devices = [{ device: 'Chrome on Windows', last_active: ISO }]
 */
export default function DeviceConflict({ devices = [], busy, error, onConfirm, onCancel }) {
  return (
    <>
      <h1>You're signed in on another device</h1>
      <p className="auth-sub">
        An account can only be signed in on one device at a time. To continue here, we'll sign you out
        {devices.length > 1 ? ' of these devices' : ' of the other device'}.
      </p>

      <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: '0 0 1rem' }}>
        {devices.map((d, i) => (
          <li key={i} style={{ padding: '0.7rem 0.9rem', borderRadius: 12, border: '1px solid rgba(120,120,150,0.3)' }}>
            <strong>{d.device}</strong>
            {since(d.last_active) && <span className="hint" style={{ display: 'block' }}>{since(d.last_active)}</span>}
          </li>
        ))}
      </ul>

      <ErrorAlert error={error} />
      <button type="button" className="btn-primary-full" disabled={busy} onClick={onConfirm}>
        {busy ? 'Signing in…' : 'Sign out there and continue here'}
      </button>
      <p className="auth-footer-note">
        <button type="button" disabled={busy} onClick={onCancel}
          style={{ background: 'none', border: 0, padding: 0, color: 'inherit', textDecoration: 'underline', cursor: 'pointer' }}>
          Cancel &mdash; stay signed in there
        </button>
      </p>
      <p className="hint" style={{ textAlign: 'center' }}>
        Wasn't you? Cancel, then change your password after signing in.
      </p>
    </>
  );
}
