/**
 * Pure formatting helpers extracted from ui.js for unit testing.
 */

/**
 * Human-readable "owned for" duration since a date.
 * Returns e.g. "less than a month", "3m", "2y", "1y 4m".
 */
export function ownedFor(dateAdded, now = new Date()) {
  const added = new Date(dateAdded);
  let months = (now.getFullYear() - added.getFullYear()) * 12 + (now.getMonth() - added.getMonth());
  if (months < 1) return 'less than a month';
  const years = Math.floor(months / 12);
  months = months % 12;
  if (years && months) return `${years}y ${months}m`;
  if (years) return `${years}y`;
  return `${months}m`;
}