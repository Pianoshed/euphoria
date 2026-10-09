import './age-glow.css';

/**
 * Small copyright + privacy notes. Plain-language summary of what the app collects and where it goes,
 * with a per-region "your rights" list. This is a DRAFT SUMMARY for the product: have counsel review
 * the wording (and the region list) before launch, and keep it in step with the real privacy notice.
 *
 * variant="signup"   one or two lines under a registration form
 * variant="settings" expandable "what we collect and your rights" (profile / settings)
 * variant="corner"   a quiet (c) line for the bottom of a page
 *
 * Optional env: VITE_PRIVACY_URL (full notice), VITE_PRIVACY_EMAIL (where rights requests go).
 */
export const APP_NAME = 'Euphoria';
const PRIVACY_URL = import.meta.env.VITE_PRIVACY_URL;
const PRIVACY_EMAIL = import.meta.env.VITE_PRIVACY_EMAIL;

// What the app actually stores, matching the backend models. Update both together.
const COLLECTED = [
  'Account: email address, username and a hashed password (never the password itself).',
  'About you: age group (or birth year, if you gave one) and, optionally, sex. Other people only ever see a coloured age-group glow; birth year and sex stay private to you and our safety team.',
  'Profile you choose to add: display name, photo, bio, general location, availability.',
  'Safety and security: sign-in sessions (device, browser, IP address and times), two-factor settings, blocks and reports.',
  'Activity: messages, plans, bookings and wallet transactions, needed to run those features.',
];

const REGIONS = [
  { name: 'United States', text: 'State privacy laws (e.g. CCPA/CPRA): ask what we hold, correct it, or delete it. The service is not meant for children under 13 (COPPA).' },
  { name: 'United Kingdom and EU', text: 'UK GDPR / GDPR: access, correct, erase, restrict, move or object to use of your data, and complain to the ICO or your local authority. Young people may need a parent\u2019s consent.' },
  { name: 'South Africa', text: 'POPIA: access, correct or delete your information, object to its use, and complain to the Information Regulator. A parent or guardian must consent for anyone under 18.' },
  { name: 'Nigeria', text: 'NDPA 2023: access, correct, delete, object and port your data, and complain to the Nigeria Data Protection Commission.' },
  { name: 'Elsewhere', text: 'Contact us and we will apply the strongest protections that your local law gives you.' },
];

function ContactLine() {
  if (!PRIVACY_EMAIL && !PRIVACY_URL) return null;
  return (
    <p>
      {PRIVACY_URL && <a href={PRIVACY_URL} target="_blank" rel="noreferrer noopener">Full privacy notice</a>}
      {PRIVACY_URL && PRIVACY_EMAIL && ' \u00b7 '}
      {PRIVACY_EMAIL && <>Requests: <a href={`mailto:${PRIVACY_EMAIL}`}>{PRIVACY_EMAIL}</a></>}
    </p>
  );
}

export default function LegalFootnote({ variant = 'corner' }) {
  const year = new Date().getFullYear();

  if (variant === 'signup') {
    return (
      <p className="legal-note">
        We collect your email, username, age group (or birth year) and, if you choose, sex to run your account, keep
        the community safe and show a colour glow for your age group. Under-18s may need a parent or guardian&rsquo;s
        consent where you live.{' '}
        {PRIVACY_URL
          ? <a href={PRIVACY_URL} target="_blank" rel="noreferrer noopener">Privacy notice</a>
          : 'Details are in Profile \u203a Privacy.'}
      </p>
    );
  }

  if (variant === 'settings') {
    return (
      <aside className="legal-note" aria-label="Privacy and copyright">
        <details>
          <summary>What we collect &amp; your rights</summary>
          <h4>What we collect</h4>
          <ul>{COLLECTED.map((c) => <li key={c}>{c}</li>)}</ul>
          <h4>Your rights, by region</h4>
          <ul>{REGIONS.map((r) => <li key={r.name}><strong>{r.name}.</strong> {r.text}</li>)}</ul>
          <ContactLine />
        </details>
        <p>&copy; {year} {APP_NAME}. All rights reserved.</p>
      </aside>
    );
  }

  return (
    <p className="legal-note legal-note--corner">
      &copy; {year} {APP_NAME}. All rights reserved.
      {PRIVACY_URL && <> &middot; <a href={PRIVACY_URL} target="_blank" rel="noreferrer noopener">Privacy</a></>}
    </p>
  );
}
