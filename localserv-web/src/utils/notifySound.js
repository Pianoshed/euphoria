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

/* ---- Incoming-call ringtone ------------------------------------------------------------ */

let ringTimer = null;

// The classic double ring: two 0.4s bursts of 440+480 Hz, then a pause.
function ringBurst(c) {
  const t0 = c.currentTime;
  [0, 0.5].forEach((offset) => {
    [440, 480].forEach((freq) => {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + offset);
      gain.gain.exponentialRampToValueAtTime(0.18, t0 + offset + 0.03);
      gain.gain.setValueAtTime(0.18, t0 + offset + 0.34);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + offset + 0.42);
      osc.connect(gain).connect(c.destination);
      osc.start(t0 + offset);
      osc.stop(t0 + offset + 0.44);
    });
  });
}

/** Ring until stopRingtone(). Not tied to the message-sound switch: a muted chat must not miss a call. */
export function startRingtone() {
  if (ringTimer) return;
  const c = getContext();
  if (!c) return;
  const go = () => {
    if (c.state === 'suspended') c.resume().then(() => ringBurst(c)).catch(() => {});
    else ringBurst(c);
    try { navigator.vibrate?.([400, 200, 400]); } catch { /* not supported */ }
  };
  go();
  ringTimer = setInterval(go, 2500);
}

export function stopRingtone() {
  clearInterval(ringTimer);
  ringTimer = null;
  try { navigator.vibrate?.(0); } catch { /* not supported */ }
}

/* ---- Ringback: what the CALLER hears while the other phone rings ------------------------- */

let ringbackTimer = null;

// One long soft tone (2s), then 4s of silence, repeating: the standard ringback cadence.
function ringbackTone(c) {
  const t0 = c.currentTime;
  [440, 480].forEach((freq) => {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.1, t0 + 0.05);
    gain.gain.setValueAtTime(0.1, t0 + 1.9);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 2);
    osc.connect(gain).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + 2.05);
  });
}

export function startRingback() {
  if (ringbackTimer) return;
  const c = getContext();
  if (!c) return;
  const go = () => {
    if (c.state === 'suspended') c.resume().then(() => ringbackTone(c)).catch(() => {});
    else ringbackTone(c);
  };
  go();
  ringbackTimer = setInterval(go, 6000);
}

export function stopRingback() {
  clearInterval(ringbackTimer);
  ringbackTimer = null;
}
