import '../../styles/index.css';
// The "I want to..." picker shared by Register and Onboarding.
// onChange receives the chosen value (not the event).

export const ROLE_OPTIONS = [
  {
    value: 'CUSTOMER',
    title: "🧭 I'm an Explorer",
    description: 'Find hangouts near you, meet new people and jump into the fun.',
  },
  {
    value: 'PROVIDER',
    title: "✨ I'm a Host",
    description: 'Plan a hangout, set the vibe and let people come to you.',
  },
];

export default function RoleChoice({ value, onChange, name = 'role' }) {
  return (
    <fieldset className="role-choice">
      <legend>I want to…</legend>
      <div className="role-choice__grid">
        {ROLE_OPTIONS.map((opt) => (
          <label key={opt.value} className={`role-card${value === opt.value ? ' role-card--active' : ''}`}>
            <input
              type="radio"
              name={name}
              value={opt.value}
              checked={value === opt.value}
              onChange={() => onChange(opt.value)}
            />
            <span>
              <span className="role-card__title">{opt.title}</span>
              <span className="role-card__desc">{opt.description}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
