/**
 * Pure client-side game-array sorting, extracted from app.js.
 *
 * Nulls sort last in ascending order and first in descending, matching the
 * server's SQLite default ordering so client and server agree. Name sorting
 * strips a leading "The " and is case-insensitive.
 */
export function sortGames(games, sortBy, sortDir) {
  const asc = sortDir !== 'desc';
  return [...games].sort((a, b) => {
    let av, bv;
    if (!sortBy || sortBy === 'name') {
      const strip = s => (s || '').replace(/^the\s+/i, '').toLowerCase();
      av = strip(a.name);
      bv = strip(b.name);
    } else {
      av = a[sortBy] ?? null;
      bv = b[sortBy] ?? null;
    }
    // Nulls last in asc, first in desc — matches SQLite default behaviour
    if (av === null && bv === null) return 0;
    if (av === null) return asc ? 1 : -1;
    if (bv === null) return asc ? -1 : 1;
    if (av < bv) return asc ? -1 : 1;
    if (av > bv) return asc ? 1 : -1;
    return 0;
  });
}
