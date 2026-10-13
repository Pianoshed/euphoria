// Draws one slide of a status as a 1080x1920 picture with the site logo baked in as a small watermark, so a status
// that is shared outside the app still says where it came from. Mirrors the four on-screen canvases (blur/fill/frame/night).
import { BRAND_ASSETS } from '../../brand';

const W = 1080;
const H = 1920;

const loadImg = (src) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error('image'));
  img.src = src;
});

// fetch() as a blob first: a cross-origin <img> would taint the canvas and toBlob() would throw. This needs the media
// host to send Access-Control-Allow-Origin (same as any CDN image you draw on a canvas).
async function loadPhoto(url) {
  const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
  if (!res.ok) throw new Error('image');
  const obj = URL.createObjectURL(await res.blob());
  try { return await loadImg(obj); } finally { setTimeout(() => URL.revokeObjectURL(obj), 4000); }
}

function place(ctx, img, x, y, w, h, mode) {
  const k = (mode === 'cover' ? Math.max : Math.min)(w / img.width, h / img.height);
  const dw = img.width * k;
  const dh = img.height * k;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

function blurBackdrop(ctx, img) {
  // shrink then stretch back: a cheap blur that works in every browser (ctx.filter is missing on older iOS)
  const s = document.createElement('canvas');
  s.width = 36; s.height = 64;
  place(s.getContext('2d'), img, 0, 0, 36, 64, 'cover');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(s, 0, 0, W, H);
  ctx.fillStyle = 'rgba(8,6,20,.4)';
  ctx.fillRect(0, 0, W, H);
}

function watermark(ctx, logo) {
  const g = ctx.createLinearGradient(0, H - 380, 0, H);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,.4)');
  ctx.fillStyle = g;
  ctx.fillRect(0, H - 380, W, 380);
  ctx.save();
  if (logo) {
    const w = 250;
    const h = w * (logo.height / logo.width);
    ctx.globalCompositeOperation = 'screen'; // the dark-surface logo has a black background; 'screen' makes it vanish
    ctx.globalAlpha = 0.92;
    ctx.drawImage(logo, W - w - 56, H - h - 64, w, h);
  } else {
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'right';
    ctx.font = '800 76px system-ui, -apple-system, sans-serif';
    ctx.shadowColor = 'rgba(0,0,0,.55)';
    ctx.shadowBlur = 14;
    ctx.fillText('hiclr', W - 64, H - 84);
  }
  ctx.restore();
}

export async function statusFrameBlob(url, canvasKind = 'blur') {
  const [img, logo] = await Promise.all([loadPhoto(url), loadImg(BRAND_ASSETS.logoDark).catch(() => null)]);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');

  if (canvasKind === 'fill') {
    place(ctx, img, 0, 0, W, H, 'cover');
  } else if (canvasKind === 'frame') {
    const bg = ctx.createLinearGradient(0, 0, W * 0.5, H);
    bg.addColorStop(0, '#2b1a63'); bg.addColorStop(1, '#0b0818');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    const glow = ctx.createRadialGradient(W * 0.25, H * 0.15, 0, W * 0.25, H * 0.15, W * 0.8);
    glow.addColorStop(0, 'rgba(138,61,224,.75)'); glow.addColorStop(1, 'rgba(138,61,224,0)');
    ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);
    const y = H * 0.09; const w = W * 0.82; const h = H * 0.77; const pad = w * 0.035;
    ctx.save();
    ctx.translate(W / 2, y + h / 2); ctx.rotate((-2 * Math.PI) / 180);
    ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = 50; ctx.shadowOffsetY = 18;
    ctx.fillStyle = '#fff'; ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = '#eee'; ctx.fillRect(-w / 2 + pad, -h / 2 + pad, w - pad * 2, h - pad * 3.2);
    place(ctx, img, -w / 2 + pad, -h / 2 + pad, w - pad * 2, h - pad * 3.2, 'contain');
    ctx.restore();
  } else if (canvasKind === 'night') {
    ctx.fillStyle = '#0b0818'; ctx.fillRect(0, 0, W, H);
    place(ctx, img, 0, 0, W, H, 'contain');
    const v = ctx.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H * 0.72);
    v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,.55)');
    ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
  } else {
    blurBackdrop(ctx, img);
    place(ctx, img, 0, 0, W, H, 'contain');
  }

  watermark(ctx, logo);
  return new Promise((resolve, reject) => {
    c.toBlob((b) => { c.width = c.height = 0; if (b) resolve(b); else reject(new Error('blob')); }, 'image/jpeg', 0.9);
  });
}

export const statusFileName = (status) => `hiclr-status-${status.id}.jpg`;
