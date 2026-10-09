import '../styles/index.css'; // the whole theme: safe to import here, bundlers load it once
import { Link } from 'react-router-dom';

// Hero artwork = the login "cafe" image; closing panel = the register "couples" image.

const MOOD_CARDS = [
  { key: 1, label: 'Lekki beach hang', meta: 'Tonight · 8 going', variant: 'e-collage__card--1' },
  { key: 2, label: 'Afrobeats night', meta: 'Sat · 24 going', variant: 'e-collage__card--2' },
  { key: 3, label: 'Study squad', meta: 'Tomorrow · 6 going', variant: 'e-collage__card--3' },
];

const STEPS = [
  { order: 'First', title: 'Set your vibe', body: 'Pick the scenes you are into — music, football, food, gaming, whatever — so Euphoria knows what to show you.' },
  { order: 'Next', title: 'See what’s popping', body: 'Browse hangouts happening near you today, this weekend, or tonight, dropped by people your age.' },
  { order: 'Then', title: 'Pull up', body: 'RSVP, gist in the group chat before you go, and show up already knowing a few faces.' },
];

// `q` is the search term handed to /services, so each chip actually takes you somewhere.
const SCENES = [
  { label: 'Music & Afrobeats', q: 'music', tone: 'e-chip--a' },
  { label: 'Football', q: 'football', tone: 'e-chip--b' },
  { label: 'Food & drinks', q: 'food', tone: 'e-chip--c' },
  { label: 'Gaming', q: 'gaming', tone: 'e-chip--a' },
  { label: 'Study spots', q: 'study', tone: 'e-chip--b' },
  { label: 'Fashion', q: 'fashion', tone: 'e-chip--c' },
  { label: 'Comedy nights', q: 'comedy', tone: 'e-chip--a' },
  { label: 'Fitness', q: 'fitness', tone: 'e-chip--b' },
];

const LIVE_HANGOUTS = [
  { title: 'Sunday jollof cook-up', place: 'Yaba', going: 14 },
  { title: 'Open mic + gist', place: 'Ikeja', going: 31 },
  { title: 'Five-a-side kickabout', place: 'Surulere', going: 10 },
];

export default function LandingHome() {
  return (
    <div>
      <div className="e-scene-hero">
        <div className="e-shell">
          <section className="e-hero">
            <div>
              <span className="e-hero__eyebrow">Now live in Lagos</span>
              <h1>Your people are already here.</h1>
              <p>
                Euphoria is where young Naija comes to gist, link up, and find out what's
                popping near you — from Sunday jollof cook-ups to Friday night sets.
              </p>
              <div className="e-hero__actions">
                <Link to="/register" className="btn btn--primary">Join the gist</Link>
                <Link to="/services" className="btn btn--ghost">See what's popping</Link>
              </div>
              <div className="e-hero__stat">
                <strong>12,400+</strong> hangouts dropped this month
              </div>
            </div>

            <div className="e-collage" aria-hidden="true">
              {MOOD_CARDS.map((card) => (
                <div key={card.key} className={`e-collage__card ${card.variant}`}>
                  <div className="e-collage__label">{card.label}</div>
                  <div className="e-collage__meta">{card.meta}</div>
                  <div className="e-collage__avatars">
                    <span className="avatar" />
                    <span className="avatar" />
                    <span className="avatar" />
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>

      <div className="e-shell">
        <section className="e-steps" aria-label="How it works">
          {STEPS.map((step) => (
            <div key={step.title}>
              <div className="e-step__order">{step.order}</div>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </div>
          ))}
        </section>

        <section className="e-scene">
          <h2>Find your scene</h2>
          <div className="e-scene__grid">
            {SCENES.map((scene) => (
              <Link
                key={scene.label}
                to={`/services?q=${encodeURIComponent(scene.q)}`}
                className={`e-chip ${scene.tone}`}
              >
                {scene.label}
              </Link>
            ))}
          </div>
        </section>

        <section className="e-live">
          <div className="e-live__head">
            <h2>Live right now</h2>
            <Link to="/services">See all</Link>
          </div>
          <div className="e-live__grid">
            {LIVE_HANGOUTS.map((h) => (
              <Link key={h.title} to="/services" className="card card--link e-live-card">
                <div className="e-live-card__top">
                  <span className="pill pill--accent">{h.place}</span>
                </div>
                <h3>{h.title}</h3>
                <p>{h.going} people going</p>
              </Link>
            ))}
          </div>
        </section>

        <section className="e-cta-band">
          <div className="e-cta-band__copy">
            <h2>Stop scrolling. Start hanging.</h2>
            <p>Free to join. Your next plan is one message away.</p>
            <Link to="/register" className="btn btn--primary">Create your profile</Link>
          </div>
        </section>
      </div>
    </div>
  );
}
