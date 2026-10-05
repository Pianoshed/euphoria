import './call.css';
import { useEffect, useRef, useState } from 'react';
import { startRingback, startRingtone, stopRingback, stopRingtone } from '../../utils/notifySound';
import { useDataSaver } from '../../hooks/useDataSaver';

function VideoTile({ stream, muted = false, mirrored = false, className = '' }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream || null;
  }, [stream]);
  return (
    <video
      ref={ref}
      className={`${className}${mirrored ? ' is-mirrored' : ''}`}
      autoPlay
      playsInline
      muted={muted}
    />
  );
}

function CallerFace({ name, avatar, className = '' }) {
  return avatar
    ? <img className={`vc-face ${className}`} src={avatar} alt="" />
    : <span className={`vc-face ${className}`} aria-hidden="true">{(name || '?')[0].toUpperCase()}</span>;
}

function useElapsed(running) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!running) { setSeconds(0); return undefined; }
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const m = String(Math.floor(seconds / 60)).padStart(2, '0');
  const s = String(seconds % 60).padStart(2, '0');
  return `${m}:${s}`;
}

const MicIcon = ({ off }) => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    {off && <path d="M4 4l16 16" />}
  </svg>
);
const CamIcon = ({ off }) => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="6" width="12" height="12" rx="2" />
    <path d="M15 10l6-3v10l-6-3" />
    {off && <path d="M3 3l18 18" />}
  </svg>
);
const FlipIcon = () => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 8h12l-3-3M20 16H8l3 3" />
  </svg>
);
const SwapIcon = ({ size = 22 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M7 4v13M3.5 13.5 7 17l3.5-3.5M17 20V7M13.5 10.5 17 7l3.5 3.5" />
  </svg>
);
const MinimizeIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 9l6 6 6-6" />
  </svg>
);
const ExpandIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 14v6h6M20 10V4h-6M4 20l7-7M20 4l-7 7" />
  </svg>
);
const HangUpIcon = () => (
  <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 14c4-4 14-4 18 0l-2.5 2.5-3-1.5v-2.2c-2-.6-4-.6-6 0V15l-3 1.5z" />
  </svg>
);

/**
 * Renders everything about a call: the "ringing" prompt, the full-screen call,
 * and the short message after a call ends. `call` is the object returned by useVideoCall.
 *
 * Both video tiles stay mounted the whole call and only swap size/position, so swapping
 * never restarts a stream or cuts the other person's audio. Tap the small picture (or the
 * swap button) to put yourself on the big screen, and tap again to swap back.
 */
