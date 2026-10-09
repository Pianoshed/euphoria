// Browser-side shrinking so uploads are small and videos never exceed 15 seconds.
export const MAX_VIDEO_SECONDS = 15;
const MAX_VIDEO_BYTES = 6 * 1024 * 1024;

export function shrinkImage(file, maxSide = 1080, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, maxSide / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not shrink this photo.'))), 'image/jpeg', quality);
    };
    img.onerror = () => reject(new Error('This file is not a readable image.'));
    img.src = url;
  });
}

// Plays the clip and re-records at most 15s at a low bitrate (needs captureStream + MediaRecorder).
// Browsers without them (older Safari) can only send clips already under 15s and 6 MB.
export async function shrinkVideo(file) {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.src = url;
  v.playsInline = true;
  await new Promise((ok, bad) => {
    v.onloadedmetadata = ok;
    v.onerror = () => bad(new Error('This video could not be read.'));
  });
  const length = v.duration;
  const capture = v.captureStream || v.mozCaptureStream;
  if (!capture || typeof MediaRecorder === 'undefined') {
    URL.revokeObjectURL(url);
    if (length <= MAX_VIDEO_SECONDS && file.size <= MAX_VIDEO_BYTES) return { blob: file, duration: Math.ceil(length) };
    throw new Error('This browser cannot trim videos. Pick a clip under 15 seconds and 6 MB.');
  }
  const seconds = Math.min(length, MAX_VIDEO_SECONDS);
  const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
    .find((t) => MediaRecorder.isTypeSupported(t));
  const rec = new MediaRecorder(capture.call(v), { mimeType, videoBitsPerSecond: 800000, audioBitsPerSecond: 64000 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise((r) => { rec.onstop = r; });
  rec.start(500);
  await v.play().catch(() => { v.muted = true; return v.play(); });
  const stop = () => { if (rec.state !== 'inactive') rec.stop(); v.pause(); };
  v.onended = stop;
  setTimeout(stop, seconds * 1000 + 150);
  await stopped;
  URL.revokeObjectURL(url);
  const blob = new Blob(chunks, { type: mimeType.split(';')[0] });
  if (blob.size > MAX_VIDEO_BYTES) throw new Error('This clip is still too large. Try a shorter or simpler one.');
  return { blob, duration: Math.max(1, Math.ceil(seconds)) };
}
