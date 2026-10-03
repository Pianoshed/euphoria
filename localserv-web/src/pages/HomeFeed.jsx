import '../styles/index.css'; // the whole theme: safe to import here, bundlers load it once
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';


const STORIES = [
  { name: 'Tomi' },
  { name: 'Chidi' },
  { name: 'Amaka' },
  { name: 'Seun' },
  { name: 'Fola' },
];

const POSTS = [
  {
    id: 1,
    type: 'post',
    name: 'Amaka O.',
    meta: '2h ago',
    body: 'Anybody know a good suya spot open late in Yaba? Craving something small small tonight.',
  },
  {
    id: 2,
    type: 'hangout',
    name: 'Chidi’s crew',
    meta: 'Tonight · 7:30 PM',
    title: 'Rooftop hang + games',
    place: 'Lekki Phase 1',
    going: 18,
    tags: ['Music', 'Free entry'],
  },
  {
    id: 3,
    type: 'post',
    name: 'Seun A.',
    meta: '5h ago',
    body: 'That Afrobeats set on Friday was mad. Who else was there? Drop your best moment from the night.',
  },
];

const AROUND = [
  { name: 'Tomi', status: 'At the beach hang' },
  { name: 'Fola', status: 'Studying · Yaba' },
  { name: 'Bayo', status: 'Free tonight' },
];

const TRENDING = [
  { tag: '#DetteesBeach', count: '340 gists' },
  { tag: '#JollofWars', count: '210 gists' },
  { tag: '#StudySquad', count: '95 gists' },
];

const DEMO_BALANCE = '₦8,500'; // placeholder until this reads from the wallet API

const initial = (s) => (s || '?').trim().charAt(0).toUpperCase();

export default function HomeFeed() {
  const { user } = useAuth();
  const fullName = user?.display_name || user?.name || user?.username || '';
  const firstName = fullName.trim().split(/\s+/)[0] || 'there';

  return (
    <div className="e-feed-shell">
      <aside className="e-rail-card card">
        <div className="e-mini-profile">
          <span className="avatar">{initial(fullName)}</span>
          <div>
            <div className="e-mini-profile__name">{fullName || 'Your profile'}</div>
            <div className="e-label">@{user?.username || 'you'}</div>
          </div>
        </div>
        <ul className="e-mini-nav">
          <li><Link to="/services" className="active">Home feed</Link></li>
          <li><Link to="/providers">Who's around</Link></li>
          <li><Link to="/chat">Gist / chat</Link></li>
          <li><Link to="/bookings">My hangouts</Link></li>
          <li><Link to="/wallet">Wallet</Link></li>
        </ul>
      </aside>

      <section className="e-feed-banner">
        <p className="e-feed-banner__eyebrow">Lagos tonight</p>
        <h1>Hey {firstName}, what's the plan?</h1>
        <p>Three hangouts are filling up near you.</p>
        <Link to="/services" className="btn btn--primary btn--sm">See what's popping</Link>
      </section>

      <div className="e-mobile-wallet card">
        <div>
          <div className="e-label">Wallet</div>
          <div className="price">{DEMO_BALANCE}</div>
        </div>
        <Link to="/wallet" className="btn btn--ghost btn--sm">Top up</Link>
      </div>

      <div className="e-stories" aria-label="Stories">
        <div className="e-story">
          <div className="e-story__ring e-story__ring--add">
            <span className="avatar">{initial(fullName)}</span>
          </div>
          <span>Your vibe</span>
        </div>
        {STORIES.map((s) => (
          <div className="e-story" key={s.name}>
            <div className="e-story__ring">
              <span className="avatar">{initial(s.name)}</span>
            </div>
            <span>{s.name}</span>
          </div>
        ))}
      </div>

      <div className="e-composer card">
        <div className="e-composer__row">
          <span className="avatar">{initial(fullName)}</span>
          <input aria-label="Post a hangout or a gist" placeholder="Wetin dey happen? Drop a hangout or a gist..." />
        </div>
        <div className="e-composer__actions">
          <button className="btn btn--ghost btn--sm" type="button">Photo</button>
          <button className="btn btn--ghost btn--sm" type="button">Location</button>
          <button className="btn btn--primary btn--sm" type="button">Post</button>
        </div>
      </div>

      <div className="e-feed">
        {POSTS.map((post) =>
          post.type === 'hangout' ? (
            <div key={post.id} className="card e-hangout">
              <div className="e-post__head">
                <span className="avatar">{initial(post.name)}</span>
                <div>
                  <div className="e-post__name">{post.name}</div>
                  <div className="e-post__meta">{post.meta}</div>
                </div>
              </div>
              <div className="e-hangout__row">
                <div>
                  <h3>{post.title}</h3>
                  <div className="e-post__meta">{post.place} · {post.going} going</div>
                  <div className="e-hangout__tags">
                    {post.tags.map((t) => (
                      <span key={t} className="pill pill--neutral">{t}</span>
                    ))}
                  </div>
                </div>
                <button className="btn btn--primary btn--sm" type="button">I'm in</button>
              </div>
            </div>
          ) : (
            <div key={post.id} className="card">
              <div className="e-post__head">
                <span className="avatar">{initial(post.name)}</span>
                <div>
                  <div className="e-post__name">{post.name}</div>
                  <div className="e-post__meta">{post.meta}</div>
                </div>
              </div>
              <p>{post.body}</p>
              <div className="e-post__actions">
                <button type="button">Vibe with this</button>
                <button type="button">Reply</button>
                <button type="button">Share</button>
              </div>
            </div>
          )
        )}
      </div>

      <aside className="e-rail-card">
        <div className="card e-wallet-card">
          <div>
            <div className="e-label">Wallet</div>
            <div className="e-wallet-card__amount price">{DEMO_BALANCE}</div>
          </div>
          <Link to="/wallet" className="btn btn--ghost btn--sm">Top up</Link>
        </div>

        <div className="card">
          <div className="e-rail-title">Who's around</div>
          {AROUND.map((a) => (
            <div className="e-around-item" key={a.name}>
              <span className="avatar">{initial(a.name)}</span>
              <div>
                <div className="e-around-item__name">{a.name}</div>
                <div className="e-label">{a.status}</div>
              </div>
              <span className="e-status-dot" aria-hidden="true" />
            </div>
          ))}
        </div>

        <div className="card">
          <div className="e-rail-title">Trending gists</div>
          {TRENDING.map((t) => (
            <div className="e-trend" key={t.tag}>
              <span>{t.tag}</span>
              <span>{t.count}</span>
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}
