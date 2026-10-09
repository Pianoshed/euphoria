import { useMemo, useState } from 'react';

/**
 * A flat-illustration helicopter that crosses the page once, towing a banner
 * and dropping hearts, confetti and little parachute parcels. It uses the same
 * palette as the couples artwork behind the page (orange, blue, yellow, red).
 *
 * The overlay never catches clicks. Remount it (change `playKey`) to replay.
 * Under prefers-reduced-motion the CSS hides the whole thing.
 *
 * The art faces left, so it flies right-to-left with the banner trailing behind it.
 * Timing: the craft's left edge moves linearly from 100vw to -(width + 2vw) in
 * FLIGHT_S seconds, so a drop released at time t is placed at the matching
 * left offset (see dropLeft).
 */

const FLIGHT_S = 4.2; // quick pass; the random banner + height make each flight feel different
const HATCH = 0.355; // the cargo hatch sits this fraction of the craft's width from its left edge

// CSS expression for "where is the hatch at time t". --cw (craft width) is set in inbox.css.
const dropLeft = (t) => `calc(100vw - (102vw + var(--cw)) * ${(t / FLIGHT_S).toFixed(4)} + var(--cw) * ${HATCH})`;

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
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const COLORS = ['#e8451f', '#2d3fd1', '#f7b928', '#d63471', '#6a3de8'];

// Fixed schedule so the drop pattern is the same every render (no Math.random in render).
const DROPS = [
  { t: 0.7, kind: 'heart', fall: 3.2, sway: 14 },
  { t: 1.0, kind: 'confetti', fall: 2.8, sway: 20 },
  { t: 1.3, kind: 'parcel', fall: 4.6, sway: 22 },
  { t: 1.6, kind: 'confetti', fall: 2.9, sway: 18 },
  { t: 1.9, kind: 'heart', fall: 3.4, sway: 16 },
  { t: 2.2, kind: 'confetti', fall: 2.7, sway: 22 },
  { t: 2.5, kind: 'parcel', fall: 4.8, sway: 24 },
  { t: 2.8, kind: 'heart', fall: 3.1, sway: 12 },
  { t: 3.1, kind: 'confetti', fall: 2.8, sway: 18 },
  { t: 3.4, kind: 'heart', fall: 3.2, sway: 14 },
];

function Heart({ color }) {
  return (
    <svg viewBox="0 0 24 22" width="22" height="20" aria-hidden="true">
      <path d="M12 21C5 15.5 1 12 1 7.2 1 3.9 3.6 1.5 6.6 1.5c2.2 0 4.1 1.2 5.4 3.1 1.3-1.9 3.2-3.1 5.4-3.1C20.4 1.5 23 3.9 23 7.2c0 4.8-4 8.3-11 13.8Z" fill={color} />
    </svg>
  );
}

function Parcel({ color }) {
  return (
    <svg viewBox="0 0 44 64" width="40" height="58" aria-hidden="true">
      {/* canopy */}
      <path d="M3 22C3 10 11 2 22 2s19 8 19 20c-4-3-8-3-11 0-3-3-5-3-8 0-3-3-5-3-8 0-3-3-7-3-11 0Z" fill={color} />
      <path d="M22 2c-4 4-5 12-5 20M22 2c4 4 5 12 5 20" stroke="#fff" strokeOpacity=".55" strokeWidth="1.5" fill="none" />
      {/* lines */}
      <path d="M5 22 18 46M22 22v24M39 22 26 46" stroke="#1f1d3d" strokeWidth="1.2" fill="none" />
      {/* box */}
      <rect x="14" y="46" width="16" height="14" rx="1.5" fill="#f7b928" />
      <path d="M22 46v14M14 53h16" stroke="#e8451f" strokeWidth="2" />
    </svg>
  );
}

function Confetti({ color, shape }) {
  return shape === 0 ? (
    <svg viewBox="0 0 10 14" width="9" height="13" aria-hidden="true"><rect width="10" height="14" rx="1" fill={color} /></svg>
  ) : shape === 1 ? (
    <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><circle cx="6" cy="6" r="6" fill={color} /></svg>
  ) : (
    <svg viewBox="0 0 16 8" width="15" height="7" aria-hidden="true"><rect width="16" height="8" rx="2" fill={color} /></svg>
  );
}

