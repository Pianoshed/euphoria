import './group-call.css';
import { useEffect, useRef, useState } from 'react';
import { useDataSaver } from '../../hooks/useDataSaver';

/* Plays one person's voice. Always mounted for the whole call (full screen or minimized), so
   going small never cuts anybody's audio. The picture tiles below are muted. */
function AudioSink({ stream }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.srcObject = stream || null; }, [stream]);
  return <audio ref={ref} autoPlay />;
}

function Picture({ stream, mirrored = false }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.srcObject = stream || null; }, [stream]);
  return <video ref={ref} className={mirrored ? 'is-mirrored' : ''} autoPlay playsInline muted />;
}

function Face({ name, avatar, big = false }) {
  return avatar
    ? <img className={`gc-face${big ? ' gc-face--big' : ''}`} src={avatar} alt="" />
    : <span className={`gc-face${big ? ' gc-face--big' : ''}`} aria-hidden="true">{(name || '?')[0].toUpperCase()}</span>;
}

function useElapsed(running) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!running) { setSeconds(0); return undefined; }
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

const Icon = ({ children }) => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
const MicIcon = ({ off }) => (<Icon><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" />{off && <path d="M4 4l16 16" />}</Icon>);
const CamIcon = ({ off }) => (<Icon><rect x="3" y="6" width="12" height="12" rx="2" /><path d="M15 10l6-3v10l-6-3" />{off && <path d="M3 3l18 18" />}</Icon>);
const FlipIcon = () => (<Icon><path d="M4 8h12l-3-3M20 16H8l3 3" /></Icon>);
const DownIcon = () => (<Icon><path d="M6 9l6 6 6-6" /></Icon>);
const UpIcon = () => (<Icon><path d="M4 14v6h6M20 10V4h-6M4 20l7-7M20 4l-7 7" /></Icon>);
const HangUpIcon = () => (<Icon><path d="M3 14c4-4 14-4 18 0l-2.5 2.5-3-1.5v-2.2c-2-.6-4-.6-6 0V15l-3 1.5z" /></Icon>);

/**
 * The screen for a call in a group chat: a grid with everyone on it, a small bar when minimized,
 * and the short message after the call ends. `gcall` is what useGroupCall returns.
 * `people` is { [userId]: { name, avatar } }; `me` is this person's own { name, avatar }.
 */
export default function GroupCallPanel({ gcall, title, people, me, minimized, onMinimize, onExpand }) {
  const { status, notice, mode } = gcall;
  const saver = useDataSaver();
  const voice = mode === 'voice';
  const elapsed = useElapsed(status === 'active');
  const remoteIds = Object.keys(gcall.remotes);
  const total = remoteIds.length + 1;
  const canFlip = !voice && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;

  if (status === 'idle') return null;
  if (status === 'ended') {
    return notice ? (
      <div className="gc-toast" role="status">
        <span>{notice}</span>
        <button type="button" onClick={gcall.dismiss}>Close</button>
      </div>
    ) : null;
  }

  const sinks = remoteIds.map((id) => <AudioSink key={id} stream={gcall.remotes[id]} />);
  const label = `${title || 'Group call'}`;
  const sub = status === 'joining' ? 'Joining…'
    : total === 1 ? 'Waiting for others to join…'
    : `${total} people · ${elapsed}`;

  if (minimized) {
    return (
      <div className="gc-mini" role="region" aria-label={`Group call: ${label}`}>
        {sinks}
        <button type="button" className="gc-mini__who" onClick={onExpand} aria-label="Back to the call">
          <span className="gc-mini__icon" aria-hidden="true">👥</span>
          <span className="gc-mini__text"><strong>{label}</strong><small>{sub}</small></span>
        </button>
        <button type="button" className={`gc-btn gc-btn--sm${gcall.micOn ? '' : ' is-off'}`} onClick={gcall.toggleMic}
          aria-pressed={!gcall.micOn} aria-label={gcall.micOn ? 'Mute microphone' : 'Unmute microphone'}><MicIcon off={!gcall.micOn} /></button>
        <button type="button" className="gc-btn gc-btn--sm" onClick={onExpand} aria-label="Open the call screen"><UpIcon /></button>
        <button type="button" className="gc-btn gc-btn--sm gc-btn--end" onClick={gcall.leave} aria-label="Leave call"><HangUpIcon /></button>
      </div>
    );
  }

  const cols = total <= 1 ? 1 : total <= 4 ? 2 : total <= 9 ? 3 : 4;
  return (
    <div className="gc-screen" role="dialog" aria-modal="true" aria-label={`${voice ? 'Voice' : 'Video'} call: ${label}`}>
      {sinks}
      <div className="gc-top">
        <strong className="gc-top__title">{label}</strong>
        <span className="gc-top__sub" role="status">{sub}</span>
        <span className="gc-top__spacer" />
        {!voice && (
          <button type="button" className={`gc-chip${saver.active ? ' is-on' : ''}`} aria-pressed={saver.active}
            onClick={() => saver.setSetting(saver.active ? 'off' : 'on')} title="Lower the picture quality to use less mobile data">
            Data saver {saver.active ? 'on' : 'off'}
          </button>
        )}
        <button type="button" className="gc-chip" onClick={onMinimize} aria-label="Minimize the call"><DownIcon /></button>
      </div>

      <div className="gc-grid" style={{ '--gc-cols': cols }}>
        <div className={`gc-tile gc-tile--me${gcall.camOn && !voice ? '' : ' is-off'}`}>
          {!voice && <Picture stream={gcall.localStream} mirrored={gcall.facing === 'user'} />}
          <Face name={me?.name} avatar={me?.avatar} big />
          <span className="gc-tile__name">You{!gcall.micOn ? ' · muted' : ''}</span>
        </div>
        {remoteIds.map((id) => {
          const p = people[id] || {};
          const stream = gcall.remotes[id];
          const hasPicture = !voice && stream && stream.getVideoTracks().length > 0;
          return (
            <div key={id} className={`gc-tile${hasPicture ? '' : ' is-off'}`}>
              {hasPicture && <Picture stream={stream} />}
              <Face name={p.name} avatar={p.avatar} big />
              <span className="gc-tile__name">{p.name || 'Someone'}{!stream ? ' · connecting…' : ''}</span>
            </div>
          );
        })}
      </div>

      <p className="gc-note">Everyone here sees and hears everyone else. We don&rsquo;t record the call.</p>

      <div className="gc-controls">
        <button type="button" className={`gc-btn${gcall.micOn ? '' : ' is-off'}`} onClick={gcall.toggleMic}
          aria-pressed={!gcall.micOn} aria-label={gcall.micOn ? 'Mute microphone' : 'Unmute microphone'}><MicIcon off={!gcall.micOn} /></button>
        {!voice && (
          <button type="button" className={`gc-btn${gcall.camOn ? '' : ' is-off'}`} onClick={gcall.toggleCam}
            aria-pressed={!gcall.camOn} aria-label={gcall.camOn ? 'Turn camera off' : 'Turn camera on'}><CamIcon off={!gcall.camOn} /></button>
        )}
        {canFlip && <button type="button" className="gc-btn" onClick={gcall.flipCamera} aria-label="Switch camera"><FlipIcon /></button>}
        <button type="button" className="gc-btn gc-btn--end" onClick={gcall.leave} aria-label="Leave call" autoFocus><HangUpIcon /></button>
      </div>
    </div>
  );
}
