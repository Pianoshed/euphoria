import '../../styles/index.css';
// The "I want to..." picker shared by Register and Onboarding.
// onChange receives the chosen value (not the event).

export const ROLE_OPTIONS = [
  {
    value: 'CUSTOMER',
    title: "I'm looking for things to do",
    description: 'Discover local meetups, activities, and people hosting them near you.',
  },
  {
    value: 'PROVIDER',
    title: 'I want to host hangouts',
    description: 'List an activity, set the vibe, and get discovered by people looking to join.',
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
