import { useEffect, useRef, useState } from 'react';

/**
 * A flat-illustration helicopter that crosses the page once, towing a banner and dropping
 * hearts, confetti and little parachute parcels.
 *
 * What makes it feel natural:
 *  - every flight is random: direction, speed, height and a weaving path (sums of slow sines)
 *  - it pitches nose-down as it speeds up and tilts with climbs and dives, plus a little turbulence
 *  - the banner is NOT glued to the craft: it hangs on a sagging tow rope and follows the exact
 *    path the craft flew a moment ago, so it swings round every bend
 *  - drops leave the hatch with the craft's forward momentum, then slow down and flutter
 *    (hearts wobble, confetti tumbles, parcels swing under their chute)
 *
 * It never catches clicks, and it gets out of the way: any press, tap, scroll or key press
 * makes it fade out at once. It also removes itself when the pass is over.
 * Remount it (change `key`) to fly again. prefers-reduced-motion = it never starts.
 */

const PHRASES = [
  'Gist on the way',
  'Fresh gist, hot off the press',
  'Someone is typing...',
  'Your crush just got online',
  'New drop, go collect',
  'Plot twist incoming',
  'Reply them, they are waiting',
  'Special delivery, handle with love',
  'Low-flying gist alert',
  'No cap, someone asked about you',
  'Weekend plans loading...',
  'Spill the tea, I will carry it',
  'Cupid air service',
  'Vibes delivered, no delay',
  'Do not leave them on read',
  'Hello from above',
];
const COLORS = ['#e8451f', '#2d3fd1', '#f7b928', '#d63471', '#6a3de8'];

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---- geometry of the art (viewBox "-12 8 262 118", faces left) ----
const ART_W = 262;
const ART_H = 118;
const TAIL = { x: 0.962, y: 0.356 };   // where the tow rope hooks on (fraction of the craft box)
const HATCH = { x: 0.382, y: 0.839 };  // where drops come out
const BANNER = { w: 200, h: 46 };

const heartSvg = (c) => `<svg viewBox="0 0 24 22" width="22" height="20"><path d="M12 21C5 15.5 1 12 1 7.2 1 3.9 3.6 1.5 6.6 1.5c2.2 0 4.1 1.2 5.4 3.1 1.3-1.9 3.2-3.1 5.4-3.1C20.4 1.5 23 3.9 23 7.2c0 4.8-4 8.3-11 13.8Z" fill="${c}"/></svg>`;
const parcelSvg = (c) => `<svg viewBox="0 0 44 64" width="38" height="55"><path d="M3 22C3 10 11 2 22 2s19 8 19 20c-4-3-8-3-11 0-3-3-5-3-8 0-3-3-5-3-8 0-3-3-7-3-11 0Z" fill="${c}"/><path d="M22 2c-4 4-5 12-5 20M22 2c4 4 5 12 5 20" stroke="#fff" stroke-opacity=".55" stroke-width="1.5" fill="none"/><path d="M5 22 18 46M22 22v24M39 22 26 46" stroke="#1f1d3d" stroke-width="1.2" fill="none"/><rect x="14" y="46" width="16" height="14" rx="1.5" fill="#f7b928"/><path d="M22 46v14M14 53h16" stroke="#e8451f" stroke-width="2"/></svg>`;
const confettiSvg = (c, shape) => (shape === 0
  ? `<svg viewBox="0 0 10 14" width="9" height="13"><rect width="10" height="14" rx="1" fill="${c}"/></svg>`
  : shape === 1
    ? `<svg viewBox="0 0 12 12" width="11" height="11"><circle cx="6" cy="6" r="6" fill="${c}"/></svg>`
    : `<svg viewBox="0 0 16 8" width="15" height="7"><rect width="16" height="8" rx="2" fill="${c}"/></svg>`);

const DROP_SIZE = { heart: [22, 20], parcel: [38, 55], confetti: [11, 11] };

