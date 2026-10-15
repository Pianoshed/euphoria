// Draws one slide of a status as a 1080x1920 picture with the site logo baked in as a small watermark, so a status
// that is shared outside the app still says where it came from. Mirrors the four on-screen canvases (blur/fill/frame/night).
import { Capacitor, CapacitorHttp } from '@capacitor/core';
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
// Inside the Android app the page runs from https://localhost, so a browser fetch() to your media host is a
// cross-origin request that needs the host's CORS rule. CapacitorHttp makes the request natively instead, where
// CORS does not apply, so photos load even if the bucket's rule does not list the app yet.
async function nativePhotoBlob(url) {
  const res = await CapacitorHttp.get({ url, responseType: 'blob' });
  if (res.status < 200 || res.status >= 300) throw new Error(`http-${res.status}`);
  const bin = atob(res.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  const h = res.headers || {};
  return new Blob([bytes], { type: h['Content-Type'] || h['content-type'] || 'image/jpeg' });
}

async function fetchPhotoBlob(url) {
  if (Capacitor.isNativePlatform() && /^https?:/i.test(url)) {
    try { return await nativePhotoBlob(url); } catch (e) {
      if (String(e?.message).startsWith('http-')) throw e;
      console.warn('Status picture: native fetch failed, trying the browser fetch', e);
    }
  }
  // Photos are cached for a day ("immutable"). A copy cached by a plain <img> has no CORS headers, and a CORS fetch
  // can be handed that copy and fail even when the bucket is set up right, so on failure try once more bypassing the cache.
  let res;
  try { res = await fetch(url, { mode: 'cors', credentials: 'omit' }); } catch (e1) {
    try { res = await fetch(url, { mode: 'cors', credentials: 'omit', cache: 'reload' }); } catch (e2) {
      console.warn('Status picture: the media host blocked the fetch (CORS rule missing on the bucket?)', url.split('?')[0], e2);
      throw new Error('cors');
    }
  }
  if (!res.ok) { console.warn('Status picture: photo request failed', res.status, url.split('?')[0]); throw new Error(`http-${res.status}`); }
  return res.blob();
}

// Decode a blob to something drawable. createImageBitmap decodes off the main thread (faster, no jank); old browsers use <img>.
async function decodePhoto(blob) {
  try {
    if (typeof createImageBitmap === 'function') return await createImageBitmap(blob);
  } catch { /* fall through to <img> */ }
  const obj = URL.createObjectURL(blob);
  try { return await loadImg(obj); } catch (e) { console.warn('Status picture: a photo could not be decoded', e); throw new Error('decode'); } finally { setTimeout(() => URL.revokeObjectURL(obj), 4000); }
}

async function loadPhoto(url) { return decodePhoto(await fetchPhotoBlob(url)); }

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

function watermark(ctx, logo, shade = true) {
  if (shade) {
    const g = ctx.createLinearGradient(0, H - 380, 0, H);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,.4)');
    ctx.fillStyle = g;
    ctx.fillRect(0, H - 380, W, 380);
  }
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
  return toJpeg(c);
}

const toJpeg = (c, q = 0.88) => new Promise((resolve, reject) => {
  c.toBlob((b) => { c.width = c.height = 0; if (b) resolve(b); else reject(new Error('blob')); }, 'image/jpeg', q);
});

