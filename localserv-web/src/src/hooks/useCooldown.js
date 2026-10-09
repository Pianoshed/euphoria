import { useCallback, useEffect, useState } from 'react';

// Stored as a timestamp ("blocked until"), so a refresh or a new tab can't skip the wait.
const read = (key) => {
  try {
    return Number(localStorage.getItem(key)) || 0;
  } catch {
    return 0;
  }
};
const write = (key, value) => {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* private mode / storage blocked: the countdown still works for this page view */
  }
};

/** 2655 -> "44:15", 3600 -> "1:00:00" */
export function formatCountdown(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/**
 * A countdown that persists in localStorage under `storageKey`.
 *   const { remaining, start } = useCooldown('my-key');
 *   start(60)            -> blocks for 60 seconds
 *   remaining            -> seconds left (0 = free to go)
 */
export default function useCooldown(storageKey) {
  const [until, setUntil] = useState(() => read(storageKey));
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (until <= Date.now()) return undefined;
    const id = setInterval(() => {
      const n = Date.now();
      setNow(n);
      if (n >= until) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [until]);

  const start = useCallback(
    (seconds) => {
      const t = Date.now() + Math.max(0, Number(seconds) || 0) * 1000;
      write(storageKey, t);
      setUntil(t);
      setNow(Date.now());
    },
    [storageKey],
  );

  return { remaining: Math.max(0, Math.ceil((until - now) / 1000)), start };
}
