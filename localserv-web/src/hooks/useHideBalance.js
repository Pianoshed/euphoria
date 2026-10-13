import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { formatNaira } from '../utils/money';

/**
 * "Incognito" for the wallet balance. The choice is remembered per account on this device, so two people
 * logging into the same phone each keep their own setting. Shared by the home feed, the wallet page and
 * other open tabs. Hidden = every balance shows as dots until revealed.
 */
const keyFor = (uid) => `wallet-balance-hidden-v2:${uid ?? 'anon'}`;
const EVENT = 'euphoria-balance-hidden';
export const HIDDEN_MASK = '₦ ••••••';

const read = (uid) => { try { return localStorage.getItem(keyFor(uid)) === '1'; } catch { return false; } };

export function useHideBalance() {
  const { user } = useAuth();
  const uid = user?.id;
  const [hidden, setHidden] = useState(() => read(uid));

  useEffect(() => {
    const sync = () => setHidden(read(uid));
    sync(); // a different account just logged in on this device
    window.addEventListener(EVENT, sync);
    window.addEventListener('storage', sync); // another tab
    return () => { window.removeEventListener(EVENT, sync); window.removeEventListener('storage', sync); };
  }, [uid]);

  const toggle = useCallback(() => {
    const next = !read(uid);
    try { localStorage.setItem(keyFor(uid), next ? '1' : '0'); } catch { /* private mode: lasts until the page closes */ }
    setHidden(next);
    window.dispatchEvent(new Event(EVENT)); // tells every other component on the page
  }, [uid]);

  // naira(value) -> "₦3,500", or the mask while hidden
  const naira = useCallback((value) => (hidden ? HIDDEN_MASK : formatNaira(value)), [hidden]);

  return { hidden, toggle, naira };
}
