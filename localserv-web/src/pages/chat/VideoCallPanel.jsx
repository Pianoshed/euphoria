import './call.css';
import { useEffect, useRef, useState } from 'react';

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
const HangUpIcon = () => (
  <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 14c4-4 14-4 18 0l-2.5 2.5-3-1.5v-2.2c-2-.6-4-.6-6 0V15l-3 1.5z" />
  </svg>
);

/**
 * Renders everything about a call: the "ringing" prompt, the full-screen call,
 * and the short message after a call ends. `call` is the object returned by useVideoCall.
 */
export default function VideoCallPanel({ call, name, avatar }) {
  const { status, notice } = call;
  const elapsed = useElapsed(status === 'active');
  const voice = call.mode === 'voice';
  const canFlip = !voice && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;

  if (status === 'idle') return null;

  if (status === 'ended') {
    return notice ? (
      <div className="vc-toast" role="status">
        <span>{notice}</span>
        <button type="button" onClick={call.dismiss}>Close</button>
      </div>
    ) : null;
  }

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

  // A voice call has no picture to show, so the caller's face stays up for the whole call.
  const waiting = voice || status !== 'active' || !call.remoteStream;
  const label = status === 'calling' ? `Calling ${name}…`
    : status === 'connecting' ? 'Connecting…'
    : voice ? 'Voice call' : name;

  return (
    <div className={`vc-screen${voice ? ' vc-screen--voice' : ''}`} role="dialog" aria-modal="true" aria-label={`${voice ? 'Voice' : 'Video'} call with ${name}`}>
      {call.remoteStream && <VideoTile stream={call.remoteStream} className="vc-remote" />}

      {waiting && (
        <div className="vc-waiting">
          <CallerFace name={name} avatar={avatar} className="vc-face--pulse vc-face--big" />
          <p role="status">{label}</p>
        </div>
      )}

      <div className="vc-top">
        <strong>{name}</strong>
        {status === 'active' && <span className="vc-timer" aria-label="Call length">{elapsed}</span>}
        <span className="vc-note">Only the two of you are on this call. We don&rsquo;t record it.</span>
      </div>

      {!voice && (
        <div className={`vc-self${call.camOn ? '' : ' is-off'}`}>
          <VideoTile stream={call.localStream} muted mirrored={call.facing === 'user'} className="vc-self__video" />
          {!call.camOn && <span className="vc-self__off">Camera off</span>}
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
