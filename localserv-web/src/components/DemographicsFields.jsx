import './age-glow.css';
import { useState } from 'react';
import { AGE_GROUPS, SEX_OPTIONS, ageGroup, ageGroupForBirthYear } from '../utils/ageGroups';

/**
 * Age group (or birth year) + sex. Used by both sign-up forms and by "Your details" in the profile.
 *
 * value    = { ageRange: '', birthYear: '', sex: '' }   ('' sex means "skipped" -> stored as Undisclosed)
 * onChange = (nextValue) => void
 * required = age is required at sign-up; when editing an older account that never answered it is not.
 */
export default function DemographicsFields({ value, onChange, idPrefix = 'demo', required = true }) {
  const [useYear, setUseYear] = useState(Boolean(value.birthYear));
  const thisYear = new Date().getFullYear();
  const yearGroup = useYear ? ageGroup(ageGroupForBirthYear(value.birthYear)) : null;
  const set = (patch) => onChange({ ...value, ...patch });

  return (
    <>
      <fieldset className="demo">
        <legend>Your age</legend>

        {!useYear ? (
          <div className="demo__grid" role="radiogroup" aria-label="Age group">
            {AGE_GROUPS.map((g) => (
              <label key={g.key} data-age={g.key} className={`demo__chip${value.ageRange === g.key ? ' is-on' : ''}`}>
                <input type="radio" name={`${idPrefix}-age`} value={g.key} required={required}
                  checked={value.ageRange === g.key}
                  onChange={() => set({ ageRange: g.key, birthYear: '' })} />
                <span className="age-tag__dot" aria-hidden="true" style={{ background: 'var(--age)' }} />
                {g.label}
              </label>
            ))}
          </div>
        ) : (
          <div>
            <label htmlFor={`${idPrefix}-year`} className="sr-only">Birth year</label>
            <input id={`${idPrefix}-year`} className="input demo__year" type="number" inputMode="numeric"
              placeholder="e.g. 1998" min={thisYear - 120} max={thisYear} required={required}
              value={value.birthYear} onChange={(e) => set({ birthYear: e.target.value, ageRange: '' })} />
            {yearGroup && (
              <span className="demo__hint" role="status">Your group: <strong>{yearGroup.label}</strong></span>
            )}
          </div>
        )}

        <button type="button" className="demo__swap"
          onClick={() => { setUseYear((v) => !v); set({ ageRange: '', birthYear: '' }); }}>
          {useYear ? 'Pick an age group instead' : 'Enter my birth year instead'}
        </button>
        <span className="demo__hint">
          Other people only see a coloured glow for your age group &mdash; never your birth year or exact age.
        </span>
      </fieldset>

      <fieldset className="demo">
        <legend>Sex <span className="opt">(optional)</span></legend>
        <div className="demo__grid" role="radiogroup" aria-label="Sex">
          {SEX_OPTIONS.map((o) => (
            <label key={o.value} className={`demo__chip${value.sex === o.value ? ' is-on' : ''}`}>
              <input type="radio" name={`${idPrefix}-sex`} value={o.value}
                checked={value.sex === o.value} onChange={() => set({ sex: o.value })} />
              {o.label}
            </label>
          ))}
        </div>
        <span className="demo__hint">
          Private: only you and our safety team can see this. Skip it and we record &ldquo;Undisclosed&rdquo;.
          {value.sex && (
            <> <button type="button" className="demo__swap" onClick={() => set({ sex: '' })}>Clear</button></>
          )}
        </span>
      </fieldset>
    </>
  );
}

export const EMPTY_DEMOGRAPHICS = { ageRange: '', birthYear: '', sex: '' };
