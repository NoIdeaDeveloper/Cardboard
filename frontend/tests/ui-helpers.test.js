import { describe, it, expect } from 'vitest';
import { loadScripts } from './helpers/load.js';

// ui-helpers references escapeHtml from shared-utils, so load both together.
const {
  renderStars, renderDifficultyBar, formatDatetime, isSafeUrl,
  loadJsonFromStorage, saveJsonToStorage, cardMediaHtml, placeholderSvg,
} = loadScripts(
  ['shared-utils.js', 'ui-helpers.js'],
  ['renderStars', 'renderDifficultyBar', 'formatDatetime', 'isSafeUrl',
    'loadJsonFromStorage', 'saveJsonToStorage', 'cardMediaHtml', 'placeholderSvg'],
);

describe('renderStars', () => {
  it('renders 10 stars total, rounding the rating for the filled count', () => {
    const html = renderStars(3);
    expect((html.match(/class="star/g) || []).length).toBe(10);
    expect((html.match(/class="star"/g) || []).length).toBe(3);   // filled
    expect((html.match(/class="star empty"/g) || []).length).toBe(7);
  });
  it('rounds half ratings up', () => {
    const html = renderStars(7.5);
    expect((html.match(/class="star"/g) || []).length).toBe(8);
  });
  it('treats a missing rating as zero filled', () => {
    const html = renderStars(null);
    expect((html.match(/class="star empty"/g) || []).length).toBe(10);
  });
});

describe('renderDifficultyBar', () => {
  it('returns empty string for falsy difficulty', () => {
    expect(renderDifficultyBar(0)).toBe('');
    expect(renderDifficultyBar(null)).toBe('');
  });
  it('labels by band: Light / Medium / Heavy', () => {
    expect(renderDifficultyBar(1.5)).toContain('Light');
    expect(renderDifficultyBar(3)).toContain('Medium');
    expect(renderDifficultyBar(4.2)).toContain('Heavy');
  });
  it('fills segments equal to the rounded difficulty', () => {
    const html = renderDifficultyBar(3);
    expect((html.match(/diff-segment filled/g) || []).length).toBe(3);
  });
});

describe('formatDatetime', () => {
  it('returns null for falsy input', () => {
    expect(formatDatetime(null)).toBeNull();
    expect(formatDatetime('')).toBeNull();
  });
  it('returns the input unchanged when unparseable', () => {
    expect(formatDatetime('nonsense')).toBe('nonsense');
  });
  it('formats a valid datetime to a date string', () => {
    expect(formatDatetime('2025-03-15T12:00:00Z')).toContain('2025');
  });
});

describe('isSafeUrl', () => {
  it('accepts api-relative and http(s) URLs', () => {
    expect(isSafeUrl('/api/games/1/image')).toBe(true);
    expect(isSafeUrl('https://example.com/x.jpg')).toBe(true);
    expect(isSafeUrl('http://example.com/x.jpg')).toBe(true);
  });
  it('rejects empty and non-http schemes', () => {
    expect(isSafeUrl('')).toBe(false);
    expect(isSafeUrl(null)).toBe(false);
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeUrl('/relative/path')).toBe(false);
  });
});

describe('JSON localStorage helpers', () => {
  it('round-trips a value', () => {
    saveJsonToStorage('rt-key', { a: 1, b: [2, 3] });
    expect(loadJsonFromStorage('rt-key', null)).toEqual({ a: 1, b: [2, 3] });
  });
  it('returns the default when the key is absent', () => {
    expect(loadJsonFromStorage('absent-key', 'DEF')).toBe('DEF');
  });
  it('returns the default when stored value is malformed JSON', () => {
    localStorage.setItem('bad-key', '{not json');
    expect(loadJsonFromStorage('bad-key', [])).toEqual([]);
  });
});

describe('cardMediaHtml', () => {
  it('renders an <img> for a game with a safe image URL', () => {
    const html = cardMediaHtml({ name: 'Catan', image_url: 'https://x/c.jpg' });
    expect(html).toContain('<img');
    expect(html).toContain('https://x/c.jpg');
  });
  it('falls back to the placeholder svg when the URL is unsafe/missing', () => {
    expect(cardMediaHtml({ name: 'X' })).toContain('placeholder-icon');
    expect(cardMediaHtml({ name: 'X', image_url: 'javascript:1' })).toContain('placeholder-icon');
  });
});
