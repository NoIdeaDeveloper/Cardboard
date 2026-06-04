import { describe, it, expect } from 'vitest';
import { loadScripts } from './helpers/load.js';

const {
  escapeHtml, parseList, pluralize, formatDate,
  formatPlaytime, formatPlayers, renderPlayerAvatar,
} = loadScripts(
  ['shared-utils.js'],
  ['escapeHtml', 'parseList', 'pluralize', 'formatDate',
    'formatPlaytime', 'formatPlayers', 'renderPlayerAvatar'],
);

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`))
      .toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });
  it('returns empty string for null/undefined', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
  it('escapes ampersands before other entities (no double-escaping)', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });
});

describe('parseList', () => {
  it('parses a JSON array', () => {
    expect(parseList('["a","b"]')).toEqual(['a', 'b']);
  });
  it('returns [] for null, empty, non-arrays, and malformed JSON', () => {
    expect(parseList(null)).toEqual([]);
    expect(parseList('')).toEqual([]);
    expect(parseList('{"a":1}')).toEqual([]);
    expect(parseList('not json')).toEqual([]);
  });
});

describe('pluralize', () => {
  it('uses the singular form for exactly 1', () => {
    expect(pluralize(1, 'player')).toBe('1 player');
  });
  it('appends s by default for non-1 counts', () => {
    expect(pluralize(0, 'player')).toBe('0 players');
    expect(pluralize(3, 'player')).toBe('3 players');
  });
  it('uses an explicit plural form when given', () => {
    expect(pluralize(2, 'die', 'dice')).toBe('2 dice');
  });
});

describe('formatDate', () => {
  it('formats an ISO date as D MMM YYYY (en-GB)', () => {
    expect(formatDate('2025-01-09')).toBe('9 Jan 2025');
  });
  it('returns empty string for falsy input', () => {
    expect(formatDate('')).toBe('');
    expect(formatDate(null)).toBe('');
  });
  it('returns the input unchanged when unparseable', () => {
    expect(formatDate('garbage')).toBe('garbage');
  });
});

describe('formatPlaytime', () => {
  it('returns empty string when both bounds are missing', () => {
    expect(formatPlaytime(0, 0)).toBe('');
    expect(formatPlaytime(null, null)).toBe('');
  });
  it('shows a single value when equal or max missing', () => {
    expect(formatPlaytime(30, 30)).toBe('30 min');
    expect(formatPlaytime(30, null)).toBe('30 min');
  });
  it('shows a range with an en dash', () => {
    expect(formatPlaytime(30, 60)).toBe('30–60 min');
  });
});

describe('formatPlayers', () => {
  it('returns empty string when both bounds are missing', () => {
    expect(formatPlayers(null, null)).toBe('');
  });
  it('pluralizes a single player count', () => {
    expect(formatPlayers(1, 1)).toBe('1 player');
    expect(formatPlayers(4, 4)).toBe('4 players');
  });
  it('shows a range', () => {
    expect(formatPlayers(2, 4)).toBe('2–4 players');
  });
});

describe('renderPlayerAvatar', () => {
  it('renders an <img> when the player has an avatar_url', () => {
    const html = renderPlayerAvatar({ name: 'Bob', avatar_url: '/avatars/bob.svg' });
    expect(html).toContain('<img');
    expect(html).toContain('src="/avatars/bob.svg"');
    expect(html).toContain('player-avatar-img');
  });
  it('derives the URL from an avatar_preset', () => {
    const html = renderPlayerAvatar({ name: 'Sue', avatar_preset: 'fox' });
    expect(html).toContain('src="/avatars/fox.svg"');
  });
  it('falls back to an initials div when there is no image', () => {
    const html = renderPlayerAvatar({ name: 'Zoe' });
    expect(html).toContain('<div');
    expect(html).not.toContain('<img');
    expect(html.toUpperCase()).toContain('ZO');
  });
  it('honours a custom css class', () => {
    const html = renderPlayerAvatar({ name: 'A', avatar_url: '/x.svg' }, 'mini-avatar');
    expect(html).toContain('mini-avatar');
  });
});
