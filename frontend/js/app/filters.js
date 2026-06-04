/**
 * Filter and pagination helpers, extracted from app.js.
 *
 * All read the shared `state` object from state.js; none touch the DOM, so they
 * are unit-testable by mutating `state` and asserting on the return value.
 */
import { state } from './state.js';

// Games fetched per server request (collection pagination page size).
export const SERVER_PAGE_SIZE = 200;

// Build the query-param object for GET /api/games from the current filter state.
// undefined values are dropped by the API layer's param serializer.
export function buildFilterParams(offset) {
  return {
    sort_by: state.sortBy || undefined,
    sort_dir: state.sortDir || undefined,
    include_expansions: state.showExpansions ? true : false,
    status: state.statusFilter !== 'all' ? state.statusFilter : undefined,
    search: state.search || undefined,
    never_played: state.filterNeverPlayed || undefined,
    min_players: state.filterPlayers || undefined,
    max_players: state.filterPlayers || undefined,
    min_playtime: state.filterTime || undefined,
    max_playtime: state.filterTime || undefined,
    mechanics: state.filterMechanics.length ? state.filterMechanics.join(',') : undefined,
    categories: state.filterCategories.length ? state.filterCategories.join(',') : undefined,
    location: state.filterLocation || undefined,
    limit: SERVER_PAGE_SIZE,
    offset,
  };
}

// True when any non-default filter (beyond status/search/sort) is active.
export function hasActiveFilters() {
  return state.filterNeverPlayed || state.filterPlayers !== null ||
    state.filterTime !== null || state.filterMechanics.length > 0 ||
    state.filterCategories.length > 0 || state.filterLocation !== null;
}

export function _activeFilterCount() {
  let count = 0;
  if (state.filterNeverPlayed) count++;
  if (state.filterPlayers !== null) count++;
  if (state.filterTime !== null) count++;
  count += state.filterMechanics.length;
  count += state.filterCategories.length;
  if (state.filterLocation !== null) count++;
  return count;
}
