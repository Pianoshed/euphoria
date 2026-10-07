// One place for how the two kinds of people are named in the UI.
// The API values (PROVIDER / CUSTOMER) never change, only the labels do.
export const ROLE_META = {
  PROVIDER: { label: 'Host', plural: 'Hosts', blurb: 'Plans the hangouts' },
  CUSTOMER: { label: 'Explorer', plural: 'Explorers', blurb: 'Looking for plans to join' },
};

export const roleLabel = (role) => (ROLE_META[role] ? `${ROLE_META[role]} ${ROLE_META[role].label}` : '');
