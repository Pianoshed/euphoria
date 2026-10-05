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
