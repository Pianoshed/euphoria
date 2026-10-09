// Whether this tab is in a call (calling, ringing, connecting or talking). The site-wide ring
// reads it so a second caller gets "busy" instead of ringing over a live call.
let inCall = false;
export const setInCall = (value) => { inCall = Boolean(value); };
export const isInCall = () => inCall;