export default function VideoCallPanel({ call, name, avatar, minimized = false, onMinimize, onExpand, quiet = false }) {
  const { status, notice } = call;
  const elapsed = useElapsed(status === 'active');
  const saver = useDataSaver();
  const [swapped, setSwapped] = useState(false); // true = my camera is the big picture
  const voice = call.mode === 'voice';
  const canFlip = !voice && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;

  // Every new call starts with the other person on the big screen.
  useEffect(() => {
    if (status === 'idle' || status === 'ended' || status === 'incoming') setSwapped(false);
  }, [status]);

  // Ring while a call is waiting to be answered.
  useEffect(() => {
    if (status !== 'incoming' || quiet) return undefined;
    startRingtone();
    return stopRingtone;
  }, [status, quiet]);

  // The caller hears a ringback tone until the other person answers, declines or the call times out.
  useEffect(() => {
    if (status !== 'calling') return undefined;
    startRingback();
    return stopRingback;
  }, [status]);

  if (status === 'idle') return null;

  if (status === 'ended') {
    return notice ? (
      <div className="vc-toast" role="status">
        <span>{notice}</span>
        <button type="button" onClick={call.dismiss}>Close</button>
      </div>
    ) : null;
  }

  if (status === 'incoming' && quiet) return null; // answered from the site-wide ring: no second ring screen

  if (status === 'incoming') {
    return (
      <div className="vc-backdrop">
        <div className="vc-ring" role="alertdialog" aria-modal="true" aria-label={`Incoming ${voice ? 'voice' : 'video'} call from ${name}`}>
          <CallerFace name={name} avatar={avatar} className="vc-face--pulse" />
          <h2>{name}</h2>
          <p>{voice ? 'is calling you' : 'is calling you on video'}</p>
          <div className="vc-ring__actions">
            <button type="button" className="vc-btn vc-btn--decline" onClick={call.declineCall}>Decline</button>
            <button type="button" className="vc-btn vc-btn--accept" onClick={call.acceptCall} autoFocus>Accept</button>
          </div>
          <small>{voice ? 'Your microphone turns on when you accept.' : 'Your camera and microphone turn on when you accept.'}</small>
        </div>
      </div>
    );
  }

  if (minimized && status !== 'incoming') {
    return (
      <div className={`vc-mini${voice ? ' vc-mini--voice' : ''}`} role="region" aria-label={`Call with ${name}`}>
        {/* The remote video element stays mounted: it is what plays the other person's voice. */}
        <button type="button" className="vc-mini__who" onClick={onExpand} aria-label="Back to the call">
          <span className="vc-mini__thumb">
            <CallerFace name={name} avatar={avatar} className="vc-mini__face" />
            {!voice && call.remoteStream && <VideoTile stream={call.remoteStream} className="vc-mini__video" />}
          </span>
          <span className="vc-mini__text">
            <strong>{name}</strong>
            <small>{status === 'active' ? elapsed : status === 'calling' ? 'Calling\u2026' : 'Connecting\u2026'}</small>
          </span>
        </button>
        {voice && <VideoTile stream={call.remoteStream} className="vc-mini__audio" />}
        <button type="button" className={`vc-mini__btn${call.micOn ? '' : ' is-off'}`} onClick={call.toggleMic}
          aria-pressed={!call.micOn} aria-label={call.micOn ? 'Mute microphone' : 'Unmute microphone'}>
          <MicIcon off={!call.micOn} />
        </button>
        <button type="button" className="vc-mini__btn" onClick={onExpand} aria-label="Open the call screen"><ExpandIcon /></button>
        <button type="button" className="vc-mini__btn vc-mini__btn--end" onClick={call.hangUp} aria-label="End call"><HangUpIcon /></button>
      </div>
    );
  }

  const selfBig = swapped && !voice;
  const toggleSwap = () => setSwapped((v) => !v);
  const smallProps = {
    role: 'button',
    tabIndex: 0,
    onClick: toggleSwap,
    onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSwap(); } },
  };

  // The caller's face and "Calling…" text only cover the big screen while the other person is on it.
  const waiting = voice || (!selfBig && (status !== 'active' || !call.remoteStream));
  const label = status === 'calling' ? `Calling ${name}\u2026`
    : status === 'connecting' ? 'Connecting\u2026'
    : voice ? 'Voice call' : name;

  return (
    <div className={`vc-screen${voice ? ' vc-screen--voice' : ''}${avatar ? ' vc-screen--photo' : ''}`}
      style={avatar ? { '--vc-photo': `url("${avatar}")` } : undefined} role="dialog" aria-modal="true" aria-label={`${voice ? 'Voice' : 'Video'} call with ${name}`}>
      {/* Other person */}
      <div
        className={`vc-tile vc-tile--remote ${selfBig ? 'vc-tile--small' : 'vc-tile--big'}`}
        {...(selfBig ? { ...smallProps, 'aria-label': 'Swap: put your camera back in the small picture' } : {})}
      >
        <VideoTile stream={call.remoteStream} className="vc-tile__video" />
        {selfBig && !call.remoteStream && <CallerFace name={name} avatar={avatar} className="vc-tile__face" />}
        {selfBig && <span className="vc-tile__badge"><SwapIcon size={14} /></span>}
      </div>

      {waiting && (
        <div className="vc-waiting">
          <CallerFace name={name} avatar={avatar} className={`vc-face--big${status === 'active' ? '' : ' vc-face--pulse'}`} />
          {voice && <strong className="vc-waiting__name">{name}</strong>}
          <p role="status">{voice && status === 'active' ? elapsed : label}</p>
        </div>
      )}

      <div className="vc-top">
        <CallerFace name={name} avatar={avatar} className="vc-top__face" />
        <strong>{name}</strong>
        {status === 'active' && <span className="vc-timer" aria-label="Call length">{elapsed}</span>}
        <span className="vc-top__spacer" />
        {!voice && (
          <button type="button" className={`vc-chip${saver.active ? ' is-on' : ''}`} aria-pressed={saver.active}
            onClick={() => saver.setSetting(saver.active ? 'off' : 'on')}
            title="Lower the picture quality to use less mobile data">
            Data saver {saver.active ? 'on' : 'off'}
          </button>
        )}
        <button type="button" className="vc-chip vc-chip--icon" onClick={onMinimize} aria-label="Minimize the call" title="Keep the call going and go back to the app">
          <MinimizeIcon />
        </button>
        <span className="vc-note">Only the two of you are on this call. We don&rsquo;t record it.</span>
      </div>

      {/* Me */}
      {!voice && (
        <div
          className={`vc-tile vc-tile--self ${selfBig ? 'vc-tile--big' : 'vc-tile--small'}${call.camOn ? '' : ' is-off'}`}
          {...(!selfBig ? { ...smallProps, 'aria-label': 'Swap: put your camera on the big screen' } : {})}
        >
          <VideoTile stream={call.localStream} muted mirrored={call.facing === 'user'} className="vc-tile__video" />
          {!call.camOn && <span className="vc-tile__off">Camera off</span>}
          {!selfBig && <span className="vc-tile__badge"><SwapIcon size={14} /></span>}
        </div>
      )}

      <div className="vc-controls">
        <button type="button" className={`vc-round${call.micOn ? '' : ' is-off'}`} onClick={call.toggleMic}
          aria-pressed={!call.micOn} aria-label={call.micOn ? 'Mute microphone' : 'Unmute microphone'}>
          <MicIcon off={!call.micOn} />
        </button>
        {!voice && (
          <button type="button" className={`vc-round${call.camOn ? '' : ' is-off'}`} onClick={call.toggleCam}
            aria-pressed={!call.camOn} aria-label={call.camOn ? 'Turn camera off' : 'Turn camera on'}>
            <CamIcon off={!call.camOn} />
          </button>
        )}
        {!voice && (
          <button type="button" className={`vc-round${selfBig ? ' is-off' : ''}`} onClick={toggleSwap}
            aria-pressed={selfBig} aria-label="Swap big and small pictures">
            <SwapIcon />
          </button>
        )}
        {canFlip && (
          <button type="button" className="vc-round" onClick={call.flipCamera} aria-label="Switch camera">
            <FlipIcon />
          </button>
        )}
        <button type="button" className="vc-round vc-round--end" onClick={call.hangUp} aria-label="End call" autoFocus>
          <HangUpIcon />
        </button>
      </div>
    </div>
  );
}
