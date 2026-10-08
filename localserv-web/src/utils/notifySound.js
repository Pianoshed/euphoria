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

/* ---- Message tones ------------------------------------------------------------------------
 * Several distinct, musical tones (not a flat beep). Each note is a few harmonics with its own
 * decay, fed through a small echo so it sounds rounded. The browser cannot play the phone's or PC's
 * own tone files, so these are synthesised; the chosen tone is remembered on this device.
 */
const TONE_KEY = 'chat-tone';

// [frequency Hz, start s, length s] per note, plus a voice: which harmonics and how fast they die.
const VOICES = {
  bell:    { parts: [[1, 1], [2.76, 0.45], [5.4, 0.2]], attack: 0.004, decayMul: 1 },
  glass:   { parts: [[1, 1], [3, 0.3], [4.2, 0.12]], attack: 0.003, decayMul: 0.8 },
  wood:    { parts: [[1, 1], [4, 0.35], [9.2, 0.08]], attack: 0.002, decayMul: 0.55 },
  soft:    { parts: [[1, 1], [2, 0.18]], attack: 0.02, decayMul: 1.1 },
};
const TONES = {
  chime:   { label: 'Chime',   voice: 'bell',  echo: 0.28, notes: [[784, 0, 0.5], [988, 0.12, 0.5], [1319, 0.26, 0.9]] },
  sparkle: { label: 'Sparkle', voice: 'glass', echo: 0.35, notes: [[1047, 0, 0.3], [1319, 0.08, 0.3], [1568, 0.16, 0.3], [2093, 0.24, 0.8]] },
  marimba: { label: 'Marimba', voice: 'wood',  echo: 0.15, notes: [[523, 0, 0.3], [659, 0.11, 0.3], [784, 0.22, 0.3], [659, 0.36, 0.5]] },
  pop:     { label: 'Pop',     voice: 'soft',  echo: 0.1,  notes: [[440, 0, 0.12], [880, 0.07, 0.22]], glide: true },
  harp:    { label: 'Harp',    voice: 'bell',  echo: 0.4,  notes: [[392, 0, 0.8], [494, 0.09, 0.8], [587, 0.18, 0.8], [784, 0.27, 1.2]] },
  lullaby: { label: 'Lullaby', voice: 'soft',  echo: 0.45, notes: [[587, 0, 0.6], [740, 0.22, 0.6], [880, 0.44, 1.2]] },
};
export const TONE_LIST = Object.entries(TONES).map(([id, t]) => ({ id, label: t.label }));

export function getTone() {
  try {
    const id = window.localStorage.getItem(TONE_KEY);
    return TONES[id] ? id : 'chime';
  } catch {
    return 'chime';
  }
}

export function setTone(id) {
  if (!TONES[id]) return;
  try { window.localStorage.setItem(TONE_KEY, id); } catch { /* not remembered in private mode */ }
}

export function nextTone() {
  const ids = Object.keys(TONES);
  const id = ids[(ids.indexOf(getTone()) + 1) % ids.length];
  setTone(id);
  return id;
}

// one note: layered harmonics, fast attack, exponential decay
function voiceNote(c, out, voice, freq, t, len, glideFrom) {
  voice.parts.forEach(([mult, level]) => {
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = 'sine';
    if (glideFrom) {
      osc.frequency.setValueAtTime(glideFrom * mult, t);
      osc.frequency.exponentialRampToValueAtTime(freq * mult, t + 0.07);
    } else {
      osc.frequency.value = freq * mult;
    }
    const peak = 0.2 * level;
    const end = t + len * voice.decayMul * (mult > 1 ? 1 / Math.sqrt(mult) : 1);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + voice.attack);
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(g).connect(out);
    osc.start(t);
    osc.stop(end + 0.02);
  });
}

function playTone(c, id) {
  const tone = TONES[id] || TONES.chime;
  const voice = VOICES[tone.voice];
  const t0 = c.currentTime + 0.02;

  const out = c.createGain();
  out.gain.value = 0.9;
  out.connect(c.destination);
  if (tone.echo) { // a short feedback echo gives body instead of a dry beep
    const delay = c.createDelay(0.5);
    const fb = c.createGain();
    const wet = c.createGain();
    delay.delayTime.value = 0.16;
    fb.gain.value = tone.echo;
    wet.gain.value = 0.5;
    out.connect(delay);
    delay.connect(fb).connect(delay);
    delay.connect(wet).connect(c.destination);
  }
  tone.notes.forEach(([freq, offset, len], i) => {
    voiceNote(c, out, voice, freq, t0 + offset, len, tone.glide && i === 1 ? freq / 2 : null);
  });
}

/** Play the chosen tone. Pass an id to preview a specific one (ignores the on/off switch). */
export function playMessageSound(previewId) {
  if (!previewId && !isSoundOn()) return;
  const now = Date.now();
  if (!previewId && now - lastPlayed < MIN_GAP_MS) return;
  const c = getContext();
  if (!c) return;
  lastPlayed = now;
  const id = previewId || getTone();
  if (c.state === 'suspended') c.resume().then(() => playTone(c, id)).catch(() => {});
  else playTone(c, id);
}

/* ---- Device notification (uses the phone's / PC's own notification sound) --------------------
 * When the tab is in the background the operating system plays ITS notification tone for this.
 * Needs the person's permission, asked when they switch sound on.
 */
export async function askDeviceNotifications() {
  try {
    if (!('Notification' in window) || Notification.permission !== 'default') return;
    await Notification.requestPermission();
  } catch { /* unsupported browser */ }
}

export function notifyDevice(title, body, tag = 'euphoria-msg') {
  try {
    if (!isSoundOn() || !('Notification' in window) || Notification.permission !== 'granted') return;
    if (document.visibilityState === 'visible') return;
    const n = new Notification(title, { body, tag, renotify: true, silent: false, icon: '/favicon.ico' });
    n.onclick = () => { window.focus(); n.close(); };
  } catch { /* some mobile browsers only allow notifications from a service worker */ }
}

/* ---- Incoming-call ringtone ------------------------------------------------------------ */

let ringTimer = null;

// A short rising melody that repeats, instead of the flat telephone double-tone.
function ringBurst(c) {
  const voice = VOICES.bell;
  const t0 = c.currentTime + 0.02;
  const out = c.createGain();
  out.gain.value = 0.9;
  out.connect(c.destination);
  const delay = c.createDelay(0.5);
  const fb = c.createGain();
  delay.delayTime.value = 0.2;
  fb.gain.value = 0.3;
  out.connect(delay);
  delay.connect(fb).connect(delay);
  delay.connect(c.destination);
  [[659, 0], [784, 0.2], [988, 0.4], [784, 0.7], [988, 0.9], [1319, 1.1]].forEach(([f, o]) => {
    voiceNote(c, out, voice, f, t0 + o, 0.55, null);
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
  ringTimer = setInterval(go, 3200);
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
