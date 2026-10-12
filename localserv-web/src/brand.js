// One place for the public brand. Change it here, not in individual components.
// (Internal keys/events such as 'euphoria-theme' or 'euphoria.dataSaver' are deliberately NOT renamed:
// they are stored in people's browsers and renaming them would reset saved settings.)
export const BRAND_NAME = 'Hiclr';            // prose, titles, emails ("Hiclr"); the logo itself is lowercase "hiclr"
export const BRAND_TAGLINE = 'Your vibe. Your people.';
export const BRAND_PRONUNCIATION = 'Hi-colour';
export const BRAND_DESCRIPTION =
  'Find your people on Hiclr. Discover shared interests, express yourself, join conversations and connect through chats and hangouts.';

export const BRAND_COLORS = {
  coral: '#E76A52',
  blue: '#4263EB',
  lilac: '#A16AE8',
  cream: '#FFF8F1',
  ink: '#24213A',
};

// All brand file paths in one place (files live in public/brand/).
export const BRAND_ASSETS = {
  introWebm: '/brand/hiclr-intro.webm',
  introMp4: '/brand/hiclr-intro.mp4',
  logoLight: '/brand/hiclr-logo-light.webp', // transparent, dark ink: for light surfaces
  logoDark: '/brand/hiclr-logo-dark.webp',   // final frame of the intro (black bg): for dark surfaces, used with blend-mode: screen
};
