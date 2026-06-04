import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadCollectionPrefs, saveCollectionPrefs, state, NO_LOCATION_SENTINEL,
} from '../js/app/state.js';

const PREFS_KEY = 'cardboard_collection_prefs';

describe('NO_LOCATION_SENTINEL', () => {
  it('matches the backend constant', () => {
    expect(NO_LOCATION_SENTINEL).toBe('__none__');
  });
});

describe('loadCollectionPrefs', () => {
  beforeEach(() => localStorage.removeItem(PREFS_KEY));

  it('returns defaults when nothing is stored', () => {
    const p = loadCollectionPrefs();
    expect(p.sortBy).toBe('name');
    expect(p.sortDir).toBe('asc');
    expect(p.statusFilter).toBe('owned');
    expect(p.filterMechanics).toEqual([]);
  });

  it('merges stored values over defaults', () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ sortBy: 'user_rating', sortDir: 'desc' }));
    const p = loadCollectionPrefs();
    expect(p.sortBy).toBe('user_rating');
    expect(p.sortDir).toBe('desc');
    expect(p.statusFilter).toBe('owned'); // untouched default
  });

  it('coerces non-array filter fields back to arrays (defensive against tampering)', () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      filterMechanics: 'not-an-array',
      filterCategories: 42,
    }));
    const p = loadCollectionPrefs();
    expect(p.filterMechanics).toEqual([]);
    expect(p.filterCategories).toEqual([]);
  });

  it('preserves valid array filter values', () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ filterMechanics: ['Deck Building'] }));
    expect(loadCollectionPrefs().filterMechanics).toEqual(['Deck Building']);
  });
});

describe('saveCollectionPrefs', () => {
  it('persists the current state prefs and they reload identically', () => {
    state.sortBy = 'last_played';
    state.sortDir = 'desc';
    state.statusFilter = 'wishlist';
    state.filterMechanics = ['Worker Placement'];
    saveCollectionPrefs();

    const reloaded = loadCollectionPrefs();
    expect(reloaded.sortBy).toBe('last_played');
    expect(reloaded.sortDir).toBe('desc');
    expect(reloaded.statusFilter).toBe('wishlist');
    expect(reloaded.filterMechanics).toEqual(['Worker Placement']);
  });

  it('only persists the prefs subset, not transient state like games[]', () => {
    state.games = [{ id: 1, name: 'X' }];
    saveCollectionPrefs();
    const stored = JSON.parse(localStorage.getItem(PREFS_KEY));
    expect(stored).not.toHaveProperty('games');
    expect(stored).toHaveProperty('sortBy');
  });
});
