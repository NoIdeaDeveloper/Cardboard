import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadScripts } from './helpers/load.js';

const { openModal, closeModal } = loadScripts(
  ['ui.js'],
  ['openModal', 'closeModal'],
);

function setupDom() {
  document.body.innerHTML = `
    <div id="modal-inner"></div>
    <div id="game-modal" style="display:none"></div>
  `;
}

beforeEach(() => {
  vi.useFakeTimers();
  setupDom();
  document.body.style.overflow = '';
});

afterEach(() => {
  vi.useRealTimers();
});

// closeModal defers the counter decrement to a 200 ms fade-out timeout,
// so tests advance the clock past it before asserting.
function flushClose() {
  vi.advanceTimersByTime(250);
}

describe('openModal / closeModal', () => {
  it('locks scroll on open and restores it on close', () => {
    openModal(document.createElement('div'));
    expect(document.body.style.overflow).toBe('hidden');
    closeModal();
    flushClose();
    expect(document.body.style.overflow).toBe('');
  });

  it('rapid open→open sequence still unlocks after a single close', () => {
    openModal(document.createElement('div'));
    openModal(document.createElement('div')); // e.g. double-click firing twice
    closeModal();
    flushClose();
    expect(document.body.style.overflow).toBe('');
  });

  it('double close does not underflow the counter', () => {
    openModal(document.createElement('div'));
    closeModal();
    closeModal(); // ignored while the fade-out is in progress
    flushClose();
    expect(document.body.style.overflow).toBe('');
  });

  it('reopening after close locks scroll again', () => {
    openModal(document.createElement('div'));
    closeModal();
    flushClose();
    openModal(document.createElement('div'));
    expect(document.body.style.overflow).toBe('hidden');
  });
});
