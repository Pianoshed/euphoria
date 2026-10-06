import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './header-actions.css';

/* ------------------------------------------------------------------ */
/* Icons (local, so the header has no dependency on ConversationView)  */
/* ------------------------------------------------------------------ */

const Svg = ({ children, size = 20 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {children}
  </svg>
);
const PhoneIcon = (p) => (
  <Svg {...p}><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z" /></Svg>
);
const VideoIcon = (p) => (
  <Svg {...p}><rect x="3" y="6" width="12" height="12" rx="2" /><path d="M15 10l6-3v10l-6-3" /></Svg>
);
const DataSaverIcon = (p) => (
  <Svg {...p}><path d="M8 20V5M8 5L4.5 8.5M8 5l3.5 3.5M16 4v15M16 19l-3.5-3.5M16 19l3.5-3.5" /></Svg>
);
const DotsIcon = (p) => (
  <Svg {...p}>
    <circle cx="5" cy="12" r="1.3" fill="currentColor" />
    <circle cx="12" cy="12" r="1.3" fill="currentColor" />
    <circle cx="19" cy="12" r="1.3" fill="currentColor" />
  </Svg>
);
const UsersIcon = (p) => (
  <Svg {...p}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
    <path d="M16 5.2a3.2 3.2 0 0 1 0 5.6M18 14.3c1.7.8 3 2.6 3 5.7" />
  </Svg>
);

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const MOBILE_QUERY = '(max-width: 860px)';

/** True on phones / narrow windows (same breakpoint the rest of the chat page uses). */
export function useIsMobile() {
  const get = () => (typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches);
  const [mobile, setMobile] = useState(get);
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const on = () => setMobile(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return mobile;
}

/**
 * One popover, two looks: a small dropdown under the button on desktop,
 * a bottom sheet with a dimmed backdrop on phones.
 */
function Popover({ open, onClose, triggerRef, title, mobile, children }) {
  const panelRef = useRef(null);

  // Close on outside click / Escape; give focus back to the button that opened it.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') { onClose(); triggerRef.current?.focus(); }
    };
    const onDown = (e) => {
      if (mobile) return; // phones use the backdrop instead
      if (panelRef.current?.contains(e.target) || triggerRef.current?.contains(e.target)) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [open, mobile, onClose, triggerRef]);

  // Move focus into the panel so keyboard and screen-reader users land on the first option.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => panelRef.current?.querySelector('button:not(:disabled)')?.focus(), 30);
    return () => clearTimeout(t);
  }, [open]);

  if (!open) return null;

  if (mobile) {
    return createPortal(
      <div className="hx-layer">
        <div className="hx-backdrop" onClick={onClose} aria-hidden="true" />
        <div className="hx-sheet" role="dialog" aria-modal="true" aria-label={title} ref={panelRef}>
          <span className="hx-sheet__grip" aria-hidden="true" />
          <p className="hx-sheet__title">{title}</p>
          {children}
        </div>
      </div>,
      document.body,
    );
  }

  return (
    <div className="hx-pop" role="dialog" aria-label={title} ref={panelRef}>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The header actions                                                  */
/* ------------------------------------------------------------------ */

/**
 * Right-hand side of the chat header: ONE "Call" button (opens Voice / Video)
 * and ONE "More" button (Data saver, Members). Everything else that used to sit
 * in a row of buttons now lives behind these two.
 */
export default function ChatHeaderActions({
  name,
  isGroup = false,
  callDisabled = false,
  onVoice,
  onVideo,
  saver,                // { active, setSetting }
  memberCount = 0,
  waitingCount = 0,     // people asking to join (admins)
  onOpenMembers,        // phones only: opens the members sheet
}) {
  const mobile = useIsMobile();
  const [openMenu, setOpenMenu] = useState(null); // 'call' | 'more' | null
  const callRef = useRef(null);
  const moreRef = useRef(null);
  const uid = useId();
  const close = useCallback(() => setOpenMenu(null), []);
  const toggle = (which) => setOpenMenu((cur) => (cur === which ? null : which));

  // Resizing across the breakpoint while a menu is open would leave it in the wrong layout.
  useEffect(() => { setOpenMenu(null); }, [mobile]);

  const startCall = (fn) => { close(); fn(); };
  const showMembersRow = isGroup && mobile && typeof onOpenMembers === 'function';
  const alertDot = showMembersRow && waitingCount > 0; // red: someone needs an answer
  const moreDot = alertDot || saver.active;            // green: data saver is on

  return (
    <div className="cv-head__actions hx">
      {/* ---- Call ---- */}
      <div className="hx-anchor">
        <button
          ref={callRef}
          type="button"
          className={`hx-btn hx-btn--primary${openMenu === 'call' ? ' is-open' : ''}`}
          aria-haspopup="dialog"
          aria-expanded={openMenu === 'call'}
          aria-controls={`${uid}-call`}
          aria-label={isGroup ? 'Start a group call' : `Call ${name}`}
          onClick={() => toggle('call')}
        >
          <PhoneIcon size={19} />
          <span className="hx-btn__text">Call</span>
        </button>
        <Popover open={openMenu === 'call'} onClose={close} triggerRef={callRef} mobile={mobile}
          title={isGroup ? 'Group call' : `Call ${name}`}>
          <div id={`${uid}-call`} className="hx-list">
            <button type="button" className="hx-item" disabled={callDisabled} onClick={() => startCall(onVoice)}>
              <span className="hx-item__ico hx-item__ico--voice"><PhoneIcon /></span>
              <span className="hx-item__txt">
                <strong>Voice call</strong>
                <small>{isGroup ? 'Talk with the group' : 'Audio only, uses less data'}</small>
              </span>
            </button>
            <button type="button" className="hx-item" disabled={callDisabled} onClick={() => startCall(onVideo)}>
              <span className="hx-item__ico hx-item__ico--video"><VideoIcon /></span>
              <span className="hx-item__txt">
                <strong>Video call</strong>
                <small>{isGroup ? 'See everyone on the call' : 'Face to face'}</small>
              </span>
            </button>
            {callDisabled && <p className="hx-note">You&rsquo;re already on a call.</p>}
            {!callDisabled && saver.active && <p className="hx-note">Data saver is on, so call quality is lowered.</p>}
          </div>
        </Popover>
      </div>

      {/* ---- More ---- */}
      <div className="hx-anchor">
        <button
          ref={moreRef}
          type="button"
          className={`hx-btn hx-btn--icon${openMenu === 'more' ? ' is-open' : ''}`}
          aria-haspopup="dialog"
          aria-expanded={openMenu === 'more'}
          aria-controls={`${uid}-more`}
          aria-label={`More options${saver.active ? ', data saver is on' : ''}${alertDot ? `, ${waitingCount} waiting to join` : ''}`}
          onClick={() => toggle('more')}
        >
          <DotsIcon size={20} />
          {moreDot && <span className={`hx-dot${alertDot ? ' hx-dot--alert' : ''}`} aria-hidden="true" />}
        </button>
        <Popover open={openMenu === 'more'} onClose={close} triggerRef={moreRef} mobile={mobile} title="Chat options">
          <div id={`${uid}-more`} className="hx-list">
            {showMembersRow && (
              <button type="button" className="hx-item" onClick={() => { close(); onOpenMembers(); }}>
                <span className="hx-item__ico hx-item__ico--members"><UsersIcon /></span>
                <span className="hx-item__txt">
                  <strong>Members</strong>
                  <small>
                    {memberCount} {memberCount === 1 ? 'person' : 'people'}
                    {waitingCount > 0 ? ` · ${waitingCount} waiting to join` : ''}
                  </small>
                </span>
                {waitingCount > 0 && <span className="hx-badge">{waitingCount}</span>}
              </button>
            )}

            <button
              type="button"
              className="hx-item"
              role="switch"
              aria-checked={saver.active}
              onClick={() => saver.setSetting(saver.active ? 'off' : 'on')}
            >
              <span className={`hx-item__ico hx-item__ico--saver${saver.active ? ' is-on' : ''}`}><DataSaverIcon /></span>
              <span className="hx-item__txt">
                <strong>Data saver</strong>
                <small>Smaller photos, lower call quality, slower refresh</small>
              </span>
              <span className={`hx-switch${saver.active ? ' is-on' : ''}`} aria-hidden="true"><span /></span>
            </button>
          </div>
        </Popover>
      </div>
    </div>
  );
}
