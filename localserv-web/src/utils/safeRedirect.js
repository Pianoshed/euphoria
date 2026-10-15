import { Capacitor } from '@capacitor/core';
import { Browser } from '@capacitor/browser';

// Only ever send the browser to a payment page we recognise. The checkout URL comes from the server, but a
// compromised response, a bad proxy or a stored bad value must never be able to bounce someone to a look-alike site.
const DEFAULT_HOSTS = ['monnify.com']; // matches monnify.com and any *.monnify.com (sandbox included)
const extra = (import.meta.env.VITE_CHECKOUT_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
const ALLOWED = [...DEFAULT_HOSTS, ...extra];

export function isSafeCheckoutUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.username || u.password) return false;
    const host = u.hostname.toLowerCase();
    return ALLOWED.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/** Navigates to the checkout page, or returns false (and does nothing) if the URL isn't one we trust. */
export function goToCheckout(raw) {
  if (!isSafeCheckoutUrl(raw)) return false;
  // Inside the Android app, open the payment page in the in-app browser so the app itself stays put.
  if (Capacitor.isNativePlatform()) Browser.open({ url: raw });
  else window.location.assign(raw);
  return true;
}
