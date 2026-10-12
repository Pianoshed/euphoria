import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

// Keeps the page's canonical link and og:url in step with the route. It only UPDATES the tags that index.html
// already has (and creates one only if missing), so there are never duplicates. The base is VITE_SITE_URL
// (the production domain) or, if that is not set, the address the page is actually served from.
function upsert(selector, create, attr, value) {
  let el = document.head.querySelector(selector);
  if (!el) { el = create(); document.head.appendChild(el); }
  el.setAttribute(attr, value);
}

export default function SiteMeta() {
  const { pathname } = useLocation();
  useEffect(() => {
    const base = (import.meta.env.VITE_SITE_URL || window.location.origin).replace(/\/+$/, '');
    const url = `${base}${pathname === '/' ? '/' : pathname.replace(/\/+$/, '')}`;
    upsert('link[rel="canonical"]', () => Object.assign(document.createElement('link'), { rel: 'canonical' }), 'href', url);
    upsert('meta[property="og:url"]', () => { const m = document.createElement('meta'); m.setAttribute('property', 'og:url'); return m; }, 'content', url);
  }, [pathname]);
  return null;
}
