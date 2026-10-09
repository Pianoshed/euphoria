// Light / dark theme. The choice lives on <html data-theme="light|dark"> and in localStorage.
// First visit follows the device setting. initTheme() runs before React renders, so there is no flash.
const KEY = 'euphoria-theme';

const systemTheme = () =>
  (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

export function getTheme() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch { /* storage blocked: fall through */ }
  return systemTheme();
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#120C24' : '#FFF7F1');
}

export function setTheme(theme) {
  try { localStorage.setItem(KEY, theme); } catch { /* ignore */ }
  applyTheme(theme);
  window.dispatchEvent(new CustomEvent('euphoria-theme', { detail: theme }));
}

export function initTheme() {
  applyTheme(getTheme());
  // follow the device live, but only until the person picks one themselves
  const mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
  if (mq && mq.addEventListener) {
    mq.addEventListener('change', (e) => {
      let saved = null;
      try { saved = localStorage.getItem(KEY); } catch { /* ignore */ }
      if (!saved) { applyTheme(e.matches ? 'dark' : 'light'); window.dispatchEvent(new CustomEvent('euphoria-theme', { detail: e.matches ? 'dark' : 'light' })); }
    });
  }
}
