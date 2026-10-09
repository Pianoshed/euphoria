// Age groups and sex options collected at sign-up.
//
// Keys MUST match apps.common.constants.AgeRange / Sex on the server. The server is the source of truth:
// it turns a birth year into a group itself, so the helpers here only drive the UI (hints and previews).
// Colours live in components/age-glow.css (one place), keyed by data-age="<key>".

export const AGE_GROUPS = [
  { key: 'UNDER_16', label: 'Under 16' },
  { key: 'AGE_16_25', label: '16\u201325' },
  { key: 'AGE_26_35', label: '26\u201335' },
  { key: 'AGE_36_60', label: '36\u201360' },
  { key: 'OVER_60', label: 'Over 60' },
];

const BY_KEY = Object.fromEntries(AGE_GROUPS.map((g) => [g.key, g]));
export const ageGroup = (key) => BY_KEY[key] || null;

// Same cut-offs as age_range_for_age() in apps/common/constants.py.
export function ageGroupForAge(age) {
  if (age < 16) return 'UNDER_16';
  if (age <= 25) return 'AGE_16_25';
  if (age <= 35) return 'AGE_26_35';
  if (age <= 60) return 'AGE_36_60';
  return 'OVER_60';
}

export const ageGroupForBirthYear = (year, now = new Date().getFullYear()) => {
  const y = Number(year);
  if (!Number.isInteger(y) || y < 1900 || y > now) return null;
  return ageGroupForAge(now - y);
};

export const SEX_OPTIONS = [
  { value: 'M', label: 'Male' },
  { value: 'F', label: 'Female' },
  { value: 'PNS', label: 'Prefer not to say' },
];
export const SEX_UNDISCLOSED = 'UNDISCLOSED';

export const sexLabel = (value) =>
  SEX_OPTIONS.find((o) => o.value === value)?.label || 'Undisclosed';

// Form state -> API fields. A birth year wins over a picked group (the server derives the group from it).
// Sex left blank is sent as UNDISCLOSED so "skipped" is stored explicitly.
export function demographicsPayload({ ageRange, birthYear, sex }, { onlyIfChanged = null } = {}) {
  const out = { sex: sex || SEX_UNDISCLOSED };
  const yearChanged = !onlyIfChanged || String(birthYear || '') !== String(onlyIfChanged.birthYear || '');
  const groupChanged = !onlyIfChanged || (ageRange || '') !== (onlyIfChanged.ageRange || '');
  if (birthYear && yearChanged) out.birth_year = Number(birthYear);
  else if (!birthYear && ageRange && groupChanged) out.age_range = ageRange;
  return out;
}

// Spread onto an element to give it the age-group glow. Unknown / empty group = no glow.
export const ageGlowProps = (key) => (ageGroup(key) ? { 'data-age': key } : {});