function ChopperArt({ phrase }) {
  return (
    <svg className="chopper__svg" viewBox="0 0 580 150" role="img" aria-label={`A helicopter towing a banner that says ${phrase}`}>
      {/* tow rope from the tail to the banner */}
      <path d="M358 58C372 62 380 66 392 70" stroke="#1f1d3d" strokeWidth="1.6" fill="none" />

      {/* banner cloth: pointed end trails away from the craft */}
      <g className="chopper__cloth">
        <path d="M392 52 L568 56 L552 80 L568 104 L392 100Z" fill="#f7b928" />
        <path d="M392 52 L568 56 L552 80 L568 104 L392 100" stroke="#1f1d3d" strokeWidth="1.2" fill="none" strokeLinejoin="round" />
        <text x="402" y="82" fontFamily="Sora, sans-serif" fontWeight="800" fontSize="13" fill="#1f1d3d" textLength={Math.min(138, Math.round(phrase.length * 7.6))} lengthAdjust="spacingAndGlyphs">{phrase}</text>
      </g>

      <g transform="translate(118 8)">
        {/* main rotor */}
        <g className="chopper__rotor">
          <rect x="-8" y="14" width="196" height="5" rx="2.5" fill="#1f1d3d" />
        </g>
        <rect x="88" y="19" width="6" height="14" fill="#1f1d3d" />

        {/* tail boom */}
        <path d="M150 62 L232 52 L232 68 L150 80Z" fill="#2d3fd1" />
        <path d="M222 44 L240 36 L240 70 L226 68Z" fill="#e8451f" />
        {/* tail rotor */}
        <g className="chopper__tail">
          <rect x="233" y="38" width="5" height="32" rx="2.5" fill="#1f1d3d" />
        </g>

        {/* cabin */}
        <path d="M24 78C24 52 52 32 94 32c42 0 68 16 72 40 2 12-2 26-12 34H46C32 106 24 94 24 78Z" fill="#e8451f" />
        {/* stripe */}
        <path d="M26 88h134c-1 5-3 9-6 12H34c-4-3-7-7-8-12Z" fill="#f7b928" />
        {/* window */}
        <path d="M34 76c0-14 14-26 38-28 6 0 10 4 10 10v22H40c-4 0-6-2-6-4Z" fill="#dce6ee" />
        {/* pilot */}
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
      </g>
    </svg>
  );
}

export default function Chopper() {
  // each mount (page load or "send again") gets its own banner words and flight height
  const [flight] = useState(() => ({
    phrase: pick(PHRASES),
    top: `${(6 + Math.random() * 62).toFixed(1)}vh`,
  }));
  const drops = useMemo(
    () =>
      DROPS.map((d, i) => ({
        ...d,
        id: i,
        left: dropLeft(d.t),
        color: COLORS[i % COLORS.length],
        shape: i % 3,
        spin: (i % 2 ? 1 : -1) * (180 + i * 40),
      })),
    []
  );

  return (
    <div className="chopper" style={{ '--top': flight.top }}>
      <div className="chopper__craft" style={{ '--flight': `${FLIGHT_S}s` }}>
        <ChopperArt phrase={flight.phrase} />
      </div>

      {drops.map((d) => (
        <span
          key={d.id}
          className={`drop drop--${d.kind}`}
          style={{
            left: d.left,
            '--delay': `${d.t}s`,
            '--fall': `${d.fall}s`,
            '--sway': `${d.sway}px`,
            '--spin': `${d.spin}deg`,
          }}
          aria-hidden="true"
        >
          <span className="drop__sway">
            <span className="drop__spin">
              {d.kind === 'heart' && <Heart color={d.color} />}
              {d.kind === 'parcel' && <Parcel color={d.color} />}
              {d.kind === 'confetti' && <Confetti color={d.color} shape={d.shape} />}
            </span>
          </span>
        </span>
      ))}
    </div>
  );
}