function ChopperArt() {
  return (
    <svg className="chopper__svg" viewBox="-12 8 262 118" aria-hidden="true">
      {/* tail boom, fin, stabiliser */}
      <path d="M150 62 L232 52 L232 68 L150 80Z" fill="#2d3fd1" />
      <path d="M150 62 L232 52 L232 57 L150 67Z" fill="#fff" opacity=".16" />
      <path d="M200 63 L222 59 L222 65 L206 70Z" fill="#1f1d3d" opacity=".85" />
      <path d="M222 44 L240 34 L240 70 L226 68Z" fill="#e8451f" />
      <circle className="chopper__beacon" cx="239" cy="36" r="2.6" fill="#ff3b30" />

      {/* tail rotor with its blur disc */}
      <g transform="translate(240 56)">
        <circle r="15" fill="#1f1d3d" opacity=".09" />
        <g className="chopper__tail"><rect x="-2.5" y="-16" width="5" height="32" rx="2.5" fill="#1f1d3d" /></g>
      </g>

      {/* main rotor: blur disc + spinning blade, mast and hub */}
      <ellipse cx="90" cy="16.5" rx="102" ry="3.6" fill="#1f1d3d" opacity=".1" />
      <g className="chopper__rotor"><rect x="-8" y="14" width="196" height="5" rx="2.5" fill="#1f1d3d" /></g>
      <rect x="88" y="19" width="6" height="14" fill="#1f1d3d" />
      <rect x="84" y="15.5" width="14" height="5" rx="2" fill="#1f1d3d" />

      {/* cabin */}
      <path d="M24 78C24 52 52 32 94 32c42 0 68 16 72 40 2 12-2 26-12 34H46C32 106 24 94 24 78Z" fill="#e8451f" />
      <path d="M30 98c4 5 9 8 16 8h108c6-4 10-9 12-15-30 9-92 12-136 7Z" fill="#000" opacity=".12" />
      <path d="M26 88h134c-1 5-3 9-6 12H34c-4-3-7-7-8-12Z" fill="#f7b928" />
      {/* windscreen, glare, pilot */}
      <path d="M34 76c0-14 14-26 38-28 6 0 10 4 10 10v22H40c-4 0-6-2-6-4Z" fill="#dce6ee" />
      <path d="M43 68 60 53" stroke="#fff" strokeOpacity=".75" strokeWidth="3" strokeLinecap="round" />
      <circle cx="58" cy="66" r="9" fill="#a8623a" />
      <path d="M49 63c2-7 14-8 18 0-5-2-12-2-18 0Z" fill="#1f1d3d" />
      <rect x="52" y="63" width="14" height="5" rx="2.5" fill="#1f1d3d" />
      <path d="M54 72q4 3 8 0" stroke="#fff" strokeWidth="1.4" fill="none" strokeLinecap="round" />
      {/* side door */}
      <path d="M94 50h40c8 0 14 6 14 14v22H94Z" fill="#f4562a" />
      <rect x="104" y="58" width="30" height="16" rx="4" fill="#dce6ee" />
      <rect x="124" y="82" width="12" height="3" rx="1.5" fill="#1f1d3d" />

      {/* skids */}
      <path d="M40 116h112" stroke="#1f1d3d" strokeWidth="4" strokeLinecap="round" />
      <path d="M60 106v10M128 106v10" stroke="#1f1d3d" strokeWidth="3" />
      <path d="M152 116c8 0 12-4 14-10" stroke="#1f1d3d" strokeWidth="4" strokeLinecap="round" fill="none" />
      {/* cargo hatch the drops come out of */}
      <rect x="76" y="106" width="24" height="3" fill="#1f1d3d" />
    </svg>
  );
}

