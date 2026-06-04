import { describe, it, expect, afterEach } from 'vitest';
import { classifyError } from '../js/app/errors.js';

function setOnline(value) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value });
}
afterEach(() => setOnline(true));

describe('classifyError', () => {
  it('reports a timeout for AbortError', () => {
    expect(classifyError({ name: 'AbortError' })).toMatch(/timed out/i);
  });

  it('reports offline before anything else when navigator is offline', () => {
    setOnline(false);
    // status present, but offline takes precedence (checked before status)
    expect(classifyError({ status: 500 })).toMatch(/no internet/i);
  });

  it('reports a network error when there is no status (and online)', () => {
    setOnline(true);
    expect(classifyError({})).toMatch(/server may be unreachable/i);
  });

  it('maps known HTTP statuses to specific messages', () => {
    setOnline(true);
    expect(classifyError({ status: 400, message: 'bad field' })).toBe('Bad request: bad field');
    expect(classifyError({ status: 401 })).toMatch(/not authorised/i);
    expect(classifyError({ status: 403 })).toMatch(/access denied/i);
    expect(classifyError({ status: 409, message: 'dup' })).toBe('dup');
    expect(classifyError({ status: 422, message: 'invalid' })).toBe('Validation error: invalid');
    expect(classifyError({ status: 404 })).toMatch(/not found/i);
    expect(classifyError({ status: 503 })).toMatch(/server error/i);
  });

  it('falls back to a generic message for other 4xx', () => {
    setOnline(true);
    expect(classifyError({ status: 418, message: 'teapot' })).toBe('Error 418: teapot');
  });

  it('returns the raw message when no rule matches', () => {
    setOnline(true);
    expect(classifyError({ status: 200, message: 'odd' })).toBe('odd');
  });
});
