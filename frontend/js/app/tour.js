/**
 * First-visit coach-mark tour, extracted from app.js.
 */
import { state } from './state.js';
/* global API */

export const TOUR_DONE_KEY = 'cardboard_tour_done';

// In-memory guard: set to true the moment any maybeStartTour call claims the check.
// Prevents concurrent calls (loadCollection fires from many places) from each
// independently deciding to start the tour.
let _tourCheckDone = false;

const TOUR_STEPS = [
  {
    targetId: 'nav-btn-stats',
    text: 'See charts, trends, and personalized insights about your collection.',
  },
  {
    targetId: 'game-night-btn',
    text: 'Get smart game suggestions for any group size or time limit.',
    beforeShow() {
      // Return to collection view without re-triggering loadCollection
      if (!document.getElementById('view-collection').classList.contains('active')) {
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.querySelectorAll('[data-view]').forEach(b => b.classList.remove('active'));
        document.getElementById('view-collection').classList.add('active');
        document.querySelectorAll('[data-view="collection"]').forEach(b => b.classList.add('active'));
        location.hash = '';
      }
      // Open the filter panel so game-night-btn has layout
      const panel = document.getElementById('filter-panel');
      if (panel && !panel.classList.contains('open')) panel.classList.add('open');
    },
  },
  {
    targetId: 'collection-search',
    text: 'Search and filter your collection — try typing a game name or mechanic.',
    beforeShow() {
      // Close the filter panel opened for the previous step (if no active filters)
      const panel = document.getElementById('filter-panel');
      const hasFilters = state.filterNeverPlayed || state.filterPlayers || state.filterTime
        || (state.filterMechanics && state.filterMechanics.length)
        || (state.filterCategories && state.filterCategories.length);
      if (panel && panel.classList.contains('open') && !hasFilters) panel.classList.remove('open');
    },
  },
];

export function startTour() {
  let step = 0;
  const overlay  = document.getElementById('tour-overlay');
  const tooltip  = document.getElementById('tour-tooltip');

  // Create spotlight ring element
  let spotlight = document.getElementById('tour-spotlight');
  if (!spotlight) {
    spotlight = document.createElement('div');
    spotlight.id = 'tour-spotlight';
    spotlight.className = 'tour-spotlight';
    document.body.appendChild(spotlight);
  }

  function showStep(i) {
    const stepDef = TOUR_STEPS[i];
    if (stepDef.beforeShow) {
      stepDef.beforeShow();
      setTimeout(() => _positionStep(i), 300);
    } else {
      _positionStep(i);
    }
  }

  function _positionStep(i) {
    const { targetId, text } = TOUR_STEPS[i];
    const target = document.getElementById(targetId);
    if (!target) { nextStep(); return; }

    const rect = target.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) { nextStep(); return; }

    // Scroll target into view if it's off-screen
    if (rect.top < 0 || rect.bottom > window.innerHeight) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => _positionStep(i), 400);
      return;
    }

    const PAD = 6;
    const isLast = i === TOUR_STEPS.length - 1;

    overlay.style.display = 'block';
    spotlight.style.display = 'block';
    spotlight.style.top    = `${rect.top - PAD}px`;
    spotlight.style.left   = `${rect.left - PAD}px`;
    spotlight.style.width  = `${rect.width + PAD * 2}px`;
    spotlight.style.height = `${rect.height + PAD * 2}px`;

    // Place tooltip below target, clamped to viewport
    const tipLeft = Math.min(Math.max(rect.left, 12), window.innerWidth - 320 - 12);
    const tipTop  = rect.bottom + PAD + 8;

    tooltip.innerHTML = `
      <p id="tour-tooltip-text">${escapeHtml(text)}</p>
      <div class="tour-btn-row">
        <button class="tour-btn tour-btn-skip" id="tour-skip">Skip tour</button>
        <button class="tour-btn tour-btn-next" id="tour-next">${isLast ? 'Done' : 'Got it \u2192'}</button>
      </div>`;
    tooltip.style.left = `${tipLeft}px`;
    tooltip.style.top  = `${tipTop}px`;
    tooltip.style.display = 'block';

    tooltip.querySelector('#tour-next').addEventListener('click', nextStep);
    tooltip.querySelector('#tour-skip').addEventListener('click', endTour);
  }

  function nextStep() {
    step += 1;
    if (step >= TOUR_STEPS.length) { endTour(); return; }
    showStep(step);
  }

  async function endTour() {
    overlay.style.display   = 'none';
    tooltip.style.display   = 'none';
    spotlight.style.display = 'none';
    _tourCheckDone = true;
    try { localStorage.setItem(TOUR_DONE_KEY, '1'); } catch (_) { /* quota or private browsing */ }
    // Await the server call so the flag persists even across browsers/devices.
    // Without this, closing the tab immediately after completing the tour can
    // abort the fetch and leave the server-side flag unset, causing the tour to
    // reappear on the next visit from a different browser.
    try { await API.setSetting(TOUR_DONE_KEY, '1'); } catch (_) { /* non-fatal */ }
  }

  showStep(0);
}

export async function maybeStartTour() {
  if (_tourCheckDone) return;
  if (!state.games || state.games.length === 0) return;
  // Fast path: localStorage cache avoids a server round-trip on repeat visits
  let localDone = false;
  try { localDone = !!localStorage.getItem(TOUR_DONE_KEY); } catch (_) { /* quota or unavailable */ }
  if (localDone) { _tourCheckDone = true; return; }
  // Claim the check before any await so concurrent calls from other loadCollection
  // invocations bail out immediately rather than each starting their own tour.
  _tourCheckDone = true;
  try {
    const { value } = await API.getSetting(TOUR_DONE_KEY);
    if (value === '1') {
      // Sync local cache so future page loads skip the server call
      try { localStorage.setItem(TOUR_DONE_KEY, '1'); } catch (_) { /* non-fatal */ }
      return;
    }
  } catch (_) {
    // If the server is unreachable, fall through and show the tour
  }
  // Brief delay so the collection renders first
  setTimeout(startTour, 600);
}

export async function resetTour() {
  try { localStorage.removeItem(TOUR_DONE_KEY); } catch (_) { /* quota or unavailable */ }
  try { await API.setSetting(TOUR_DONE_KEY, ''); } catch (_) { /* non-fatal */ }
  _tourCheckDone = false;
  startTour();
}
