import './age-glow.css';
import { AGE_GROUPS, ageGroup } from '../utils/ageGroups';

/** "● 16–25" tag. Renders nothing when the group is unknown (older accounts that never answered). */
export function AgeTag({ group, prefix = '' }) {
  const g = ageGroup(group);
  if (!g) return null;
  return (
    <span className="age-tag" data-age={g.key}>
      <span className="age-tag__dot" aria-hidden="true" />
      <span>{prefix}{g.label}</span>
    </span>
  );
}

/** Key to the glow colours, so the outlines mean something to the people looking at them. */
export function AgeLegend() {
  return (
    <p className="age-legend" aria-label="Glow colour key: age group">
      <span className="age-legend__title">Glow = age group</span>
      {AGE_GROUPS.map((g) => <AgeTag key={g.key} group={g.key} />)}
    </p>
  );
}
