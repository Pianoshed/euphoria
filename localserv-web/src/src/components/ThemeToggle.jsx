import { useEffect, useState } from 'react';
import { getTheme, setTheme } from '../utils/theme';

// One round button: shows the mode you will switch TO.
export function ThemeToggle({ className = '' }) {
  const [theme, setThemeState] = useState(getTheme);

  useEffect(() => {
    const on = (e) => setThemeState(e.detail);
    window.addEventListener('euphoria-theme', on);
    return () => window.removeEventListener('euphoria-theme', on);
  }, []);

  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      className={`theme-toggle ${className}`.trim()}
      onClick={() => setTheme(next)}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
    >
      <span aria-hidden="true">{theme === 'dark' ? '☀️' : '🌙'}</span>
    </button>
  );
}
