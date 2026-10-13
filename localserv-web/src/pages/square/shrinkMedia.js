// Browser-side shrinking so uploads stay small. Statuses are now photos or photo slideshows (with music);
// the old video trimmer is gone, which also drops MediaRecorder/captureStream work from the phone.
// Every status, whatever it is, plays for at most 15 seconds.
export const MAX_STATUS_SECONDS = 15;
export const MAX_VIDEO_SECONDS = MAX_STATUS_SECONDS; // old video statuses still play in the viewer, capped at 15s
export const MIN_SLIDE_SECONDS = 2;
export const MAX_SLIDE_SECONDS = 6;
export const DEFAULT_SLIDE_SECONDS = 3;
// 7 photos x 2s = 14s is the most that fits inside 15s (the server itself accepts 8, which would be 16s).
export const MAX_SLIDES = Math.floor(MAX_STATUS_SECONDS / MIN_SLIDE_SECONDS);

// Longest each photo may show so the whole slideshow stays within 15s.
export const maxSlideSeconds = (count) =>
  Math.max(MIN_SLIDE_SECONDS, Math.min(MAX_SLIDE_SECONDS, Math.floor(MAX_STATUS_SECONDS / Math.max(1, count))));

// Run one photo at a time (never Promise.all): only one decoded bitmap is in memory at once.
export function shrinkImage(file, maxSide = 1280, quality = 0.8) {
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
      c.toBlob((b) => {
        c.width = c.height = 0; // let the browser free the canvas bitmap right away
        if (b) resolve(b); else reject(new Error('Could not shrink this photo.'));
      }, 'image/jpeg', quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('This file is not a readable image.')); };
    img.src = url;
  });
}

// How a slideshow looks. The ids are exactly what the backend accepts (apps/square/media.py TEMPLATES / CANVASES).
export const SHOW_TEMPLATES = [
  { id: 'fade', label: 'Fade' },
  { id: 'drift', label: 'Drift' },
  { id: 'slide', label: 'Slide' },
  { id: 'pop', label: 'Pop' },
  { id: 'cinema', label: 'Cinema' },
  { id: 'burst', label: 'Burst' },
  { id: 'spin', label: 'Spin' },
  { id: 'flip', label: 'Flip' },
  { id: 'curtain', label: 'Curtain' },
  { id: 'flash', label: 'Flash' },
  { id: 'swing', label: 'Swing' },
  { id: 'zoomout', label: 'Zoom out' },
];
export const SHOW_CANVASES = [
  { id: 'blur', label: 'Blur' },
  { id: 'fill', label: 'Full' },
  { id: 'frame', label: 'Polaroid' },
  { id: 'night', label: 'Dark' },
];
export const DEFAULT_TEMPLATE = 'fade';
export const DEFAULT_CANVAS = 'blur';
