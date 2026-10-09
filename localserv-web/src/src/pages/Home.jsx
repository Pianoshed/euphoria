import '../styles/index.css'; // the whole theme: safe to import here, bundlers load it once
import { Link } from 'react-router-dom';

// Hero artwork = the login "cafe" image; closing panel = the register "couples" image.

const FEATURED_ACTIVITIES = [
  {
    title: 'Sunset skate + smoothies',
    host: 'Tomi A.',
    place: 'Waterfront',
    price: '₦3,500',
    blurb: 'Roll through the waterfront, then grab a smoothie and talk about anything.',
  },
  {
    title: 'Board game night',
    host: 'Chidi O.',
    place: 'Yaba',
    price: '₦2,000',
    blurb: 'Catan, Uno, and whatever else shows up. New players always welcome.',
  },
  {
    title: 'Campus photo walk',
    host: 'Amara N.',
    place: 'UNILAG',
    price: 'Free',
    blurb: 'An hour of walking, talking, and finding the best light on campus.',
  },
];

const STEPS = [
  { order: 'First', title: 'Find a plan', body: 'Browse activities near you, or post your own with a time, place, and a price if there is one.' },
  { order: 'Next', title: 'Message and confirm', body: 'Chat with the host, ask questions, and lock in the details before you commit.' },
  { order: 'Then', title: 'Pull up', body: 'Show up, hang out, and leave a review so the next person knows what to expect.' },
];

export default function Home() {
  return (
    <div>
      <header className="e-scene-hero">
        <div className="e-shell">
          <nav className="e-nav" aria-label="Main">
            <Link to="/" className="e-nav__logo">Euphoria</Link>
            <div className="e-nav__links">
              <Link to="/services" className="e-nav__link e-nav__link--wide">Browse activities</Link>
              <Link to="/providers" className="e-nav__link e-nav__link--wide">Find people</Link>
              <Link to="/login" className="e-nav__link">Sign in</Link>
              <Link to="/register" className="e-nav__cta">Get started</Link>
            </div>
          </nav>

          <section className="e-hero">
            <div>
              <div className="e-hero__people">
                <div className="e-hero__people-stack" aria-hidden="true">
                  <span className="avatar avatar--sm">T</span>
                  <span className="avatar avatar--sm">C</span>
                  <span className="avatar avatar--sm">A</span>
                </div>
                <span><strong>240+</strong> people hanging out nearby this week</span>
              </div>

              <h1>Find someone to actually do something with</h1>
              <p>
                Post a plan or join someone else's. Skating, study sessions, gigs, game
                nights — message first, agree on details, then meet up.
              </p>

              <div className="e-hero__actions">
                <Link to="/register" className="btn btn--primary">Get started</Link>
                <Link to="/services" className="btn btn--ghost">Browse activities</Link>
              </div>
            </div>

            <div className="e-hero__visual" aria-hidden="true">
              <div className="e-hero__card e-hero__card--1">
                <div className="e-hero__card-top">
                  <span className="avatar avatar--sm">T</span>
                  <span className="e-hero__card-name">Tomi A.</span>
                </div>
                <p>&ldquo;Free Saturday morning if anyone's down for the skate + smoothie thing&rdquo;</p>
              </div>
              <div className="e-hero__card e-hero__card--2">
                <div className="e-hero__card-name">Board game night</div>
                <p>Tonight, 7pm · 4 spots left</p>
              </div>
              <div className="e-hero__card e-hero__card--3">
                <div className="e-hero__card-top">
                  <span className="avatar avatar--sm">A</span>
                  <span className="e-hero__card-name">Amara N.</span>
                </div>
                <p>&ldquo;Sent you the meeting point for the photo walk!&rdquo;</p>
              </div>
            </div>
          </section>
        </div>
      </header>

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

        <section className="e-live">
          <div className="e-live__head">
            <h2>Happening this week</h2>
            <Link to="/services">See all</Link>
          </div>
          <div className="e-live__grid">
            {FEATURED_ACTIVITIES.map((activity) => (
              <Link to="/services" className="card card--link e-live-card" key={activity.title}>
                <div className="e-live-card__top">
                  <span className="pill pill--neutral">{activity.place}</span>
                  <span className="price">{activity.price}</span>
                </div>
                <h3>{activity.title}</h3>
                <p>{activity.blurb}</p>
                <div className="e-live-card__host">
                  <span className="avatar avatar--sm" aria-hidden="true">{activity.host[0]}</span>
                  <span>Hosted by {activity.host}</span>
                </div>
              </Link>
            ))}
          </div>
        </section>

        <section className="e-cta-band">
          <div className="e-cta-band__copy">
            <h2>Your next hangout is one message away</h2>
            <p>It's free to browse and free to post. You only pay when a host sets a price.</p>
            <Link to="/register" className="btn btn--primary">Create your account</Link>
          </div>
        </section>
      </div>
    </div>
  );
}