// ---- Collage designs ----------------------------------------------------------------------------------------------
// Every share picks a random layout for its photo count (1..8) and a random colour scheme, so no two look alike.
// R = rows (each [height share, photos in that row]); C = the same turned sideways (columns).
const R = (rows) => rows.flatMap(([h, k], r) => {
  const y = rows.slice(0, r).reduce((a, x) => a + x[0], 0);
  return Array.from({ length: k }, (_, c) => [c / k, y, 1 / k, h]);
});
const C = (cols) => R(cols).map(([x, y, w, h]) => [y, x, h, w]);
const LAYOUTS = {
  1: [R([[1, 1]])],
  2: [R([[.5, 1], [.5, 1]]), C([[.5, 1], [.5, 1]]), R([[.64, 1], [.36, 1]]), R([[.36, 1], [.64, 1]])],
  3: [R([[.5, 1], [.5, 2]]), R([[.5, 2], [.5, 1]]), R([[1 / 3, 1], [1 / 3, 1], [1 / 3, 1]]), C([[.55, 1], [.45, 2]]), C([[.45, 2], [.55, 1]])],
  4: [R([[.5, 2], [.5, 2]]), R([[.55, 1], [.45, 3]]), R([[.45, 3], [.55, 1]]), C([[.55, 1], [.45, 3]]), R([[.25, 1], [.25, 1], [.25, 1], [.25, 1]])],
  5: [R([[.4, 2], [.6, 3]]), R([[.6, 2], [.4, 3]]), R([[.5, 1], [.5, 4]]), R([[.34, 2], [.33, 1], [.33, 2]]), C([[.4, 2], [.6, 3]])],
  6: [R([[1 / 3, 2], [1 / 3, 2], [1 / 3, 2]]), R([[.5, 3], [.5, 3]]), R([[.4, 1], [.3, 2], [.3, 3]]), C([[.5, 3], [.5, 3]]), R([[.3, 3], [.4, 1], [.3, 2]])],
  7: [R([[.28, 1], [.36, 3], [.36, 3]]), R([[.25, 2], [.25, 2], [.25, 2], [.25, 1]]), R([[.3, 2], [.3, 2], [.4, 3]]), C([[.3, 1], [.35, 3], [.35, 3]])],
  8: [R([[.25, 2], [.25, 2], [.25, 2], [.25, 2]]), R([[.5, 4], [.5, 4]]), R([[.34, 2], [.33, 3], [.33, 3]]), C([[.5, 4], [.5, 4]]), R([[.4, 1], [.2, 3], [.2, 2], [.2, 2]])],
};
// background gradient [top, bottom], plus a glow colour. All darkish so the logo (blended with 'screen') stays visible.
const PALETTES = [
  { bg: ['#3a1c71', '#0b0818'], glow: 'rgba(161,106,232,.7)' },   // lilac night
  { bg: ['#7a1f3d', '#1a0a14'], glow: 'rgba(231,106,82,.7)' },    // coral wine
  { bg: ['#12306b', '#060c1e'], glow: 'rgba(66,99,235,.7)' },     // electric blue
  { bg: ['#0f4c45', '#04120f'], glow: 'rgba(60,220,170,.55)' },   // deep mint
  { bg: ['#8a3a12', '#1c0b04'], glow: 'rgba(255,170,80,.6)' },    // sunset amber
  { bg: ['#5b1a6e', '#12051a'], glow: 'rgba(255,90,200,.55)' },   // plum pink
  { bg: ['#1f2937', '#05070a'], glow: 'rgba(148,163,184,.45)' },  // graphite
];
const pick = (a) => a[Math.floor(Math.random() * a.length)];

function rr(ctx, x, y, w, h, r) {
  const k = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k);
  ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k);
  ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}

// Phone-sized sheet: 720x1280 is about 4x fewer pixels than 1080x1920, so it draws and uploads quickly and still
// looks sharp on a phone. The collage sits above a clear strip that holds the logo, so the mark is big and obvious
// but never covers a photo.
const CW = 720;
const CH = 1280;
const STRIP = 150;

function collageMark(ctx, logo) {
  const cx = CW / 2;
  const cy = CH - STRIP / 2 + 6;
  if (logo) {
    let w = 330;
    let h = w * (logo.height / logo.width);
    if (h > STRIP - 40) { h = STRIP - 40; w = h * (logo.width / logo.height); }
    ctx.save();
    ctx.globalCompositeOperation = 'screen'; // the dark-surface logo has a black background; 'screen' makes it vanish
    ctx.drawImage(logo, cx - w / 2, cy - h / 2, w, h);
    ctx.restore();
  } else {
    ctx.save();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '800 72px system-ui, -apple-system, sans-serif';
    ctx.fillText('hiclr', cx, cy);
    ctx.restore();
  }
}

