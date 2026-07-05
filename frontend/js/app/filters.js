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
    labels: state.filterLabels.length ? state.filterLabels.join(',') : undefined,
    designers: state.filterDesigners.length ? state.filterDesigners.join(',') : undefined,
    publishers: state.filterPublishers.length ? state.filterPublishers.join(',') : undefined,
    condition: state.filterCondition || undefined,
    loaned: state.filterLoaned,
    price_min: state.filterPriceMin != null ? state.filterPriceMin : undefined,
    price_max: state.filterPriceMax != null ? state.filterPriceMax : undefined,
    location: state.filterLocation || undefined,
    limit: SERVER_PAGE_SIZE,
    offset,
  };
}

// True when any non-default filter (beyond status/search/sort) is active.
export function hasActiveFilters() {
  return state.filterNeverPlayed || state.filterPlayers !== null ||
    state.filterTime !== null || state.filterMechanics.length > 0 ||
    state.filterCategories.length > 0 || state.filterLabels.length > 0 ||
    state.filterDesigners.length > 0 || state.filterPublishers.length > 0 ||
    state.filterCondition !== null || state.filterLoaned !== null ||
    state.filterPriceMin != null || state.filterPriceMax != null ||
    state.filterLocation !== null;
}

export function _activeFilterCount() {
  let count = 0;
  if (state.filterNeverPlayed) count++;
  if (state.filterPlayers !== null) count++;
  if (state.filterTime !== null) count++;
  count += state.filterMechanics.length;
  count += state.filterCategories.length;
  count += state.filterLabels.length;
  count += state.filterDesigners.length;
  count += state.filterPublishers.length;
  if (state.filterCondition !== null) count++;
  if (state.filterLoaned !== null) count++;
  if (state.filterPriceMin != null) count++;
  if (state.filterPriceMax != null) count++;
  if (state.filterLocation !== null) count++;
  return count;
}
