import { describe, it, expect, beforeEach } from 'vitest';
import { state } from '../js/app/state.js';
import {
  SERVER_PAGE_SIZE, buildFilterParams, hasActiveFilters, _activeFilterCount,
} from '../js/app/filters.js';

// Reset the shared state to a clean baseline before each test.
beforeEach(() => {
  Object.assign(state, {
    sortBy: 'name', sortDir: 'asc', viewMode: 'grid', statusFilter: 'owned',
    search: '', showExpansions: false,
    filterNeverPlayed: false, filterPlayers: null, filterTime: null,
    filterMechanics: [], filterCategories: [], filterLocation: null,
  });
});

describe('buildFilterParams', () => {
  it('omits inactive filters (leaves them undefined) and sets paging', () => {
    const p = buildFilterParams(0);
    expect(p.sort_by).toBe('name');
    expect(p.status).toBe('owned');
    expect(p.search).toBeUndefined();
    expect(p.never_played).toBeUndefined();
    expect(p.mechanics).toBeUndefined();
    expect(p.limit).toBe(SERVER_PAGE_SIZE);
    expect(p.offset).toBe(0);
  });

  it('treats statusFilter "all" as no status filter', () => {
    state.statusFilter = 'all';
    expect(buildFilterParams(0).status).toBeUndefined();
  });

  it('maps a single player filter to both min and max players', () => {
    state.filterPlayers = 4;
    const p = buildFilterParams(0);
    expect(p.min_players).toBe(4);
    expect(p.max_players).toBe(4);
  });

  it('joins multi-value tag filters into comma strings', () => {
    state.filterMechanics = ['Deck Building', 'Drafting'];
    state.filterCategories = ['Economic'];
    const p = buildFilterParams(40);
    expect(p.mechanics).toBe('Deck Building,Drafting');
    expect(p.categories).toBe('Economic');
    expect(p.offset).toBe(40);
  });

  it('passes include_expansions only when showExpansions is on', () => {
    expect(buildFilterParams(0).include_expansions).toBeUndefined();
    state.showExpansions = true;
    expect(buildFilterParams(0).include_expansions).toBe(true);
  });
});

describe('hasActiveFilters', () => {
  it('is false at baseline', () => {
    expect(hasActiveFilters()).toBe(false);
  });
  it('ignores status/search/sort (not counted as "filters")', () => {
    state.statusFilter = 'wishlist';
    state.search = 'catan';
    expect(hasActiveFilters()).toBe(false);
  });
  it('is true when any real filter is set', () => {
    state.filterNeverPlayed = true;
    expect(hasActiveFilters()).toBe(true);
    state.filterNeverPlayed = false;
    state.filterLocation = 'Shelf A';
    expect(hasActiveFilters()).toBe(true);
  });
});

describe('_activeFilterCount', () => {
  it('counts each scalar filter once and each tag individually', () => {
    state.filterNeverPlayed = true;          // +1
    state.filterPlayers = 3;                  // +1
    state.filterMechanics = ['a', 'b', 'c'];  // +3
    state.filterCategories = ['x'];           // +1
    state.filterLocation = 'Shelf A';         // +1
    expect(_activeFilterCount()).toBe(7);
  });
  it('is zero at baseline', () => {
    expect(_activeFilterCount()).toBe(0);
  });
});
