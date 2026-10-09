// Line icons, 24px grid, drawn with currentColor so they follow the text colour
// (and the contrast fixes in tokens.css). No emoji or font glyphs anywhere in the UI.

function Svg({ size = 18, children, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function PaperclipIcon({ size = 18 }) {
  return (
    <Svg size={size}>
      <path d="M21.44 11.05l-9.19 9.19a5 5 0 01-7.07-7.07l9.19-9.19a3.5 3.5 0 014.95 4.95l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
    </Svg>
  );
}

export function MenuIcon({ size = 20 }) {
  return (
    <Svg size={size}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </Svg>
  );
}

export function CloseIcon({ size = 20 }) {
  return (
    <Svg size={size}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Svg>
  );
}

export function StarIcon({ size = 16, filled = false }) {
  return (
    <Svg size={size} fill={filled ? 'currentColor' : 'none'} strokeWidth="1.6">
      <path d="M12 3.6l2.5 5.2 5.7.8-4.1 4 1 5.7L12 16.6l-5.1 2.7 1-5.7-4.1-4 5.7-.8L12 3.6z" />
    </Svg>
  );
}

/** Read-only star rating. Announces "4 out of 5 stars" instead of reading out glyphs. */
export function StarRating({ value = 0, max = 5, size = 16 }) {
  const filled = Math.max(0, Math.min(max, Math.round(Number(value) || 0)));
  return (
    <span className="stars" role="img" aria-label={`${filled} out of ${max} stars`}>
      {Array.from({ length: max }, (_, i) => (
        <StarIcon key={i} size={size} filled={i < filled} />
      ))}
    </span>
  );
}

export function MicIcon({ size = 20 }) {
  return (
    <Svg size={size}>
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0014 0M12 18v3" />
    </Svg>
  );
}

export function StopIcon({ size = 16 }) {
  return (
    <Svg size={size} fill="currentColor" stroke="none">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </Svg>
  );
}

export function TrashIcon({ size = 20 }) {
  return (
    <Svg size={size}>
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3" />
    </Svg>
  );
}

export function PlayIcon({ size = 16 }) {
  return (
    <Svg size={size} fill="currentColor" stroke="none">
      <path d="M8 5.5v13a1 1 0 001.5.86l10.5-6.5a1 1 0 000-1.72L9.5 4.64A1 1 0 008 5.5z" />
    </Svg>
  );
}

export function PauseIcon({ size = 16 }) {
  return (
    <Svg size={size} fill="currentColor" stroke="none">
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </Svg>
  );
}

/* ---- app icon set (home feed, browse): one stroke style, follows text colour ---- */
const PATHS = {
  home: <><path d="M3 11l9-8 9 8" /><path d="M5 10v10h14V10" /></>,
  tree: <><path d="M12 21v-6" /><path d="M12 15c-3.6 0-6.2-2.6-6.2-5.8S8.4 3 12 3s6.2 3 6.2 6.2S15.6 15 12 15z" /></>,
  chat: <path d="M21 12a8 8 0 01-11.6 7.1L4 20l1-4.4A8 8 0 1121 12z" />,
  ticket: <><path d="M2 9a3 3 0 010 6v2a2 2 0 002 2h16a2 2 0 002-2v-2a3 3 0 010-6V7a2 2 0 00-2-2H4a2 2 0 00-2 2z" /><path d="M13 5v2M13 11v2M13 17v2" /></>,
  compass: <><circle cx="12" cy="12" r="9" /><path d="M16.2 7.8l-2.1 6.3-6.3 2.1 2.1-6.3z" /></>,
  phone: <path d="M22 16.9v3a2 2 0 01-2.2 2 19.8 19.8 0 01-8.6-3.1 19.5 19.5 0 01-6-6A19.8 19.8 0 012.1 4.2 2 2 0 014.1 2h3a2 2 0 012 1.7c.1 1 .4 1.9.7 2.8a2 2 0 01-.5 2.1L8.1 9.9a16 16 0 006 6l1.3-1.3a2 2 0 012.1-.4c.9.3 1.8.6 2.8.7a2 2 0 011.7 2z" />,
  wallet: <><path d="M19 7V5a1 1 0 00-1-1H5a2 2 0 000 4h15a1 1 0 011 1v4h-3a2 2 0 000 4h3a1 1 0 001-1v-2" /><path d="M3 5v14a2 2 0 002 2h15a1 1 0 001-1v-4" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21v-1a6 6 0 016-6h4a6 6 0 016 6v1" /></>,
  users: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20v-1a5 5 0 015-5h3a5 5 0 015 5v1" /><path d="M16 4.6a3.5 3.5 0 010 6.8M21.5 20v-1a5 5 0 00-3.5-4.8" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="M20 6L9 17l-5-5" />,
  chevron: <path d="M9 6l6 6-6 6" />,
  flame: <path d="M12 3c1 3.5 5 5.5 5 10a5 5 0 01-10 0c0-2 1-3.2 2-4.2.2 1.4 1 2.2 2 2.2 0-3-1.2-5-1-8z" />,
  sliders: <><path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" /><circle cx="15" cy="6" r="2" /><circle cx="9" cy="12" r="2" /><circle cx="17" cy="18" r="2" /></>,
  pin: <><path d="M12 21s7-6.2 7-11.5A7 7 0 005 9.5C5 14.8 12 21 12 21z" /><circle cx="12" cy="9.5" r="2.5" /></>,
  hand: <><path d="M7 11V6a1.5 1.5 0 013 0v4" /><path d="M10 10V4.5a1.5 1.5 0 013 0V10" /><path d="M13 10V6a1.5 1.5 0 013 0v6" /><path d="M16 11.5a1.5 1.5 0 013 0V15a7 7 0 01-7 7h-1a6 6 0 01-4.7-2.3L4 15.5a1.6 1.6 0 012.4-2L8 15" /></>,
  mic: <><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0014 0M12 18v3" /></>,
  archive: <><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v11a1 1 0 001 1h12a1 1 0 001-1V8M10 12h4" /></>,
  unarchive: <><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v11a1 1 0 001 1h12a1 1 0 001-1V8M12 18v-6M9 14.5l3-3 3 3" /></>,
  bell: <><path d="M6 8a6 6 0 0112 0c0 7 3 8 3 8H3s3-1 3-8" /><path d="M10.3 20a2 2 0 003.4 0" /></>,
  bellOff: <><path d="M8.7 3A6 6 0 0118 8c0 2.4.4 4.3.9 5.6M6.3 6.3C6.1 6.8 6 7.4 6 8c0 7-3 8-3 8h13M10.3 20a2 2 0 003.4 0M3 3l18 18" /></>,
  image: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="1.7" /><path d="M21 16l-5-5-9 9" /></>,
  /* ---- Square: replaces the emoji that used to sit in buttons, tabs and circle labels ---- */
  x: <path d="M6 6l12 12M18 6L6 18" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  chevronLeft: <path d="M15 6l-6 6 6 6" />,
  camera: <><path d="M4 8a2 2 0 012-2h1.6l1.4-2h6l1.4 2H18a2 2 0 012 2v9a2 2 0 01-2 2H6a2 2 0 01-2-2z" /><circle cx="12" cy="13" r="3.6" /></>,
  thought: <><path d="M21 12a8 8 0 01-11.6 7.1L4 20l1-4.4A8 8 0 1121 12z" /><path d="M8.5 12h.01M12 12h.01M15.5 12h.01" /></>,
  sparkle: <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 16l.7 1.8 1.8.7-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7z" />,
  shuffle: <path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />,
  heart: <path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0112 7.4 4.3 4.3 0 0119.5 10c0 5.4-7.5 10-7.5 10z" />,
  star: <path d="M12 3.6l2.5 5.2 5.7.8-4.1 4-1 5.7L12 16.6l-5.1 2.7 1-5.7-4.1-4 5.7-.8L12 3.6z" />,
  briefcase: <><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2M3 13h18" /></>,
  cap: <><path d="M2 9l10-5 10 5-10 5z" /><path d="M6 11.5V16c0 1.3 2.7 3 6 3s6-1.7 6-3v-4.5" /></>,
  smile: <><circle cx="12" cy="12" r="9" /><path d="M8.5 14a4 4 0 007 0M9 9.5h.01M15 9.5h.01" /></>,
  pencil: <path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 013 3L8 19zM14.5 6.5l3 3" />,
  download: <path d="M12 4v11M7 11l5 5 5-5M5 20h14" />,
  share: <><path d="M12 15V4M8 8l4-4 4 4" /><path d="M5 12v6a2 2 0 002 2h10a2 2 0 002-2v-6" /></>,
  trash: <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3" />,
  logout: <><path d="M10 4H6a2 2 0 00-2 2v12a2 2 0 002 2h4" /><path d="M15 8l4 4-4 4M19 12H9" /></>,
  eye: <><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>,
  play: <path d="M8 5.5v13l11-6.5z" />,
  film: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4" /></>,
  alert: <><path d="M12 3.5L2.8 19.5h18.4z" /><path d="M12 10v4M12 17h.01" /></>,
  trending: <path d="M3 17l6-6 4 4 8-8M15 7h6v6" />,
};

export function Icon({ name, size = 20, ...rest }) {
  return <Svg size={size} {...rest}>{PATHS[name] || null}</Svg>;
}