function BannerArt({ phrase, dir }) {
  const flip = dir > 0; // flying right: banner trails to the left, so the swallowtail goes left
  const len = Math.min(150, Math.round(phrase.length * 7.2));
  return (
    <svg viewBox={`0 0 ${BANNER.w} ${BANNER.h}`} width="100%" height="100%" overflow="visible" aria-hidden="true">
      <g className={`chopper__cloth${flip ? ' chopper__cloth--r' : ''}`}>
        <g transform={flip ? `translate(${BANNER.w} 0) scale(-1 1)` : undefined}>
          <path d="M0 6 L200 10 L183 23 L200 36 L0 40Z" fill="#f7b928" />
          <path d="M0 6 L200 10 L183 23 L200 36 L0 40" stroke="#1f1d3d" strokeWidth="1.4" fill="none" strokeLinejoin="round" />
          <path d="M2 11 L190 14" stroke="#fff" strokeOpacity=".4" strokeWidth="1.6" />
        </g>
        <text
          x={flip ? 106 : 94} y="27" textAnchor="middle"
          fontFamily="Sora, sans-serif" fontWeight="800" fontSize="12.5" fill="#1f1d3d"
          textLength={len} lengthAdjust="spacingAndGlyphs"
        >{phrase}</text>
      </g>
    </svg>
  );
}

