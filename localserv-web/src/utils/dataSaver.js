/*
 * Data saver: lower call quality and smaller photos, to spend less mobile data.
 *
 * Setting is 'auto' (default), 'on' or 'off', kept in this browser.
 *   auto = on when the browser says Data Saver is enabled, or the connection looks slow/cellular.
 */
const KEY = 'euphoria.dataSaver';
const listeners = new Set();

function read() {
  try { return localStorage.getItem(KEY) || 'auto'; } catch { return 'auto'; }
}

export function getDataSaverSetting() {
  return read();
}

export function setDataSaverSetting(value) {
  try { localStorage.setItem(KEY, value); } catch { /* storage unavailable: setting lasts until reload */ }
  listeners.forEach((fn) => fn());
}

export function subscribeDataSaver(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function isDataSaverOn() {
  const setting = read();
  if (setting === 'on') return true;
  if (setting === 'off') return false;
  const c = typeof navigator !== 'undefined' ? (navigator.connection || navigator.mozConnection) : null;
  if (!c) return false;
  return Boolean(c.saveData) || c.type === 'cellular' || /(^|-)2g$|3g/.test(c.effectiveType || '')
    || (typeof c.downlink === 'number' && c.downlink > 0 && c.downlink < 1.5) || (typeof c.rtt === 'number' && c.rtt > 450);
}

/**
 * Camera/mic limits for a call. Capturing a smaller picture is what saves phone CPU and battery
 * (every peer connection encodes its own copy), so the cap is applied at the camera, not only on the wire.
 *   saver  : 320x240 @15
 *   normal : 640x480 @24   (was 1280x720 @30: ~4x the pixels for no visible gain on a phone screen)
 *   group  : 480x360 @15   (several people on a small screen; each extra person is another encode)
 */
export function callMediaConstraints(saver, facingMode, withVideo, group = false) {
  let video = { facingMode, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } };
  if (saver) video = { facingMode, width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15, max: 15 } };
  else if (group) video = { facingMode, width: { ideal: 480 }, height: { ideal: 360 }, frameRate: { ideal: 15, max: 20 } };
  return {
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: withVideo ? video : false,
  };
}

/**
 * Upper bounds on what is sent, in bits per second. Audio stays clear either way.
 * `peers` = how many other people receive this stream. In a mesh every peer gets its own copy, so one
 * fixed cap per connection multiplies: the cap is split so total upload stays near a fixed budget.
 */
export function senderLimits(saver, peers = 1) {
  const n = Math.max(1, peers);
  if (n === 1) {
    return saver
      ? { audio: 24_000, video: 150_000, maxFramerate: 15, scale: 1 }
      : { audio: 32_000, video: 500_000, maxFramerate: 24, scale: 1 };
  }
  const budget = saver ? 250_000 : 600_000;          // total video upload for the whole group call
  const video = Math.max(60_000, Math.floor(budget / n));
  return {
    audio: 24_000,
    video,
    maxFramerate: 15,
    scale: video < 80_000 ? 4 : video < 160_000 ? 2 : 1, // small share of the budget: send a smaller picture too
  };
}

/** Apply the limits to every sender of a live call. Safe to call again when the setting changes. */
export async function applySenderLimits(pc, saver, { peers = 1 } = {}) {
  if (!pc) return;
  const limits = senderLimits(saver, peers);
  await Promise.all(pc.getSenders().map(async (sender) => {
    if (!sender.track) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      const enc = params.encodings[0];
      if (sender.track.kind === 'audio') {
        enc.maxBitrate = limits.audio;
      } else {
        enc.maxBitrate = limits.video;
        enc.maxFramerate = limits.maxFramerate;
        enc.scaleResolutionDownBy = limits.scale;
        params.degradationPreference = 'maintain-framerate'; // under load, shrink the picture before stuttering
      }
      await sender.setParameters(params);
    } catch { /* this browser does not allow it: the call still works at default quality */ }
  }));
}

/**
 * Shrink a photo before upload. Returns the original file if it is already small, is not a
 * JPEG/PNG/WebP, or the browser cannot do it. Saver mode is stricter than normal mode.
 */
export async function compressImage(file, saver = isDataSaverOn()) {
  if (!file || !/^image\/(jpeg|png|webp)$/.test(file.type)) return file;
  const maxSide = saver ? 1024 : 1600;
  const quality = saver ? 0.6 : 0.8;
  const skipBelow = saver ? 150_000 : 400_000;
  if (file.size <= skipBelow) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const blob = await new Promise((resolve) => { canvas.toBlob(resolve, 'image/jpeg', quality); });
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch {
    return file;
  }
}