// All the photos of a status on ONE picture (so one share carries the lot), random layout + colours, logo watermark.
// Speed: the photos download at the same time (they are small, ~100 KB each); the only big buffer is one 720x1280 canvas.
export async function statusCollageBlob(urls) {
  const list = urls.slice(0, 8);
  const n = list.length;
  const pal = pick(PALETTES);
  const margin = pick([16, 26, 38]);
  const gap = pick([8, 12, 18]);
  const radius = pick([0, 20, 36]);
  const area = { x: margin, y: margin, w: CW - margin * 2, h: CH - margin - STRIP };
  const layout = pick(LAYOUTS[n] || LAYOUTS[8]);

  // start everything that needs the network now, then draw as the bytes arrive
  const logoP = loadImg(BRAND_ASSETS.logoDark).catch(() => null);
  const blobsP = list.map((u) => fetchPhotoBlob(u));
  blobsP.forEach((p) => p.catch(() => {})); // errors are reported below, in order

  const c = document.createElement('canvas');
  c.width = CW; c.height = CH;
  const ctx = c.getContext('2d');
  const bg = ctx.createLinearGradient(0, 0, CW * 0.4, CH);
  bg.addColorStop(0, pal.bg[0]); bg.addColorStop(1, pal.bg[1]);
  ctx.fillStyle = bg; ctx.fillRect(0, 0, CW, CH);
  const gx = Math.random() > 0.5 ? CW * 0.15 : CW * 0.85;
  const glow = ctx.createRadialGradient(gx, CH * 0.1, 0, gx, CH * 0.1, CW * 0.95);
  glow.addColorStop(0, pal.glow); glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, CW, CH);

  for (let k = 0; k < n; k += 1) {
    const img = await decodePhoto(await blobsP[k]); // one decoded photo in memory at a time
    const [ux, uy, uw, uh] = layout[k];
    const x = area.x + ux * area.w + gap / 2 * (ux > 0.001 ? 1 : 0);
    const y = area.y + uy * area.h + gap / 2 * (uy > 0.001 ? 1 : 0);
    const w = uw * area.w - gap / 2 * ((ux > 0.001 ? 1 : 0) + (ux + uw < 0.999 ? 1 : 0));
    const h = uh * area.h - gap / 2 * ((uy > 0.001 ? 1 : 0) + (uy + uh < 0.999 ? 1 : 0));
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.4)'; ctx.shadowBlur = 16; ctx.shadowOffsetY = 5;
    rr(ctx, x, y, w, h, radius); ctx.fillStyle = '#000'; ctx.fill();
    ctx.shadowColor = 'transparent';
    rr(ctx, x, y, w, h, radius); ctx.clip();
    if (n === 1) { // a lone photo is shown whole (not cropped), on a blurred copy of itself
      const t = document.createElement('canvas');
      t.width = 36; t.height = Math.max(8, Math.round(36 * (h / w)));
      place(t.getContext('2d'), img, 0, 0, t.width, t.height, 'cover');
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(t, x, y, w, h);
      ctx.fillStyle = 'rgba(8,6,20,.35)'; ctx.fillRect(x, y, w, h);
      place(ctx, img, x, y, w, h, 'contain');
    } else place(ctx, img, x, y, w, h, 'cover');
    ctx.restore();
    if (img.close) img.close(); else img.src = ''; // free the decoded photo before the next one
  }
  collageMark(ctx, await logoP);
  return toJpeg(c, 0.86);
}

export const statusFileName = (status) => `hiclr-status-${status.id}.jpg`;