export default function Chopper() {
  const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const [gone, setGone] = useState(reduced);
  const [flight] = useState(() => {
    const W = typeof window !== 'undefined' ? window.innerWidth : 390;
    const cw = clamp(W * 0.24, 150, 300);
    const bw = cw * 1.3;
    return {
      phrase: pick(PHRASES),
      dir: Math.random() < 0.5 ? -1 : 1, // -1 = flies right-to-left, 1 = left-to-right
      cw, ch: cw * (ART_H / ART_W), bw, bh: bw * (BANNER.h / BANNER.w),
    };
  });
  const stageRef = useRef(null);
  const craftRef = useRef(null);
  const bannerRef = useRef(null);
  const ropeRef = useRef(null);

  useEffect(() => {
    if (gone) return undefined;
    const stage = stageRef.current;
    const craftEl = craftRef.current;
    const bannerEl = bannerRef.current;
    const ropeEl = ropeRef.current;
    if (!stage || !craftEl || !bannerEl || !ropeEl) return undefined;

    const { dir, cw, ch, bw, bh } = flight;
    const W = window.innerWidth;
    const H = window.innerHeight;
    const dur = rand(7.5, 10.5);                              // seconds to cross, roughly
    const base = (W + cw * 1.5 + bw) / dur;                   // px per second
    const yMin = 76;                                          // stay clear of the top bar
    const yMax = Math.max(yMin + 60, H * 0.58);
    const y0 = rand(yMin + 24, yMax - 24);
    const A1 = rand(6, 14), A2 = rand(14, 34), drift = rand(-9, 9);
    const p = Array.from({ length: 6 }, () => rand(0, Math.PI * 2));
    const lag = clamp((cw * 0.45) / base, 0.3, 1.2);          // how far behind the banner hangs
    const tailFx = dir < 0 ? TAIL.x : 1 - TAIL.x;
    const hatchFx = dir < 0 ? HATCH.x : 1 - HATCH.x;

    let t = 0;
    let x = dir < 0 ? W + 8 : -cw - 8;
    const yAt = (tt) => clamp(
      y0 + A1 * Math.sin(1.1 * tt + p[0]) + A2 * Math.sin(0.45 * tt + p[1]) + drift * tt + 1.2 * Math.sin(9 * tt + p[2]),
      yMin, yMax,
    );
    let y = yAt(0);
    let svy = 0;
    let ang = 0;
    // path history, seeded behind the start so the banner has somewhere to hang from at t = 0
    const hist = [{ t: -4, x: x - dir * base * 4, y }, { t: 0, x, y }];
    const at = (tt) => {
      for (let i = hist.length - 1; i > 0; i -= 1) {
        const a = hist[i - 1], b = hist[i];
        if (tt >= a.t) { const k = b.t === a.t ? 1 : (tt - a.t) / (b.t - a.t); return { x: a.x + (b.x - a.x) * Math.min(1, k), y: a.y + (b.y - a.y) * Math.min(1, k) }; }
      }
      return hist[0];
    };

    const drops = [];
    let spawned = 0, parcels = 0, nextDrop = rand(0.7, 1.0);
    const spawn = (hx, hy, vx) => {
      const r = Math.random();
      const kind = r < 0.4 ? 'heart' : r < 0.78 || parcels >= 3 ? 'confetti' : 'parcel';
      if (kind === 'parcel') parcels += 1;
      const color = COLORS[spawned % COLORS.length];
      const el = document.createElement('span');
      el.className = `drop drop--${kind}`;
      el.setAttribute('aria-hidden', 'true');
      const body = document.createElement('span');
      body.className = 'drop__body';
      body.innerHTML = kind === 'heart' ? heartSvg(color) : kind === 'parcel' ? parcelSvg(color) : confettiSvg(color, spawned % 3);
      el.appendChild(body);
      stage.appendChild(el);
      spawned += 1;
      drops.push({
        el, body, kind, age: 0, x: hx, y: hy, w: DROP_SIZE[kind][0],
        vx: vx * 0.75, vy: 30, wind: rand(-12, 12),
        term: kind === 'parcel' ? rand(68, 85) : kind === 'heart' ? rand(80, 112) : rand(95, 140),
        k: kind === 'parcel' ? 1.8 : 1.1,
        sway: kind === 'parcel' ? 8 : kind === 'heart' ? 10 : 14,
        freq: rand(1.8, 3.2), ph: rand(0, Math.PI * 2), spin: rand(180, 420) * (Math.random() < 0.5 ? -1 : 1),
      });
    };

    let rafId = 0;
    let last = performance.now();
    let leaving = false;
    let timer = 0;
    let stopped = false;

    const frame = (now) => {
      if (stopped) return;
      const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
      last = now;
      t += dt;

      // ---- craft: weaving path, speed that breathes, pitch that follows the climb ----
      const sp = base * (1 + 0.18 * Math.sin(0.9 * t + p[3]));
      x += dir * sp * dt;
      const prevY = y;
      y = yAt(t);
      svy += ((y - prevY) / dt - svy) * Math.min(1, dt * 4);
      const climb = (Math.atan2(svy, sp) * 180) / Math.PI;   // + = descending
      const noseDown = 4 + clamp(climb * 0.7, -7, 9) + Math.sin(2.3 * t + p[4]);
      ang += (noseDown * dir - ang) * Math.min(1, dt * 5);
      craftEl.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0) rotate(${ang.toFixed(2)}deg)`;

      const rad = (ang * Math.PI) / 180;
      const cos = Math.cos(rad), sin = Math.sin(rad);
      const world = (fx, fy) => {
        const rx = fx * cw - cw / 2, ry = fy * ch - ch / 2;
        return { x: x + cw / 2 + rx * cos - ry * sin, y: y + ch / 2 + rx * sin + ry * cos };
      };

      // ---- banner: hangs from the tail on a rope, follows the path flown `lag` seconds ago ----
      hist.push({ t, x, y });
      while (hist.length > 3 && hist[1].t < t - lag - 1) hist.shift();
      const T = world(tailFx, TAIL.y);
      const d = at(t - lag);
      const B = { x: d.x + tailFx * cw, y: d.y + TAIL.y * ch };
      const dx = B.x - T.x, dy = B.y - T.y;
      const dist = Math.hypot(dx, dy) || 1;
      const ux = dx / dist, uy = dy / dist;
      const flutter = 2.5 * Math.sin(t * 6 + p[5]);
      const theta = (dir < 0 ? Math.atan2(uy, ux) : Math.atan2(-uy, -ux)) * (180 / Math.PI) + flutter;
      const ax = dir < 0 ? 0 : bw;
      bannerEl.style.transform = `translate3d(${(B.x - ax).toFixed(1)}px,${(B.y - bh / 2).toFixed(1)}px,0) rotate(${theta.toFixed(2)}deg)`;
      ropeEl.setAttribute('d', `M${T.x.toFixed(1)} ${T.y.toFixed(1)} Q${((T.x + B.x) / 2).toFixed(1)} ${((T.y + B.y) / 2 + 4 + dist * 0.1).toFixed(1)} ${B.x.toFixed(1)} ${B.y.toFixed(1)}`);

      // ---- drops: leave the hatch with the craft's momentum, then slow and flutter ----
      const hatch = world(hatchFx, HATCH.y);
      nextDrop -= dt;
      if (!leaving && t > 0.8 && nextDrop <= 0 && hatch.x > W * 0.06 && hatch.x < W * 0.94 && drops.length < 10) {
        spawn(hatch.x, hatch.y, dir * sp);
        nextDrop = rand(0.4, 0.85);
      }
      for (let i = drops.length - 1; i >= 0; i -= 1) {
        const o = drops[i];
        o.age += dt;
        o.vy += (o.term - o.vy) * Math.min(1, dt * o.k);
        o.vx += (o.wind - o.vx) * Math.min(1, dt * 1.3);
        o.x += o.vx * dt;
        o.y += o.vy * dt;
        const sx = Math.sin(o.age * o.freq + o.ph) * o.sway;
        const fadeEnd = o.y > H * 0.86 ? clamp((H + 24 - o.y) / (H * 0.14 + 24), 0, 1) : 1;
        o.el.style.transform = `translate3d(${(o.x + sx - o.w / 2).toFixed(1)}px,${o.y.toFixed(1)}px,0)`;
        o.el.style.opacity = String(Math.min(1, o.age / 0.15) * fadeEnd);
        if (o.kind === 'heart') o.body.style.transform = `rotate(${(Math.sin(o.age * 3 + o.ph) * 14).toFixed(1)}deg)`;
        else if (o.kind === 'parcel') o.body.style.transform = `rotate(${(Math.sin(o.age * 2.2 + o.ph) * 9).toFixed(1)}deg)`;
        else o.body.style.transform = `rotate(${(o.age * o.spin).toFixed(0)}deg) scaleX(${Math.cos(o.age * 6 + o.ph).toFixed(2)})`;
        if (o.y > H + 30 || o.age > 14) { o.el.remove(); drops.splice(i, 1); }
      }

      // ---- finished once the banner has cleared the far edge and the last drop has landed ----
      const cleared = dir < 0 ? B.x + bw < -20 : B.x - bw > W + 20;
      if ((t > 2 && cleared && drops.length === 0) || t > 25) { stopped = true; setGone(true); return; }
      rafId = requestAnimationFrame(frame);
    };

    // get out of the way: any press, scroll or key fades it out quickly
    const leave = () => {
      if (leaving) return;
      leaving = true;
      stage.classList.add('chopper--leaving');
      timer = window.setTimeout(() => { stopped = true; cancelAnimationFrame(rafId); setGone(true); }, 280);
    };
    const onHide = () => { if (document.hidden) leave(); };
    const events = ['pointerdown', 'touchstart', 'wheel', 'keydown'];
    const arm = window.setTimeout(() => {
      events.forEach((e) => window.addEventListener(e, leave, { capture: true, passive: true }));
    }, 250);
    document.addEventListener('visibilitychange', onHide);

    rafId = requestAnimationFrame((now) => { last = now; frame(now); });

    return () => {
      stopped = true;
      cancelAnimationFrame(rafId);
      window.clearTimeout(arm);
      window.clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, leave, { capture: true }));
      document.removeEventListener('visibilitychange', onHide);
      drops.forEach((o) => o.el.remove());
    };
  }, [flight, gone]);

  if (gone) return null;

  const { dir, cw, ch, bw, bh, phrase } = flight;
  const parked = { transform: 'translate3d(-9999px,0,0)' };
  return (
    <div className="chopper" ref={stageRef} aria-hidden="true">
      <svg className="chopper__rope"><path ref={ropeRef} d="M0 0" /></svg>
      <div
        className="chopper__banner"
        ref={bannerRef}
        style={{ width: bw, height: bh, transformOrigin: `${dir < 0 ? 0 : bw}px ${bh / 2}px`, ...parked }}
      >
        <BannerArt phrase={phrase} dir={dir} />
      </div>
      <div className="chopper__craft" ref={craftRef} style={{ width: cw, height: ch, ...parked }}>
        <div className="chopper__flip" style={{ transform: dir > 0 ? 'scaleX(-1)' : undefined }}>
          <ChopperArt />
        </div>
      </div>
    </div>
  );
}
