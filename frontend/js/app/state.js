/**
 * Collection preferences + shared application state, extracted from app.js.
 *
 * loadJsonFromStorage / saveJsonToStorage are globals provided by ui-helpers.js
 * in the classic bundle at runtime (and stubbed in tests). app.js imports the
 * exported `state` object and mutates its properties in place — it is never
 * reassigned, so the shared reference stays valid across modules.
 */

const COLLECTION_PREFS_KEY = 'cardboard_collection_prefs';
const COLLECTION_PREFS_DEFAULTS = {
  sortBy: 'name', sortDir: 'asc', viewMode: 'grid', statusFilter: 'owned',
  search: '',
  filterNeverPlayed: false,
  filterPlayers: null,
  filterTime: null,
  filterMechanics: [],
  filterCategories: [],
  filterLocation: null,
};

// Mirrors NO_LOCATION_SENTINEL in backend/constants.py.
export const NO_LOCATION_SENTINEL = '__none__';

export function loadCollectionPrefs() {
  const raw = { ...COLLECTION_PREFS_DEFAULTS, ...loadJsonFromStorage(COLLECTION_PREFS_KEY, {}) };
  // Defensive coercion: localStorage can be edited by users / older versions.
  if (!Array.isArray(raw.filterMechanics))  raw.filterMechanics  = [];
  if (!Array.isArray(raw.filterCategories)) raw.filterCategories = [];
  return raw;
}

const _cp = loadCollectionPrefs();

export const state = {
  games: [],
  filteredGames: [],  // current filtered view (updated by renderCollection)
  collectionStats: null,  // pre-aggregated collection stats from server
  virtualOffset: 0,       // how many cards have been appended so far
  serverOffset: 0,        // offset of the next server page to fetch
  serverTotal: 0,         // total matching games on the server
  players: [],        // known player names for autocomplete
  playerObjects: [],  // full player objects (id, name, avatar_url, …)
  viewMode: _cp.viewMode,
  sortBy: _cp.sortBy,
  sortDir: _cp.sortDir,
  search: _cp.search,
  statusFilter: _cp.statusFilter,
  filterNeverPlayed: _cp.filterNeverPlayed,
  filterPlayers: _cp.filterPlayers,
  filterTime: _cp.filterTime,
  filterMechanics: _cp.filterMechanics,
  filterCategories: _cp.filterCategories,
  filterLocation: _cp.filterLocation,
  showExpansions: false,
  bulkMode: false,
  selectedGameIds: new Set(),
};

export function saveCollectionPrefs() {
  saveJsonToStorage(COLLECTION_PREFS_KEY, {
    sortBy: state.sortBy, sortDir: state.sortDir,
    viewMode: state.viewMode, statusFilter: state.statusFilter,
    search: state.search,
    filterNeverPlayed: state.filterNeverPlayed,
    filterPlayers: state.filterPlayers,
    filterTime: state.filterTime,
    filterMechanics: state.filterMechanics,
    filterCategories: state.filterCategories,
    filterLocation: state.filterLocation,
  });
}
