import { describe, it, expect } from 'vitest';
import { sortGames } from '../js/app/sort.js';

const names = (arr) => arr.map((g) => g.name);

describe('sortGames', () => {
  it('does not mutate the input array', () => {
    const input = [{ name: 'B' }, { name: 'A' }];
    const copy = [...input];
    sortGames(input, 'name', 'asc');
    expect(input).toEqual(copy);
  });

  it('sorts by name ascending, case-insensitively and ignoring a leading "The "', () => {
    const games = [{ name: 'Zoo' }, { name: 'The Apple' }, { name: 'banana' }];
    expect(names(sortGames(games, 'name', 'asc'))).toEqual(['The Apple', 'banana', 'Zoo']);
  });

  it('defaults to name sort when sortBy is falsy', () => {
    const games = [{ name: 'b' }, { name: 'a' }];
    expect(names(sortGames(games, null, 'asc'))).toEqual(['a', 'b']);
  });

  it('reverses order for descending', () => {
    const games = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
    expect(names(sortGames(games, 'name', 'desc'))).toEqual(['c', 'b', 'a']);
  });

  it('sorts by a numeric field', () => {
    const games = [
      { name: 'x', user_rating: 7 },
      { name: 'y', user_rating: 3 },
      { name: 'z', user_rating: 9 },
    ];
    expect(names(sortGames(games, 'user_rating', 'asc'))).toEqual(['y', 'x', 'z']);
    expect(names(sortGames(games, 'user_rating', 'desc'))).toEqual(['z', 'x', 'y']);
  });

  it('places nulls last in ascending and first in descending', () => {
    const games = [
      { name: 'has', user_rating: 5 },
      { name: 'none', user_rating: null },
      { name: 'alsohas', user_rating: 8 },
    ];
    expect(names(sortGames(games, 'user_rating', 'asc'))).toEqual(['has', 'alsohas', 'none']);
    expect(names(sortGames(games, 'user_rating', 'desc'))).toEqual(['none', 'alsohas', 'has']);
  });

  it('treats a missing field as null (sorts last ascending)', () => {
    const games = [{ name: 'with', difficulty: 2 }, { name: 'without' }];
    expect(names(sortGames(games, 'difficulty', 'asc'))).toEqual(['with', 'without']);
  });
});
