import { useEffect, useState } from 'react';
import './chill.css';

/** A faint strip at the top while the device has no connection. It disappears by itself when the network is back. */
export default function OfflineBanner() {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  if (online) return null;
  return (
    <div className="offline-banner" role="status" aria-live="polite">
      You're offline. We'll pick things up again when your connection is back
      <span className="chill__dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>
    </div>
  );
}
