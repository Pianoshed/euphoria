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
  return Boolean(c.saveData) || c.type === 'cellular' || /(^|-)2g$|3g/.test(c.effectiveType || '');
}

/** Camera/mic limits for a call. Saver: small picture, low frame rate. */
export function callMediaConstraints(saver, facingMode, withVideo) {
  return {
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: !withVideo ? false
      : saver
        ? { facingMode, width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15, max: 15 } }
        : { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
  };
}

/** Upper bounds on what is sent, in bits per second. Audio stays clear either way. */
export function senderLimits(saver) {
  return saver
    ? { audio: 24_000, video: 150_000, maxFramerate: 15 }
    : { audio: 48_000, video: 1_200_000, maxFramerate: 30 };
}

/** Apply the limits to every sender of a live call. Safe to call again when the setting changes. */
export async function applySenderLimits(pc, saver) {
  if (!pc) return;
  const limits = senderLimits(saver);
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
        if (saver) enc.scaleResolutionDownBy = 1;
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
