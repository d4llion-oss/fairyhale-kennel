'use strict';
// The kennel's local timezone. Set once, before any Date is created, so every
// toLocaleString()/local-time parse in the app (and the datetime-local form
// fields) use kennel time instead of the container's UTC clock.
const TZ = process.env.KENNEL_TIMEZONE || process.env.REPORT_TIMEZONE || 'America/Chicago';
process.env.TZ = TZ;

/** Format a Date for a <input type="datetime-local"> value, in kennel time. */
function toLocalInput(d) {
  const x = new Date(d);
  const pad = (n) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}T${pad(x.getHours())}:${pad(x.getMinutes())}`;
}

module.exports = { TZ, toLocalInput };
