/*
 * The "new message" beep. It is made with the Web Audio API, so there is no sound file to
 * ship, host or lose in a deploy.
 *
 * Browsers keep audio locked until the person has clicked, tapped or typed on the page once,
 * so armSound() waits for that first gesture. After it, the beep plays on its own.
 */

const KEY = 'chat-sound';
const MIN_GAP_MS = 800; // two messages in quick succession make one beep, not a burst

let ctx = null;
let lastPlayed = 0;

export function isSoundOn() {
  try {
    return window.localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setSoundOn(on) {
  try {
    window.localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    /* private mode: the choice just won't be remembered */
  }
}

function getContext() {
  if (ctx) return ctx;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;
  ctx = new AudioCtx();
  return ctx;
}

/** Unlock audio on the first click, tap or key press. Returns a function that removes the listeners. */
export function armSound() {
  const events = ['pointerdown', 'keydown', 'touchstart'];
  const unlock = () => {
    const c = getContext();
    if (c && c.state === 'suspended') c.resume().catch(() => {});
    events.forEach((e) => window.removeEventListener(e, unlock));
  };
  events.forEach((e) => window.addEventListener(e, unlock));
  return () => events.forEach((e) => window.removeEventListener(e, unlock));
}

/** A short two-note "ding". Does nothing if the person turned sound off. */
export function playMessageSound() {
  if (!isSoundOn()) return;
  const now = Date.now();
  if (now - lastPlayed < MIN_GAP_MS) return;
  const c = getContext();
  if (!c) return;
  lastPlayed = now;

  const ding = () => {
    const t0 = c.currentTime;
    [[880, 0], [1175, 0.14]].forEach(([freq, offset]) => {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + offset);
      gain.gain.exponentialRampToValueAtTime(0.25, t0 + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + offset + 0.22);
      osc.connect(gain).connect(c.destination);
      osc.start(t0 + offset);
      osc.stop(t0 + offset + 0.24);
    });
  };

  if (c.state === 'suspended') c.resume().then(ding).catch(() => {});
  else ding();
}
