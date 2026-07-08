/**
 * Cardboard – main application logic
 */

import { state, saveCollectionPrefs, NO_LOCATION_SENTINEL } from './app/state.js';
import { sortGames } from './app/sort.js';
import { SERVER_PAGE_SIZE, buildFilterParams, hasActiveFilters, _activeFilterCount } from './app/filters.js';
import { classifyError } from './app/errors.js';
import { wireGoalsSection } from './app/goals.js';
import { bindExportModal } from './app/export.js';
import { maybeStartTour, resetTour } from './app/tour.js';

// Service-worker registration — moved out of an inline <script> in index.html
// so it complies with the CSP `script-src 'self'` directive (inline scripts,
// having no nonce/hash, were being blocked and the SW never registered).
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

(function () {
  'use strict';

  // ===== URL Sync for Shareable Filtered Views =====

  function syncUrlParams() {
    const params = new URLSearchParams();
    if (state.statusFilter && state.statusFilter !== 'owned') params.set('status', state.statusFilter);
    if (state.search) params.set('q', state.search);
    if (state.sortBy && state.sortBy !== 'name') params.set('sort', state.sortBy + (state.sortDir === 'desc' ? '_desc' : ''));
    if (state.viewMode && state.viewMode !== 'grid') params.set('view', state.viewMode);
    if (state.filterNeverPlayed) params.set('never_played', '1');
    if (state.filterPlayers !== null) params.set('players', String(state.filterPlayers));
    if (state.filterTime !== null) params.set('time', String(state.filterTime));
    if (state.filterMechanics.length) params.set('mechanics', state.filterMechanics.join(','));
    if (state.filterCategories.length) params.set('categories', state.filterCategories.join(','));
    if (state.filterLabels.length) params.set('labels', state.filterLabels.join(','));
    if (state.filterDesigners.length) params.set('designers', state.filterDesigners.join(','));
    if (state.filterPublishers.length) params.set('publishers', state.filterPublishers.join(','));
    if (state.filterCondition) params.set('condition', state.filterCondition);
    if (state.filterLoaned === true) params.set('loaned', '1');
    if (state.filterPriceMin != null) params.set('price_min', String(state.filterPriceMin));
    if (state.filterPriceMax != null) params.set('price_max', String(state.filterPriceMax));
    if (state.filterLocation !== null) params.set('location', state.filterLocation);
    const qs = params.toString();
    const url = qs ? '?' + qs : location.pathname;
    if (location.search !== '?' + qs && !(location.search === '' && qs === '')) {
      history.replaceState({ cardboard: true }, '', url);
    }
  }

  function loadFromUrlParams() {
    const params = new URLSearchParams(location.search);
    if (params.has('status')) {
      const s = params.get('status');
      if (['all', 'owned', 'wishlist', 'sold'].includes(s)) state.statusFilter = s;
    }
    if (params.has('q')) state.search = params.get('q');
    if (params.has('sort')) {
      const raw = params.get('sort');
      if (raw.endsWith('_desc')) { state.sortBy = raw.replace(/_desc$/, ''); state.sortDir = 'desc'; }
      else { state.sortBy = raw; state.sortDir = 'asc'; }
    }
    if (params.has('view')) {
      const v = params.get('view');
      if (['grid', 'list', 'grouped'].includes(v)) state.viewMode = v;
    }
    if (params.has('never_played')) state.filterNeverPlayed = true;
    if (params.has('players')) state.filterPlayers = parseInt(params.get('players'), 10) || null;
    if (params.has('time')) state.filterTime = parseInt(params.get('time'), 10) || null;
    if (params.has('mechanics')) state.filterMechanics = params.get('mechanics').split(',').filter(Boolean);
    if (params.has('categories')) state.filterCategories = params.get('categories').split(',').filter(Boolean);
    if (params.has('labels')) state.filterLabels = params.get('labels').split(',').filter(Boolean);
    if (params.has('designers')) state.filterDesigners = params.get('designers').split(',').filter(Boolean);
    if (params.has('publishers')) state.filterPublishers = params.get('publishers').split(',').filter(Boolean);
    if (params.has('condition')) {
      const c = params.get('condition');
      if (['New', 'Good', 'Fair', 'Poor'].includes(c)) state.filterCondition = c;
    }
    if (params.has('loaned') && params.get('loaned') === '1') state.filterLoaned = true;
    if (params.has('price_min')) {
      const v = parseFloat(params.get('price_min'));
      if (!isNaN(v)) state.filterPriceMin = v;
    }
    if (params.has('price_max')) {
      const v = parseFloat(params.get('price_max'));
      if (!isNaN(v)) state.filterPriceMax = v;
    }
    if (params.has('location')) state.filterLocation = params.get('location') || null;
  }

  // ===== State helpers =====

  function updateGameInState(gameId, updates) {
    const idx = state.games.findIndex(g => g.id === gameId);
    if (idx !== -1) Object.assign(state.games[idx], updates);
    return idx;
  }

  // ===== Transient UI state (not persisted) =====
  let hoveredGame         = null;  // game card the mouse is currently over
  let activeModal         = null;  // { game, mode } when the game modal is open
  let _lastBulkClickedId  = null;  // game id last toggled in bulk mode, for shift+click range

  // ===== Reminders =====
  const REMINDER_DISMISS_KEY = 'cardboard_dismissed_reminders';
  const REMINDER_COOLDOWN_DAYS = 7;

  function getDismissedReminders() {
    try { return JSON.parse(localStorage.getItem(REMINDER_DISMISS_KEY) || '{}'); }
    catch (_) { return {}; }
  }
  function dismissReminder(gameId) {
    const dismissed = getDismissedReminders();
    dismissed[String(gameId)] = Date.now();
    localStorage.setItem(REMINDER_DISMISS_KEY, JSON.stringify(dismissed));
    const banner = document.getElementById('reminder-banner');
    if (banner) banner.style.display = 'none';
  }
  function isReminderDismissed(gameId) {
    const dismissed = getDismissedReminders();
    const ts = dismissed[String(gameId)];
    if (!ts) return false;
    return (Date.now() - ts) < (REMINDER_COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
  }

  // ===== Play This Next =====
  const RECOMMEND_SKIP_KEY = 'cardboard_recommend_skips';

  function getRecommendSkips() {
    try { return JSON.parse(sessionStorage.getItem(RECOMMEND_SKIP_KEY) || '[]'); }
    catch (_) { return []; }
  }
  function skipRecommend(gameId) {
    const skips = getRecommendSkips();
    if (!skips.includes(gameId)) skips.push(gameId);
    sessionStorage.setItem(RECOMMEND_SKIP_KEY, JSON.stringify(skips));
    loadRecommendCard();
  }

  // ===== Collection Health Action Plan =====
  const ACTION_PLAN_KEY = 'cardboard_action_plan';

  function getActionPlanCompleted() {
    try { return JSON.parse(localStorage.getItem(ACTION_PLAN_KEY) || '{}'); }
    catch (_) { return {}; }
  }
  function setActionPlanCompleted(taskId) {
    const completed = getActionPlanCompleted();
    const today = new Date().toLocaleDateString('en-CA');
    completed[taskId] = today;
    localStorage.setItem(ACTION_PLAN_KEY, JSON.stringify(completed));
  }
  function isActionPlanCompletedToday(taskId) {
    const completed = getActionPlanCompleted();
    return completed[taskId] === new Date().toLocaleDateString('en-CA');
  }

  function renderActionPlan() {
    const container = document.getElementById('action-plan-card');
    if (!container) return;
    if (currentCollectionDisplayPrefs.show_action_plan === false) {
      container.style.display = 'none';
      return;
    }
    const cs = state.collectionStats;
    if (!cs) { container.style.display = 'none'; return; }

    const tasks = [];
    const today = new Date().toLocaleDateString('en-CA');

    if (cs.play_pct !== undefined && cs.play_pct < 50 && cs.total_owned >= 5) {
      const unplayed = state.games.filter(g => g.status === 'owned' && !g.session_count).slice(0, 1);
      tasks.push({
        id: 'play_unplayed',
        title: `Play an unplayed game${unplayed.length ? ' — try <strong>' + escapeHtml(unplayed[0].name) + '</strong>' : ''}`,
        action: () => { document.getElementById('filter-never-played')?.click(); },
        actionLabel: 'Find One',
      });
    }

    const missingImages = state.games.filter(g => g.status === 'owned' && !g.image_url).length;
    if (missingImages > 0) {
      tasks.push({
        id: 'upload_images',
        title: `Upload photos for <strong>${missingImages}</strong> missing image${missingImages !== 1 ? 's' : ''}`,
        action: () => { showToast('Open a game and use the image upload in the edit modal', 'info'); },
        actionLabel: 'How To',
      });
    }

    const missingBgg = state.games.filter(g => !g.bgg_id).length;
    if (missingBgg > 0) {
      tasks.push({
        id: 'link_bgg',
        title: `Link <strong>${missingBgg}</strong> game${missingBgg !== 1 ? 's' : ''} to BoardGameGeek`,
        action: () => { showToast('Edit a game and search BGG to link it', 'info'); },
        actionLabel: 'How To',
      });
    }

    const unratedRecent = state.games.filter(g => g.status === 'owned' && g.user_rating == null && g.session_count > 0).slice(0, 1);
    if (unratedRecent.length) {
      tasks.push({
        id: 'rate_recent',
        title: `Rate <strong>${escapeHtml(unratedRecent[0].name)}</strong> — you played it but haven't rated it`,
        action: () => { openGameModal(unratedRecent[0], 'edit'); },
        actionLabel: 'Rate',
      });
    }

    if (!tasks.length) {
      container.innerHTML = `
        <div class="action-plan-header">
          <p class="action-plan-title">Collection Health</p>
          <span class="action-plan-score">${cs.play_pct ?? 0}% played</span>
        </div>
        <p class="action-plan-empty">All caught up! Great job maintaining your collection.</p>`;
      container.style.display = 'block';
      return;
    }

    container.innerHTML = `
      <div class="action-plan-header">
        <p class="action-plan-title">Today's Tasks</p>
        <span class="action-plan-score">${cs.play_pct ?? 0}% played</span>
      </div>
      <ul class="action-plan-list">
        ${tasks.map(t => `
          <li class="action-plan-item">
            <input type="checkbox" id="ap-${t.id}" ${isActionPlanCompletedToday(t.id) ? 'checked' : ''}>
            <label for="ap-${t.id}">${t.title}</label>
            <button class="action-plan-do" data-ap-action="${t.id}">${t.actionLabel}</button>
          </li>
        `).join('')}
      </ul>`;
    container.style.display = 'block';

    tasks.forEach(t => {
      const cb = container.querySelector(`#ap-${t.id}`);
      if (cb) {
        cb.addEventListener('change', () => {
          if (cb.checked) setActionPlanCompleted(t.id);
        });
      }
      const btn = container.querySelector(`[data-ap-action="${t.id}"]`);
      if (btn) btn.addEventListener('click', t.action);
    });
  }

  let _recommendReqId = 0;

  async function loadRecommendCard() {
    const myReqId = ++_recommendReqId;
    const container = document.getElementById('recommend-card');
    if (!container) return;
    if (currentCollectionDisplayPrefs.show_recommend_card === false) {
      container.style.display = 'none';
      return;
    }
    const skips = getRecommendSkips();
    const params = new URLSearchParams();
    if (skips.length) params.set('exclude', skips.join(','));
    if (state.filterPlayers !== null) params.set('players', String(state.filterPlayers));
    if (state.filterTime !== null) params.set('minutes', String(state.filterTime));
    try {
      const rec = await API.recommend(params.toString());
      if (myReqId !== _recommendReqId) return;
      if (!rec || !rec.game) { container.style.display = 'none'; return; }
      const g = rec.game;
      const thumb = isSafeUrl(g.image_url)
        ? `<img src="${escapeHtml(g.image_url)}" alt="" class="recommend-thumb" loading="lazy">`
        : `<div class="recommend-thumb-placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="22" height="22"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg></div>`;
      const players = formatPlayers(g.min_players, g.max_players);
      const playtime = formatPlaytime(g.min_playtime, g.max_playtime);
      container.innerHTML = `
        <div class="recommend-header">
          <p class="recommend-title-label">Play This Next</p>
        </div>
        <div class="recommend-main">
          ${thumb}
          <div class="recommend-body">
            <p class="recommend-title">${escapeHtml(g.name)}</p>
            <p class="recommend-meta">${players ? escapeHtml(players) : ''}${players && playtime ? ' \u2022 ' : ''}${playtime ? escapeHtml(playtime) : ''}</p>
            <p class="recommend-reason">${escapeHtml(rec.reason_detail)}</p>
          </div>
          <div class="recommend-actions">
            <button class="recommend-btn" data-recommend-play="${g.id}">Play</button>
            <button class="recommend-btn secondary" data-recommend-skip="${g.id}">Not Now</button>
          </div>
        </div>`;
      container.style.display = 'flex';
      container.querySelector('[data-recommend-play]')?.addEventListener('click', () => {
        const game = state.games.find(x => x.id === g.id);
        if (game) openGameModal(game, 'log');
      });
      container.querySelector('[data-recommend-skip]')?.addEventListener('click', () => skipRecommend(g.id));
    } catch (err) {
      if (myReqId !== _recommendReqId) return;
      if (err.status !== 404) console.warn('Recommend load failed:', err);
      container.style.display = 'none';
    }
  }

  function renderReminderBanner() {
    const banner = document.getElementById('reminder-banner');
    if (!banner) return;
    if (currentCollectionDisplayPrefs.show_reminder_banner === false) {
      banner.style.display = 'none';
      return;
    }
    const cs = state.collectionStats;
    if (!cs) { banner.style.display = 'none'; return; }

    // Priority 1: neglected favorite
    if (cs.neglected_favorite && !isReminderDismissed(cs.neglected_favorite.id)) {
      const n = cs.neglected_favorite;
      banner.innerHTML = `
        <span class="reminder-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        </span>
        <span class="reminder-text">
          <strong>${escapeHtml(n.name)}</strong> hasn't been played in ${n.months_ago} month${n.months_ago !== 1 ? 's' : ''}.
          It was your most-played game — dust it off?
        </span>
        <span class="reminder-actions">
          <button class="reminder-btn primary" data-reminder-log="${n.id}">Log Session</button>
          <button class="reminder-btn" data-reminder-dismiss="${n.id}">Dismiss</button>
        </span>`;
      banner.style.display = 'flex';
      banner.querySelector('[data-reminder-log]')?.addEventListener('click', () => {
        const game = state.games.find(g => g.id === n.id);
        if (game) openGameModal(game, 'log');
      });
      banner.querySelector('[data-reminder-dismiss]')?.addEventListener('click', () => dismissReminder(n.id));
      return;
    }

    // Priority 2: low play %
    if (cs.play_pct !== undefined && cs.play_pct < 50 && cs.total_owned >= 5 && !isReminderDismissed('_low_play_pct')) {
      banner.innerHTML = `
        <span class="reminder-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        </span>
        <span class="reminder-text">
          Only <strong>${cs.play_pct}%</strong> of your collection has been played.
          Pick an unplayed game for your next session?
        </span>
        <span class="reminder-actions">
          <button class="reminder-btn primary" data-reminder-never>Find One</button>
          <button class="reminder-btn" data-reminder-dismiss="_low_play_pct">Dismiss</button>
        </span>`;
      banner.style.display = 'flex';
      banner.querySelector('[data-reminder-never]')?.addEventListener('click', () => {
        document.getElementById('filter-never-played')?.click();
      });
      banner.querySelector('[data-reminder-dismiss]')?.addEventListener('click', () => dismissReminder('_low_play_pct'));
      return;
    }

    banner.style.display = 'none';
  }

  // ===== Milestones =====
  const MILESTONE_STORAGE_KEY    = 'cardboard_milestones';
  const COUNT_MILESTONES         = [5, 10, 25, 50, 100, 200];
  const HOURS_MILESTONES         = [5, 10, 25, 50, 100];
  const CONFETTI_COUNT_THRESHOLD = 25;  // play count milestones ≥ this value launch confetti
  const CONFETTI_HOURS_THRESHOLD = 10;  // hours milestones ≥ this value launch confetti

  function ordinal(n) {
    const v = n % 100;
    if (v >= 11 && v <= 13) return n + 'th';
    const s = ['th', 'st', 'nd', 'rd'];
    return n + (s[n % 10] || s[0]);
  }

  function loadMilestones() {
    return loadJsonFromStorage(MILESTONE_STORAGE_KEY, []);
  }
  function saveMilestones(list) {
    localStorage.setItem(MILESTONE_STORAGE_KEY, JSON.stringify(list));
  }

  // ===== State =====
  // `state` and collection-prefs persistence are imported from app/state.js;
  // SERVER_PAGE_SIZE and the filter helpers from app/filters.js.
  const VIRTUAL_PAGE_SIZE = 60;

  // Blob URL for add-game image preview — revoked on view switch
  let _addGamePreviewBlobUrl = null;

  // ===== Debounce Utility =====
  function debounce(fn, delay) {
    let timer = null;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); };
  }

  // Debounced collection reload — used when filter state changes
  const scheduleFilteredLoad = debounce(() => loadCollection(), 300);

  // Monotonic id for loadCollection calls. Rapid tab clicks can have overlapping
  // fetches in flight; only the latest caller is allowed to write state.games.
  let _loadCollectionReqId = 0;

  // IntersectionObserver for virtual-paging the collection grid. Stored so it
  // can be torn down at the start of every renderCollection() call — prevents
  // the stale closure from appending old game cards when an empty tab is shown.
  let _virtualPageObserver = null;
  // Persistent observer for heat-pulse animation on "hot" cards. Hoisted to
  // module scope so it can be disconnected alongside _virtualPageObserver —
  // otherwise removed cards stay alive in memory (observer holds strong refs).
  let _heatIo = null;

  // ===== Error Classification =====

  // ===== Init =====
  function syncCollectionUI() {
    const sortByEl   = document.getElementById('sort-by');
    const sortDirBtn = document.getElementById('sort-dir');
    const gridBtn    = document.getElementById('view-grid');
    const listBtn    = document.getElementById('view-list');
    const groupedBtn = document.getElementById('view-grouped');

    if (sortByEl) sortByEl.value = state.sortBy;

    if (sortDirBtn) {
      sortDirBtn.dataset.dir = state.sortDir;
      sortDirBtn.setAttribute('data-tooltip', state.sortDir === 'asc' ? 'Sort ascending' : 'Sort descending');
      const _svg = sortDirBtn.querySelector('svg');
      if (_svg) _svg.style.transform = state.sortDir === 'desc' ? 'scaleY(-1)' : '';
    }

    if (gridBtn) gridBtn.classList.toggle('active', state.viewMode === 'grid');
    if (listBtn) listBtn.classList.toggle('active', state.viewMode === 'list');
    if (groupedBtn) groupedBtn.classList.toggle('active', state.viewMode === 'grouped');

    document.querySelectorAll('#status-pills .pill').forEach(pill => {
      pill.classList.toggle('active', pill.dataset.status === state.statusFilter);
    });

    // Restore filter UI from persisted prefs
    const searchInput = document.getElementById('collection-search');
    const clearBtn    = document.getElementById('clear-search');
    if (searchInput && state.search) {
      searchInput.value = state.search;
      if (clearBtn) clearBtn.style.display = 'flex';
    }
    const neverBtn  = document.getElementById('filter-never-played');
    const playersEl = document.getElementById('filter-players');
    const timeEl    = document.getElementById('filter-time');
    if (neverBtn)  neverBtn.classList.toggle('active', state.filterNeverPlayed);
    if (playersEl) playersEl.value = state.filterPlayers ?? '';
    if (timeEl)    timeEl.value = state.filterTime ?? '';
  }

  document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    bindNav();
    bindCollectionContainer();
    bindCollectionControls();
    bindStatusPills();
    bindFilters();
    bindAddGame();
    bindBggSearch();
    initAddFormChipInputs();
    bindModalBackdrop();
    bindKeyboardShortcuts();
    bindShortcutsOverlay();
    bindThemeToggle();
    bindGameNightModal();
    bindPlayersModal();
    bindExportModal();
    bindNotifications();
    const shareBtn = document.getElementById('share-btn');
    if (shareBtn) shareBtn.addEventListener('click', openShareManageModal);
    // Check for unseen want-to-play requests and badge the share button
    updateShareBadge();
    const emptyBggBtn = document.getElementById('empty-bgg-import-btn');
    if (emptyBggBtn) emptyBggBtn.addEventListener('click', () => {
      _pendingBggHighlight = true;
      switchView('stats');
    });
    loadFromUrlParams();
    syncCollectionUI();
    syncFilterActiveBar();

    // Load and apply collection display prefs (visibility + section order)
    currentCollectionDisplayPrefs = loadCollectionDisplayPrefs();
    applyCollectionDisplayPrefs(currentCollectionDisplayPrefs);

    // Load players for autocomplete (non-blocking)
    API.getPlayers().then(p => { state.players = p.map(pl => pl.name); state.playerObjects = p; }).catch(err => {
      console.warn('Failed to load players for autocomplete:', err);
    });

    // Replay any sessions that were logged while offline
    if (navigator.onLine && typeof flushOfflineSessionQueue === 'function') {
      flushOfflineSessionQueue().then(n => {
        if (n > 0) {
          showToast(`Synced ${pluralize(n, 'offline session')}.`, 'success', 5000);
          loadCollection().catch(() => {});
        }
      }).catch(() => {});
    }
    window.addEventListener('offlineSessionsFlushed', e => {
      const n = e.detail.count;
      showToast(`Synced ${pluralize(n, 'offline session')}.`, 'success', 5000);
      loadCollection().catch(() => {});
    });
    const initialView = location.hash.replace('#', '') || 'collection';
    const validViews = ['collection', 'add', 'stats'];
    switchView(validViews.includes(initialView) ? initialView : 'collection');

    // Deep-link into a game modal after collection loads
    const _gameIdParam = new URLSearchParams(location.search).get('game');
    if (_gameIdParam && initialView === 'collection') {
      const _gameId = parseInt(_gameIdParam, 10);
      if (!isNaN(_gameId)) {
        const _openWhenReady = () => {
          const g = state.games.find(x => x.id === _gameId);
          if (g) { openGameModal(g); }
          else if (state.serverTotal > 0 && state.games.length >= state.serverTotal) {
            return;
          } else {
            tries = tries - 1;
            if (tries <= 0) return;
            setTimeout(_openWhenReady, 500);
          }
        };
        let tries = 40;
        setTimeout(_openWhenReady, 500);
      }
    }

    // Animated search placeholder
    const _searchInput = document.getElementById('collection-search');
    if (_searchInput) {
      const _placeholders = ['Search Wingspan…', 'Search Pandemic…', 'Search Gloomhaven…', 'Search Catan…', 'Search Ticket to Ride…', 'Search Spirit Island…'];
      let _phIdx = 0;
      const _phInterval = setInterval(() => {
        if (document.activeElement !== _searchInput && !_searchInput.value) {
          _phIdx = (_phIdx + 1) % _placeholders.length;
          _searchInput.placeholder = _placeholders[_phIdx];
        }
      }, 3200);
      window.addEventListener('unload', () => clearInterval(_phInterval), { once: true });
    }
  });

  // ===== Navigation =====
  function bindNav() {
    document.querySelectorAll('[data-view]').forEach(btn => {
      btn.addEventListener('click', () => {
        const targetView = btn.dataset.view;
        // Players and Share are modals, not views
        if (targetView === 'players') { openPlayersModal(); return; }
        if (targetView === 'share')   { openShareManageModal(); return; }
        const targetViewEl = document.getElementById(`view-${targetView}`);
        
        // If already on the target view, smooth scroll to top
        if (targetViewEl && targetViewEl.classList.contains('active')) {
          window.scrollTo({ top: 0, behavior: 'smooth' });
        } else {
          switchView(targetView);
        }
      });
    });

    // Add click handlers for logo to return to home
    const logoIcon = document.querySelector('.logo-icon');
    const logoText = document.querySelector('.logo-text');
    
    function handleLogoClick() {
      const collectionView = document.getElementById('view-collection');
      if (collectionView && collectionView.classList.contains('active')) {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        switchView('collection');
      }
    }

    if (logoIcon) logoIcon.addEventListener('click', handleLogoClick);
    if (logoText) logoText.addEventListener('click', handleLogoClick);

    // Prefetch stats on hover over Stats nav buttons
    const statsNavBtn = document.getElementById('nav-btn-stats');
    if (statsNavBtn) {
      statsNavBtn.addEventListener('mouseenter', _prefetchStats, { once: false });
    }
    // Also prefetch from bottom nav
    const bottomStatsBtn = document.querySelector('.bottom-nav-btn[data-view="stats"]');
    if (bottomStatsBtn) {
      bottomStatsBtn.addEventListener('mouseenter', _prefetchStats, { once: false });
    }

    // Mobile "More" menu (markup in index.html; items use the generic [data-view] wiring above)
    const moreBtn = document.getElementById('bottom-nav-more');
    const moreMenu = document.getElementById('mobile-more-menu');
    if (moreBtn && moreMenu) {
      const _closeMoreMenu = () => { moreMenu.classList.remove('open'); moreBtn.setAttribute('aria-expanded', 'false'); };
      const _moreEsc = (e) => { if (e.key === 'Escape') _closeMoreMenu(); };
      moreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = moreMenu.classList.toggle('open');
        moreBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        if (isOpen) document.addEventListener('keydown', _moreEsc, { once: true });
        else document.removeEventListener('keydown', _moreEsc);
      });
      document.addEventListener('click', (e) => { if (!e.target.closest('#mobile-more-menu') && !e.target.closest('#bottom-nav-more')) _closeMoreMenu(); });
      moreMenu.querySelectorAll('.mobile-more-item').forEach(item => item.addEventListener('click', _closeMoreMenu));
    }
  }

  function switchView(view) {
    if (view !== 'collection') {
      clearBulkSelection();
      _virtualPageObserver?.disconnect();
      _virtualPageObserver = null;
    }
    if (_addGamePreviewBlobUrl) { URL.revokeObjectURL(_addGamePreviewBlobUrl); _addGamePreviewBlobUrl = null; }
    document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('[data-view]').forEach(btn => btn.classList.remove('active'));
    const viewEl = document.getElementById(`view-${view}`);
    if (viewEl) viewEl.classList.add('active');
    document.querySelectorAll(`[data-view="${view}"]`).forEach(btn => btn.classList.add('active'));
    location.hash = view === 'collection' ? '' : view;
    if (view === 'add') {
      const plList = document.getElementById('purchase-location-list');
      const slList = document.getElementById('storage-location-list');
      if (plList) plList.innerHTML = _buildLocationDatalist(state.games, 'purchase_location');
      if (slList) slList.innerHTML = _buildLocationDatalist(state.games, 'location');
    }
    if (view === 'collection') loadCollection();
    if (view === 'stats') {
      const statsContent = document.getElementById('stats-content');
      if (statsContent && statsContent.children.length > 0) {
        refreshStatsBackground(); // return visit — show existing data instantly, refresh silently
      } else {
        loadStats();              // first visit — show spinner, fetch, render
      }
    }
  }

  // ===== Collection Controls =====
  function bindCollectionControls() {
    const searchInput = document.getElementById('collection-search');
    const clearBtn    = document.getElementById('clear-search');
    const sortBy      = document.getElementById('sort-by');
    const sortDirBtn  = document.getElementById('sort-dir');
    const gridBtn     = document.getElementById('view-grid');
    const listBtn     = document.getElementById('view-list');
    const groupedBtn  = document.getElementById('view-grouped');

    const debouncedSearchLoad = debounce(() => loadCollection(), 300);
    searchInput.addEventListener('input', () => {
      state.search = searchInput.value;
      clearBtn.style.display = state.search ? 'flex' : 'none';
      clearBulkSelection();
      saveCollectionPrefs();
      syncUrlParams();
      debouncedSearchLoad();
    });

    clearBtn.addEventListener('click', () => {
      searchInput.value = '';
      state.search = '';
      clearBtn.style.display = 'none';
      clearBulkSelection();
      saveCollectionPrefs();
      syncUrlParams();
      loadCollection();
    });

    // Collection search autocomplete
    const acContainer = document.getElementById('search-autocomplete');
    let _acDebounce;
    if (acContainer) {
      let _acSelectedIdx = -1;

      function _hideAc() {
        acContainer.style.display = 'none';
        _acSelectedIdx = -1;
      }

      function _showAc(items) {
        _acSelectedIdx = -1;
        acContainer.innerHTML = items.map((g, i) => `
          <button type="button" class="search-autocomplete-item" data-idx="${i}" data-game-id="${g.id}">
            <span class="ac-game-name">${escapeHtml(g.name)}</span>
            ${g.year_published ? `<span class="ac-game-year">${g.year_published}</span>` : ''}
          </button>`).join('');
        acContainer.style.display = '';
        acContainer.querySelectorAll('.search-autocomplete-item').forEach(btn => {
          btn.addEventListener('mousedown', e => {
            e.preventDefault();
            const gameId = parseInt(btn.dataset.gameId, 10);
            const game = state.games.find(g => g.id === gameId);
            if (game) {
              searchInput.value = game.name;
              state.search = game.name;
              clearBtn.style.display = 'flex';
              saveCollectionPrefs();
              _hideAc();
              debouncedSearchLoad();
            }
          });
        });
      }

      function _acUpdateSelected() {
        const items = acContainer.querySelectorAll('.search-autocomplete-item');
        items.forEach((el, i) => el.classList.toggle('active', i === _acSelectedIdx));
        if (_acSelectedIdx >= 0 && items[_acSelectedIdx]) {
          items[_acSelectedIdx].scrollIntoView({ block: 'nearest' });
        }
      }

      searchInput.addEventListener('input', () => {
        clearTimeout(_acDebounce);
        const q = searchInput.value.trim().toLowerCase();
        if (q.length < 2) { _hideAc(); return; }
        _acDebounce = setTimeout(() => {
          const matches = state.games.filter(g => g.name.toLowerCase().includes(q)).slice(0, 10);
          if (matches.length === 0) {
            acContainer.innerHTML = '<div class="search-autocomplete-empty">No matching games in collection</div>';
            acContainer.style.display = '';
          } else {
            _showAc(matches);
          }
        }, 150);
      });

      searchInput.addEventListener('keydown', e => {
        if (acContainer.style.display === 'none') {
          if (e.key === 'ArrowDown' && searchInput.value.trim().length >= 2) {
            // Trigger autocomplete if not shown but input qualifies
            const q = searchInput.value.trim().toLowerCase();
            const matches = state.games.filter(g => g.name.toLowerCase().includes(q)).slice(0, 10);
            if (matches.length > 0) { _showAc(matches); _acSelectedIdx = 0; _acUpdateSelected(); }
          }
          return;
        }
        const items = acContainer.querySelectorAll('.search-autocomplete-item');
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          _acSelectedIdx = Math.min(_acSelectedIdx + 1, items.length - 1);
          _acUpdateSelected();
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          _acSelectedIdx = Math.max(_acSelectedIdx - 1, 0);
          _acUpdateSelected();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          if (_acSelectedIdx >= 0 && items[_acSelectedIdx]) {
            items[_acSelectedIdx].click();
          }
        } else if (e.key === 'Escape') {
          _hideAc();
        }
      });

      searchInput.addEventListener('blur', () => {
        setTimeout(_hideAc, 150);
      });

      searchInput.addEventListener('focus', () => {
        const q = searchInput.value.trim().toLowerCase();
        if (q.length >= 2) {
          clearTimeout(_acDebounce);
          const matches = state.games.filter(g => g.name.toLowerCase().includes(q)).slice(0, 10);
          if (matches.length > 0) _showAc(matches);
        }
      });
    }

    sortBy.addEventListener('change', () => {
      state.sortBy = sortBy.value;
      // "Hot" is meaningless ascending — auto-flip to desc
      if (sortBy.value === 'heat_level' && state.sortDir !== 'desc') {
        state.sortDir = 'desc';
        if (sortDirBtn) {
          sortDirBtn.dataset.dir = 'desc';
          sortDirBtn.setAttribute('data-tooltip', 'Sort descending');
          const svg = sortDirBtn.querySelector('svg');
          if (svg) svg.style.transform = 'scaleY(-1)';
        }
      }
      saveCollectionPrefs();
      syncUrlParams();
      loadCollection();
    });

    sortDirBtn.addEventListener('click', () => {
      state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      sortDirBtn.dataset.dir = state.sortDir;
      sortDirBtn.setAttribute('data-tooltip', state.sortDir === 'asc' ? 'Sort ascending' : 'Sort descending');
      const _svg = sortDirBtn.querySelector('svg');
      if (_svg) _svg.style.transform = state.sortDir === 'desc' ? 'scaleY(-1)' : '';
      saveCollectionPrefs();
      syncUrlParams();
      loadCollection();
    });

    gridBtn.addEventListener('click', () => {
      state.viewMode = 'grid';
      gridBtn.classList.add('active');
      listBtn.classList.remove('active');
      if (groupedBtn) groupedBtn.classList.remove('active');
      saveCollectionPrefs();
      syncUrlParams();
      renderCollection();
    });

    listBtn.addEventListener('click', () => {
      state.viewMode = 'list';
      listBtn.classList.add('active');
      gridBtn.classList.remove('active');
      if (groupedBtn) groupedBtn.classList.remove('active');
      saveCollectionPrefs();
      syncUrlParams();
      renderCollection();
    });

    if (groupedBtn) {
      groupedBtn.addEventListener('click', () => {
        state.viewMode = 'grouped';
        groupedBtn.classList.add('active');
        gridBtn.classList.remove('active');
        listBtn.classList.remove('active');
        saveCollectionPrefs();
        syncUrlParams();
        renderCollection();
      });
    }

    // Density toggle (grid only)
    const densityToggle = document.getElementById('density-toggle');
    const densityBtns = {
      large: document.getElementById('density-large'),
      compact: document.getElementById('density-compact'),
      covers: document.getElementById('density-covers'),
    };
    if (densityToggle && densityBtns.large) {
      function _setDensity(density) {
        state.gridDensity = density;
        Object.entries(densityBtns).forEach(([key, btn]) => {
          if (btn) btn.classList.toggle('active', key === density);
        });
        const container = document.getElementById('games-container');
        if (container) {
          container.classList.remove('density-compact', 'density-covers');
          if (density !== 'large') container.classList.add(`density-${density}`);
        }
        saveCollectionPrefs();
      }
      Object.entries(densityBtns).forEach(([key, btn]) => {
        if (btn) btn.addEventListener('click', () => _setDensity(key));
      });
      // Show/hide density toggle based on view mode
      function _syncDensityToggle() {
        densityToggle.style.display = state.viewMode === 'grid' ? 'flex' : 'none';
      }
      gridBtn.addEventListener('click', _syncDensityToggle);
      listBtn.addEventListener('click', _syncDensityToggle);
      if (groupedBtn) groupedBtn.addEventListener('click', _syncDensityToggle);
      _syncDensityToggle();
      // Apply saved density
      _setDensity(state.gridDensity || 'large');
    }

    const expansionsBtn = document.getElementById('show-expansions-btn');
    if (expansionsBtn) {
      expansionsBtn.addEventListener('click', () => {
        state.showExpansions = !state.showExpansions;
        expansionsBtn.classList.toggle('active', state.showExpansions);
        expansionsBtn.setAttribute('aria-pressed', state.showExpansions);
        expansionsBtn.setAttribute('data-tooltip', state.showExpansions ? 'Hide expansions' : 'Show expansions');
        syncUrlParams();
        loadCollection();
      });
    }

    const bulkToggle = document.getElementById('bulk-select-toggle');
    if (bulkToggle) {
      bulkToggle.addEventListener('click', () => {
        state.bulkMode = !state.bulkMode;
        if (!state.bulkMode) {
          state.selectedGameIds.clear();
          _lastBulkClickedId = null;
          renderBulkToolbar();
        }
        bulkToggle.classList.toggle('active', state.bulkMode);
        bulkToggle.setAttribute('aria-pressed', state.bulkMode);
        bulkToggle.setAttribute('data-tooltip', state.bulkMode ? 'Exit selection mode' : 'Select games for bulk actions');
        renderCollection();
      });
    }

    const settingsBtn = document.getElementById('collection-settings-btn');
    if (settingsBtn) {
      settingsBtn.addEventListener('click', () => {
        openCollectionSettingsModal(currentCollectionDisplayPrefs, (newPrefs) => {
          currentCollectionDisplayPrefs = newPrefs;
          applyCollectionDisplayPrefs(newPrefs);
          saveCollectionDisplayPrefs(newPrefs);
        });
      });
    }
  }

  // ===== Tag Autocomplete =====
  const TAG_FIELDS = ['labels', 'categories', 'mechanics', 'designers', 'publishers'];

  function buildDataLists() {
    for (const field of TAG_FIELDS) {
      const dl = document.getElementById(`dl-${field}`);
      if (!dl) continue;
      const seen = new Set();
      state.games.forEach(g => {
        try { JSON.parse(g[field] || '[]').forEach(v => { if (v) seen.add(v); }); } catch (err) { console.warn(`Failed to parse ${field} for game ${g.id}:`, err); }
      });
      dl.innerHTML = [...seen].sort().map(v => `<option value="${escapeHtml(v)}">`).join('');
    }
  }

  const TAG_PLACEHOLDERS = {
    labels: 'Favourite, Solo, Kid-friendly',
    categories: 'Strategy, Card Game',
    mechanics: 'Hand Management, Set Collection',
    designers: 'Alan Moon',
    publishers: 'Days of Wonder',
  };

  // Build empty chip inputs on the add form (prefillFormFromBgg re-initializes them with values)
  function initAddFormChipInputs() {
    TAG_FIELDS.forEach(field => _renderChipInput(`m-${field}`, [], TAG_PLACEHOLDERS[field], `dl-${field}`));
  }

  // ===== Sort ===== (sortGames is imported from app/sort.js)

  // ===== Weekly Summary Toast =====
  function _maybeShowWeeklySummary() {
    const today = new Date().toLocaleDateString('en-CA');
    const lastShown = localStorage.getItem('cardboard_weekly_toast_date');
    if (lastShown === today) return;

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toLocaleDateString('en-CA');
    const recentGames = state.games.filter(g => g.last_played && g.last_played >= sevenDaysAgo);
    if (!recentGames.length) return;

    const msg = recentGames.length === 1
      ? `You played ${escapeHtml(recentGames[0].name)} this week`
      : `You played ${recentGames.length} games this week`;
    showToast(msg, 'info', 4000);
    localStorage.setItem('cardboard_weekly_toast_date', today);
  }


  // ===== Load Collection =====
  async function loadCollection({ showSkeleton = state.games.length === 0 } = {}) {
    const myReqId = ++_loadCollectionReqId;
    const container = document.getElementById('games-container');
    if (showSkeleton) {
      container.innerHTML = buildSkeletonGrid(12);
    }
    document.getElementById('empty-state').style.display = 'none';

    try {
      const filterParams = buildFilterParams(0);
      const needStats = state.collectionStats === null;
      const [{ data: raw, total }, collectionStats] = await Promise.all([
        API.getGames(filterParams),
        needStats ? API.getCollectionStats() : Promise.resolve(null),
      ]);
      if (myReqId !== _loadCollectionReqId) return;  // a newer load has superseded us
      if (raw !== null) {
        state.games = raw;
        state.serverOffset = raw.length;
        state.serverTotal = total;
      }
      if (collectionStats !== null) state.collectionStats = collectionStats;
      buildDataLists();
      renderCollection();
      if (currentCollectionDisplayPrefs.show_reminder_banner !== false) renderReminderBanner();
      if (currentCollectionDisplayPrefs.show_recommend_card !== false) loadRecommendCard();
      if (currentCollectionDisplayPrefs.show_action_plan !== false) renderActionPlan();
      maybeStartTour();
      _maybeShowWeeklySummary();
    } catch (err) {
      if (myReqId !== _loadCollectionReqId) return;  // superseded; don't clobber UI
      container.innerHTML = `<div class="loading-spinner">
        <p style="color:var(--danger);margin-bottom:0.75rem">Failed to load collection: ${escapeHtml(classifyError(err))}</p>
        <button class="btn btn-secondary" id="collection-retry-btn">Retry</button>
      </div>`;
      const _retryBtn = document.getElementById('collection-retry-btn');
      if (_retryBtn) _retryBtn.addEventListener('click', loadCollection, { once: true });
    }
  }

  // ===== Bulk Operations =====
  function renderBulkToolbar() {
    const toolbar = document.getElementById('bulk-toolbar');
    if (!toolbar) return;
    if (!state.bulkMode || state.selectedGameIds.size === 0) {
      toolbar.innerHTML = '';
      toolbar.style.display = 'none';
      return;
    }
    const n = state.selectedGameIds.size;
    toolbar.style.display = '';
    toolbar.innerHTML = `
      <span class="bulk-count">${pluralize(n, 'game')} selected</span>
      <select class="bulk-status-select" id="bulk-status-select" aria-label="Change status of selected games">
        <option value="">Change status…</option>
        <option value="owned">Owned</option>
        <option value="wishlist">Wishlist</option>
        <option value="sold">Sold</option>
      </select>
      <div class="bulk-label-group">
        <input type="text" class="form-input bulk-label-input" id="bulk-label-input" placeholder="Add / remove label…" autocomplete="off" list="bulk-label-list">
        <datalist id="bulk-label-list">${[...new Set(state.games.flatMap(g => { try { return JSON.parse(g.labels || '[]'); } catch (err) { console.warn(`Failed to parse labels for game ${g.id}:`, err); return []; } }))].map(l => `<option value="${escapeHtml(l)}">`).join('')}</datalist>
        <button class="btn btn-secondary btn-sm" id="bulk-label-btn">Add</button>
        <button class="btn btn-secondary btn-sm" id="bulk-unlabel-btn">Remove</button>
      </div>
      <button class="btn btn-secondary btn-sm" id="bulk-log-session-btn">Log Session</button>
      <button class="btn btn-secondary btn-sm" id="bulk-refresh-bgg-btn">Refresh BGG</button>
      <button class="btn btn-secondary btn-sm" id="bulk-select-all-btn">Select All</button>
      <button class="btn btn-danger btn-sm" id="bulk-delete-btn">Delete</button>
      <button class="btn btn-secondary btn-sm" id="bulk-deselect-btn">Deselect All</button>
    `;
    toolbar.querySelector('#bulk-status-select').addEventListener('change', async (e) => {
      const newStatus = e.target.value;
      if (!newStatus) return;
      await handleBulkStatusChange(newStatus);
    });
    toolbar.querySelector('#bulk-label-btn').addEventListener('click', async () => {
      const label = toolbar.querySelector('#bulk-label-input').value.trim();
      if (!label) return;
      await handleBulkAddLabel(label);
    });
    toolbar.querySelector('#bulk-unlabel-btn').addEventListener('click', async () => {
      const label = toolbar.querySelector('#bulk-label-input').value.trim();
      if (!label) return;
      await handleBulkRemoveLabel(label);
    });
    toolbar.querySelector('#bulk-log-session-btn').addEventListener('click', openBulkSessionModal);
    toolbar.querySelector('#bulk-refresh-bgg-btn').addEventListener('click', handleBulkRefreshBgg);
    const selectAllBtn = toolbar.querySelector('#bulk-select-all-btn');
    selectAllBtn.textContent = state.selectedGameIds.size === state.games.length ? 'Deselect All' : 'Select All';
    selectAllBtn.addEventListener('click', () => {
      if (state.selectedGameIds.size >= state.games.length) {
        state.selectedGameIds.clear();
      } else {
        state.games.forEach(g => state.selectedGameIds.add(g.id));
      }
      renderCollection();
      renderBulkToolbar();
    });
    toolbar.querySelector('#bulk-delete-btn').addEventListener('click', handleBulkDelete);
    toolbar.querySelector('#bulk-deselect-btn').addEventListener('click', () => {
      state.selectedGameIds.clear();
      renderCollection();
      renderBulkToolbar();
    });
  }

  async function _executeBulkUpdate(ids, apiFn, makeSuccessMsg) {
    const results = await Promise.allSettled(ids.map(apiFn));
    const succeeded = [], failed = [];
    results.forEach((r, i) => (r.status === 'fulfilled' ? succeeded : failed).push({ ...r, id: ids[i] }));
    succeeded.forEach(r => {
      updateGameInState(r.value.id, r.value);
      state.selectedGameIds.delete(r.value.id);
    });
    const msg = failed.length
      ? `${succeeded.length} updated · ${failed.length} failed — ${classifyError(failed[0].reason) || 'unknown error'}`
      : makeSuccessMsg(succeeded.length);
    showToast(msg, failed.length ? 'error' : 'success');
    renderCollection();
    renderBulkToolbar();
  }

  async function handleBulkStatusChange(newStatus) {
    const ids = [...state.selectedGameIds];
    await _executeBulkUpdate(
      ids,
      id => API.updateGame(id, { status: newStatus }),
      n => `${pluralize(n, 'game')} set to ${newStatus}`,
    );
  }

  async function handleBulkAddLabel(label) {
    const ids = [...state.selectedGameIds];
    const gameById = Object.fromEntries(state.games.map(g => [g.id, g]));
    await _executeBulkUpdate(
      ids,
      id => {
        const game = gameById[id];
        let labels = [];
        try { labels = JSON.parse(game?.labels || '[]'); } catch (err) { console.warn(`Failed to parse labels for game ${game?.id}:`, err); labels = []; }
        if (!labels.includes(label)) labels = [...labels, label];
        return API.updateGame(id, { labels: JSON.stringify(labels) });
      },
      n => `Label "${label}" added to ${pluralize(n, 'game')}`,
    );
  }

  async function handleBulkRemoveLabel(label) {
    const ids = [...state.selectedGameIds];
    const gameById = Object.fromEntries(state.games.map(g => [g.id, g]));
    await _executeBulkUpdate(
      ids,
      id => {
        const game = gameById[id];
        let labels = [];
        try { labels = JSON.parse(game?.labels || '[]'); } catch (err) { console.warn(`Failed to parse labels for game ${game?.id}:`, err); labels = []; }
        labels = labels.filter(l => l !== label);
        return API.updateGame(id, { labels: JSON.stringify(labels) });
      },
      n => `Label "${label}" removed from ${pluralize(n, 'game')}`,
    );
  }

  async function openBulkSessionModal() {
    const ids = [...state.selectedGameIds];
    if (!ids.length) return;
    const inner = document.createElement('div');
    inner.innerHTML = `
      <div class="modal-content-panel">
        <div class="modal-panel-header">
          <h2 id="modal-title">Log Session for ${ids.length} Games</h2>
          <button class="modal-close" id="bulk-session-close" aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="18" height="18"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="modal-body bs-body">
          <div class="form-grid">
            <div class="form-group">
              <label class="form-label" for="bs-date">Date</label>
              <input type="date" id="bs-date" class="form-input" value="${new Date().toLocaleDateString('en-CA')}">
              <span class="field-error" id="bs-date-error"></span>
            </div>
            <div class="form-group">
              <label class="form-label" for="bs-duration">Duration (min)</label>
              <input type="number" id="bs-duration" class="form-input" min="1" placeholder="Optional">
            </div>
          </div>
          <div class="form-group">
            <label class="form-label" for="bs-notes">Notes</label>
            <textarea id="bs-notes" class="form-textarea" rows="2" placeholder="Optional"></textarea>
          </div>
          <div class="form-group">
            <label class="inline-toggle bs-coop-toggle">
              <input type="checkbox" id="bs-coop"> Cooperative game
            </label>
          </div>
          <div id="bs-coop-fields" class="ql-hidden bs-coop-fields">
            <div class="form-group">
              <label class="form-label">Outcome</label>
              <div class="ql-coop-outcome">
                ${[['win','🏆 Win'],['loss','❌ Loss'],['draw','🤝 Draw'],['incomplete','⏹ Incomplete']].map(([v,l]) => `<label class="inline-toggle"><input type="radio" name="bs-outcome" value="${v}"> ${l}</label>`).join('')}
              </div>
            </div>
            <div class="form-group">
              <label class="form-label" for="bs-scenario">Scenario / Difficulty</label>
              <input type="text" id="bs-scenario" class="form-input" placeholder="optional" autocomplete="off">
            </div>
          </div>
          <button class="btn btn-primary bs-submit" id="bs-submit">Log Session</button>
        </div>
      </div>`;
    openModal(inner);
    inner.querySelector('#bulk-session-close').addEventListener('click', closeModal);
    const bsCoop = inner.querySelector('#bs-coop');
    const bsCoopFields = inner.querySelector('#bs-coop-fields');
    bsCoop.addEventListener('change', () => {
      const isCoop = bsCoop.checked;
      bsCoopFields.classList.toggle('ql-hidden', !isCoop);
      if (!isCoop) {
        inner.querySelectorAll('input[name="bs-outcome"]').forEach(r => { r.checked = false; });
        inner.querySelector('#bs-scenario').value = '';
      }
    });
    const submitBtn = inner.querySelector('#bs-submit');
    submitBtn.addEventListener('click', async () => {
      const dateInput = document.getElementById('bs-date');
      const dateErr = document.getElementById('bs-date-error');
      if (!dateInput.value) {
        if (dateErr) dateErr.classList.add('active');
        dateInput.classList.add('invalid');
        dateInput.focus();
        return;
      }
      if (dateErr) dateErr.classList.remove('active');
      dateInput.classList.remove('invalid');
      const isCoop = bsCoop.checked;
      const outcomeEl = inner.querySelector('input[name="bs-outcome"]:checked');
      const body = {
        game_ids: ids,
        played_at: dateInput.value,
        duration_minutes: parseInt(document.getElementById('bs-duration').value, 10) || undefined,
        notes: document.getElementById('bs-notes').value.trim() || undefined,
        cooperative: isCoop || undefined,
        outcome: isCoop ? (outcomeEl ? outcomeEl.value : undefined) : undefined,
        scenario: isCoop ? (document.getElementById('bs-scenario').value.trim() || undefined) : undefined,
      };
      await withLoading(submitBtn, async () => {
        try {
          await API.bulkSession(body);
          showToast(`Session logged for ${pluralize(ids.length, 'game')}`, 'success');
          state.selectedGameIds.clear();
          closeModal();
          loadCollection();
          renderBulkToolbar();
        } catch (err) {
          showToast(classifyError(err), 'error');
        }
      }, 'Logging…');
    });
  }

  async function handleBulkRefreshBgg() {
    const ids = [...state.selectedGameIds];
    let done = 0, failed = 0;
    for (const id of ids) {
      try {
        await API.refreshFromBGG(id);
        done++;
      } catch (err) {
        failed++;
        console.warn(`BGG refresh failed for game ${id}:`, err);
      }
    }
    if (done > 0) loadCollection();
    const msg = failed > 0 ? `${done} refreshed · ${failed} failed` : `${pluralize(done, 'game')} refreshed from BGG`;
    showToast(msg, failed > 0 ? 'error' : 'success');
    state.selectedGameIds.clear();
    renderBulkToolbar();
  }

  async function handleBulkDelete() {
    const n = state.selectedGameIds.size;
    const confirmed = await showConfirm(`Delete ${pluralize(n, 'Selected Game')}`, `Delete ${pluralize(n, 'selected game')}?`, { confirmLabel: 'Delete' });
    if (!confirmed) return;
    const ids = [...state.selectedGameIds];
    const deletedGameSnapshots = ids.map(id => state.games.find(g => g.id === id)).filter(Boolean);
    const results = await Promise.allSettled(ids.map(id => API.deleteGame(id)));
    const failedIds = new Set();
    let firstFailReason = '';
    ids.forEach((id, i) => {
      if (results[i].status === 'rejected') {
        failedIds.add(id);
        if (!firstFailReason) firstFailReason = results[i].reason?.message || 'unknown error';
      }
    });
    const successCount = ids.length - failedIds.size;
    const successfullyDeleted = new Set(ids.filter(id => !failedIds.has(id)));
    state.games = state.games.filter(g => !successfullyDeleted.has(g.id));
    state.serverTotal -= successCount;
    state.selectedGameIds.clear();
    const failCount = failedIds.size;
    const msg = failCount > 0
      ? `${successCount} deleted · ${failCount} failed — ${firstFailReason}`
      : `${pluralize(successCount, 'game')} deleted`;
    showToast(msg, failCount > 0 ? 'error' : 'success');

    if (successCount > 0) {
      const restoredSnapshots = deletedGameSnapshots.filter(g => !failedIds.has(g.id));
      showUndoToast(`${pluralize(successCount, 'game')} removed.`, async () => {
        let restored = 0;
        for (const snap of restoredSnapshots) {
          try {
            const { id: _id, date_modified: _dm, image_cached: _ic, parent_game_name: _pgn, expansion_count: _ec, session_count: _sc, heat_level: _hl, thumbnail_url: _tu, ...payload } = snap;
            const created = await API.createGame(payload);
            state.games.push(created);
            restored++;
          } catch (_) { /* skip individual failures */ }
        }
        state.games = sortGames(state.games, state.sortBy, state.sortDir);
        renderCollection();
        refreshCollectionStats();
        if (restored > 0) showToast(`${pluralize(restored, 'game')} restored.`, 'success');
      }, restoredSnapshots.length > 3 ? 7000 : 5000);
    }

    renderCollection();
    renderBulkToolbar();
    refreshStatsBackground();
    refreshCollectionStats();
  }

  function bindCollectionContainer() {
    const container = document.getElementById('games-container');

    container.addEventListener('click', async (e) => {
      const card = e.target.closest('[data-game-id]');
      if (!card) return;
      const game = state.games.find(g => g.id === +card.dataset.gameId);
      if (!game) return;

      if (state.bulkMode) {
        if (e.target.closest('.quick-owned-btn, .quick-log-btn')) return;
        if (e.shiftKey && _lastBulkClickedId != null) {
          const lastIdx = state.games.findIndex(g => g.id === _lastBulkClickedId);
          const currIdx = state.games.findIndex(g => g.id === game.id);
          if (lastIdx !== -1 && currIdx !== -1) {
            const from = Math.min(lastIdx, currIdx);
            const to = Math.max(lastIdx, currIdx);
            const selected = state.selectedGameIds.has(game.id);
            for (let i = from; i <= to; i++) {
              const g = state.games[i];
              if (selected) {
                state.selectedGameIds.delete(g.id);
              } else {
                state.selectedGameIds.add(g.id);
              }
            }
            // Update last-clicked
            _lastBulkClickedId = game.id;
            renderCollection();
            renderBulkToolbar();
            return;
          }
        }
        if (state.selectedGameIds.has(game.id)) {
          state.selectedGameIds.delete(game.id);
          card.classList.remove('selected');
        } else {
          state.selectedGameIds.add(game.id);
          card.classList.add('selected');
        }
        _lastBulkClickedId = game.id;
        renderBulkToolbar();
        return;
      }

      const ownedBtn = e.target.closest('.quick-owned-btn');
      if (ownedBtn) {
        e.stopPropagation();
        withLoading(ownedBtn, () => handleQuickStatusChange(game.id, 'owned'))
          .catch(err => showToast(classifyError(err), 'error'));
        return;
      }

      const logBtn = e.target.closest('.quick-log-btn');
      if (logBtn) { e.stopPropagation(); openCompactQuickLog(game, logBtn); return; }

      const repeatBtn = e.target.closest('.quick-repeat-btn');
      if (repeatBtn) { e.stopPropagation(); withLoading(repeatBtn, () => quickRepeatLastSession(game)); return; }

      if (e.target.closest('.card-hover-view')) { openGameModal(game); return; }

      const cardMedia = e.target.closest('.game-card-image.gallery-clickable');
      if (cardMedia && !e.target.closest('.card-hover-actions')) {
        e.stopPropagation();
        let imgs;
        try {
          imgs = await API.getImages(game.id);
        } catch {
          showToast('Could not load images', 'error');
          return;
        }
        if (imgs.length) openGalleryLightbox(imgs, 0);
        return;
      }

      openGameModal(game);
    });

    container.addEventListener('mouseover', (e) => {
      const card = e.target.closest('[data-game-id]');
      if (card) hoveredGame = state.games.find(g => g.id === +card.dataset.gameId) || null;
    });

    container.addEventListener('mouseout', (e) => {
      const card = e.target.closest('[data-game-id]');
      if (card && !card.contains(e.relatedTarget)) hoveredGame = null;
    });
  }

  function _locationLabel(key) {
    return key === NO_LOCATION_SENTINEL ? 'No location' : key;
  }

  function syncFilterActiveBar() {
    const bar = document.getElementById('filter-active-bar');
    const label = document.getElementById('filter-active-label');
    const chipsEl = document.getElementById('filter-chips');
    const toggleBtn = document.getElementById('filter-toggle-btn');
    const badge = document.getElementById('filter-badge');
    const summaryEl = document.getElementById('filter-summary');
    if (!bar || !label) return;
    const panel = document.getElementById('filter-panel');
    const panelOpen = panel && panel.classList.contains('open');
    const activeCount = _activeFilterCount();
    const hasFilters = hasActiveFilters();

    // Update filter toggle button state
    if (toggleBtn) {
      toggleBtn.classList.toggle('active', hasFilters || panelOpen);
      toggleBtn.setAttribute('aria-pressed', panelOpen ? 'true' : 'false');
      toggleBtn.setAttribute('data-tooltip', panelOpen ? 'Hide filters' : 'Show filters');
    }
    if (badge) {
      if (activeCount > 0 && !panelOpen) {
        badge.textContent = activeCount > 99 ? '99+' : activeCount;
        badge.style.display = 'flex';
      } else {
        badge.style.display = 'none';
      }
    }

    // Update filter summary bar
    if (summaryEl && state.collectionStats) {
      const cs = state.collectionStats;
      const parts = [];
      if (cs.total_owned) parts.push(`<span class="filter-summary-stat"><span class="ss-count">${cs.total_owned}</span> owned</span>`);
      if (cs.total_wishlist) parts.push(`<span class="filter-summary-stat"><span class="ss-count">${cs.total_wishlist}</span> wishlist</span>`);
      if (cs.total_sold) parts.push(`<span class="filter-summary-stat"><span class="ss-count">${cs.total_sold}</span> sold</span>`);
      summaryEl.innerHTML = parts.join('<span class="filter-summary-sep"> · </span>');
    }

    if (!hasFilters || panelOpen) {
      bar.style.display = 'none';
      if (chipsEl) chipsEl.innerHTML = '';
      return;
    }

    // Build removable filter chips
    if (chipsEl) {
      const chips = [];
      if (state.filterNeverPlayed) {
        chips.push({ type: 'neverPlayed', label: 'Never Played' });
      }
      if (state.filterPlayers !== null) {
        chips.push({ type: 'players', label: `${state.filterPlayers} players`, value: state.filterPlayers });
      }
      if (state.filterTime !== null) {
        chips.push({ type: 'time', label: `≤ ${state.filterTime} min`, value: state.filterTime });
      }
      state.filterMechanics.forEach(m => {
        chips.push({ type: 'mechanic', label: m, value: m });
      });
      state.filterCategories.forEach(c => {
        chips.push({ type: 'category', label: c, value: c });
      });
      state.filterLabels.forEach(l => {
        chips.push({ type: 'label', label: l, value: l });
      });
      state.filterDesigners.forEach(d => {
        chips.push({ type: 'designer', label: d, value: d });
      });
      state.filterPublishers.forEach(p => {
        chips.push({ type: 'publisher', label: p, value: p });
      });
      if (state.filterCondition) {
        chips.push({ type: 'condition', label: state.filterCondition, value: state.filterCondition });
      }
      if (state.filterLoaned === true) {
        chips.push({ type: 'loaned', label: 'Loaned Out' });
      }
      if (state.filterPriceMin != null) {
        chips.push({ type: 'priceMin', label: `≥ $${state.filterPriceMin}`, value: state.filterPriceMin });
      }
      if (state.filterPriceMax != null) {
        chips.push({ type: 'priceMax', label: `≤ $${state.filterPriceMax}`, value: state.filterPriceMax });
      }
      if (state.filterLocation !== null) {
        chips.push({ type: 'location', label: _locationLabel(state.filterLocation), value: state.filterLocation });
      }
      chipsEl.innerHTML = chips.map(chip => `
        <span class="filter-chip" data-type="${chip.type}" data-value="${chip.value || ''}">
          ${escapeHtml(chip.label)}
          <button class="chip-remove" aria-label="Remove ${escapeHtml(chip.label)} filter" title="Remove filter">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="10" height="10"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </span>
      `).join('');
      if (!chipsEl.dataset.wired) {
        chipsEl.dataset.wired = '1';
        chipsEl.addEventListener('click', e => {
          const btn = e.target.closest('.chip-remove');
          if (!btn) return;
          e.stopPropagation();
          const chip = btn.closest('.filter-chip');
          const type = chip.dataset.type;
          const value = chip.dataset.value;
          switch (type) {
            case 'neverPlayed': state.filterNeverPlayed = false; break;
            case 'players': state.filterPlayers = null; break;
            case 'time': state.filterTime = null; break;
            case 'mechanic': state.filterMechanics = state.filterMechanics.filter(m => m !== value); break;
            case 'category': state.filterCategories = state.filterCategories.filter(c => c !== value); break;
            case 'label': state.filterLabels = state.filterLabels.filter(l => l !== value); break;
            case 'designer': state.filterDesigners = state.filterDesigners.filter(d => d !== value); break;
            case 'publisher': state.filterPublishers = state.filterPublishers.filter(p => p !== value); break;
            case 'condition': state.filterCondition = null; break;
            case 'loaned': state.filterLoaned = null; break;
            case 'priceMin': state.filterPriceMin = null; break;
            case 'priceMax': state.filterPriceMax = null; break;
            case 'location': state.filterLocation = null; break;
          }
          saveCollectionPrefs();
          syncUrlParams();
          loadCollection();
          syncCollectionUI();
        });
      }
    }

    const parts = [];
    if (state.filterNeverPlayed) parts.push('Never Played');
    if (state.filterPlayers !== null) parts.push(`${state.filterPlayers} players`);
    if (state.filterTime !== null) parts.push(`≤ ${state.filterTime} min`);
    if (state.filterMechanics.length > 0) parts.push(pluralize(state.filterMechanics.length, 'mechanic'));
    if (state.filterCategories.length > 0) parts.push(pluralize(state.filterCategories.length, 'category', 'categories'));
    if (state.filterLabels.length > 0) parts.push(pluralize(state.filterLabels.length, 'label'));
    if (state.filterDesigners.length > 0) parts.push(pluralize(state.filterDesigners.length, 'designer'));
    if (state.filterPublishers.length > 0) parts.push(pluralize(state.filterPublishers.length, 'publisher'));
    if (state.filterCondition) parts.push(state.filterCondition);
    if (state.filterLoaned === true) parts.push('Loaned Out');
    if (state.filterPriceMin != null) parts.push(`≥ $${state.filterPriceMin}`);
    if (state.filterPriceMax != null) parts.push(`≤ $${state.filterPriceMax}`);
    if (state.filterLocation !== null) parts.push(_locationLabel(state.filterLocation));
    label.textContent = `Filters: ${parts.join(' · ')}`;
    bar.style.display = 'flex';
  }

  function clearBulkSelection() {
    if (state.bulkMode && state.selectedGameIds.size > 0) {
      state.selectedGameIds.clear();
      renderBulkToolbar();
    }
  }

  function renderRecentlyPlayedShelf() {
    const shelf = document.getElementById('recently-played-shelf');
    if (!shelf) return;
    if (currentCollectionDisplayPrefs.show_recently_played === false) {
      shelf.style.display = 'none';
      return;
    }
    const recentlyPlayed = state.games
      .filter(g => g.last_played && g.status === 'owned' && !g.parent_game_id)
      .sort((a, b) => new Date(b.last_played) - new Date(a.last_played))
      .slice(0, 8);
    if (recentlyPlayed.length < 2) { shelf.style.display = 'none'; return; }
    shelf.style.display = '';
    shelf.innerHTML = `
      <div class="recently-played-header">
        <span class="recently-played-title">Recently Played</span>
        <button class="recently-played-viewall" id="recently-played-viewall">View all</button>
      </div>
      <div class="recently-played-scroll" id="recently-played-scroll">
        ${recentlyPlayed.map(g => {
          const daysAgo = g.last_played
            ? Math.floor((Date.now() - new Date(g.last_played + 'T00:00:00')) / 86400000)
            : null;
          const dateLabel = daysAgo === null ? '' : daysAgo === 0 ? 'Today' : daysAgo === 1 ? 'Yesterday' : `${daysAgo}d ago`;
          return `<div class="recently-played-card" data-game-id="${g.id}" tabindex="0" title="${escapeHtml(g.name)}">
            ${isSafeUrl(g.image_url)
              ? `<img src="${escapeHtml(g.image_url)}" alt="" loading="lazy">`
              : `<div class="recently-played-placeholder"></div>`}
            <div class="recently-played-name">${escapeHtml(g.name)}</div>
            ${dateLabel ? `<div class="recently-played-date">${dateLabel}</div>` : ''}
          </div>`;
        }).join('')}
      </div>`;
    shelf.querySelectorAll('.recently-played-card').forEach(card => {
      const handler = () => {
        const game = state.games.find(g => g.id === +card.dataset.gameId);
        if (game) openGameModal(game);
      };
      card.addEventListener('click', handler);
      card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); } });
    });
    document.getElementById('recently-played-viewall')?.addEventListener('click', () => {
      const sortEl = document.getElementById('sort-by');
      if (sortEl) { sortEl.value = 'last_played'; state.sortBy = 'last_played'; }
      loadCollection();
    });

    // Momentum drag scroll for the shelf
    const scrollEl = document.getElementById('recently-played-scroll');
    if (scrollEl) {
      let isDown = false, startX, scrollLeft, velX = 0, rafId;
      scrollEl.addEventListener('mousedown', e => {
        isDown = true; startX = e.pageX - scrollEl.offsetLeft;
        scrollLeft = scrollEl.scrollLeft; velX = 0;
        cancelAnimationFrame(rafId);
      });
      scrollEl.addEventListener('mouseleave', () => { if (isDown) { isDown = false; momentum(); } });
      scrollEl.addEventListener('mouseup', () => { isDown = false; momentum(); });
      scrollEl.addEventListener('mousemove', e => {
        if (!isDown) return;
        e.preventDefault();
        const x = e.pageX - scrollEl.offsetLeft;
        const walk = x - startX;
        velX = walk - (scrollEl.scrollLeft - scrollLeft);
        scrollEl.scrollLeft = scrollLeft - walk;
      });
      function momentum() {
        function tick() {
          if (Math.abs(velX) < 0.5) return;
          scrollEl.scrollLeft -= velX;
          velX *= 0.90;
          rafId = requestAnimationFrame(tick);
        }
        rafId = requestAnimationFrame(tick);
      }
    }
  }

  function renderCollection() {
    const container   = document.getElementById('games-container');
    const emptyState  = document.getElementById('empty-state');
    const statsEl     = document.getElementById('collection-stats');

    // state.games is already server-filtered; just render it directly
    state.filteredGames = state.games;
    const filtered = state.filteredGames;

    if (state.games.length > 0) {
      const cs = state.collectionStats;
      const shownNum = filtered.length;
      // When any filter is active, the ticker must describe *the filtered view*,
      // not the whole collection — otherwise users see e.g. "10 shown · 412 hrs
      // played · 38 rated" under the Wishlist tab, where 412/38 still count the
      // entire library. Derive rated/unplayed from state.games (already
      // server-filtered); drop total hours since the game listing payload does
      // not carry per-game play minutes.
      const filterActive = state.statusFilter !== 'all' || hasActiveFilters() || !!state.search;
      const totalHrs = filterActive ? 0 : (cs ? Math.round(cs.total_hours) : 0);
      const rated = filterActive
        ? filtered.filter(g => g.user_rating != null).length
        : (cs ? cs.rated_count : 0);
      const neverPlayedCount = filterActive
        ? filtered.filter(g => !g.last_played).length
        : (cs ? cs.unplayed_count : 0);

      // Ticker HTML with animated count-up numbers
      const tickerParts = [
        `<span class="ticker-num" data-target="${shownNum}">${shownNum}</span> shown`,
        ...(totalHrs > 0 ? [`<span class="ticker-sep">·</span><span class="ticker-num" data-target="${totalHrs}">${totalHrs}</span> hrs played`] : []),
        ...(rated > 0 ? [`<span class="ticker-sep">·</span><span class="ticker-num" data-target="${rated}">${rated}</span> rated`] : []),
        ...(neverPlayedCount > 0 ? [`<span class="ticker-sep">·</span><span class="ticker-num" data-target="${neverPlayedCount}">${neverPlayedCount}</span> unplayed`] : []),
      ];
      statsEl.innerHTML = tickerParts.join(' ');
      statsEl.querySelectorAll('.ticker-num').forEach(el => animateCountUp(el, +el.dataset.target));
    } else {
      statsEl.innerHTML = '';
    }

    // Tear down any active virtual-page observer and stale sentinel / load-more
    // button BEFORE the early-return paths so they are never left alive on an
    // empty tab (their stale closures would otherwise append old game cards).
    _virtualPageObserver?.disconnect();
    _virtualPageObserver = null;
    _heatIo?.disconnect();
    _heatIo = null;
    document.getElementById('virtual-sentinel')?.remove();
    document.getElementById('server-load-more')?.remove();

    container.innerHTML = '';
    container.style.paddingTop = '';

    // Check if this is a truly empty collection (all tab, no games) vs an empty filtered tab
    const isTrulyEmpty = state.statusFilter === 'all' && state.games.length === 0 && !hasActiveFilters() && !state.search;
    const isEmptyFilteredTab = state.games.length === 0 && !isTrulyEmpty;

    if (isTrulyEmpty) {
      emptyState.style.display = 'flex';
      document.getElementById('recently-played-shelf').style.display = 'none';
      return;
    }

    emptyState.style.display = 'none';

    if (isEmptyFilteredTab) {
      // Handle empty filtered tabs (wishlist, owned, sold with no games) or active filters with no results
      const filtersActive = hasActiveFilters();

      // Build tab-specific empty message
      let emptyMessage = 'No games match your filters.';
      let addActionHtml = '';
      if (!filtersActive && !state.search) {
        // This is an empty status tab (wishlist, owned, sold)
        const tabLabels = { owned: 'owned', wishlist: 'wishlist', sold: 'sold' };
        const tabName = tabLabels[state.statusFilter] || state.statusFilter;
        emptyMessage = `No ${tabName} games yet.`;
      } else if (state.search && !filtersActive) {
        // Search found no results — show inline empty with option to add
        emptyMessage = `No matches for "${state.search}"`;
        addActionHtml = `<button class="btn btn-primary btn-sm" id="no-results-add-game">Add "${escapeHtml(state.search)}" as a new game</button>`;
      }

      const clearBtn = filtersActive
        ? `<button class="btn btn-secondary btn-sm" id="no-results-clear-filters">Clear filters</button>`
        : '';
      container.innerHTML = `<div class="empty-search-state">
        <svg class="empty-shelf-svg" viewBox="0 0 220 110" width="220" height="110" aria-hidden="true" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="10" y="82" width="200" height="7" rx="2.5" fill="var(--bg-4)"/>
          <rect x="18" y="50" width="22" height="32" rx="2" fill="var(--accent)" opacity="0.25"/>
          <rect x="44" y="42" width="18" height="40" rx="2" fill="var(--bg-3)" stroke="var(--border)" stroke-width="1"/>
          <rect x="66" y="56" width="26" height="26" rx="2" fill="var(--bg-4)" opacity="0.7"/>
          <rect x="96" y="46" width="22" height="36" rx="2" fill="var(--bg-3)" stroke="var(--accent)" stroke-width="1.5" stroke-dasharray="3 2"/>
          <text x="107" y="68" text-anchor="middle" font-size="13" fill="var(--accent)" font-weight="700" font-family="Georgia,serif">?</text>
          <rect x="124" y="52" width="24" height="30" rx="2" fill="var(--bg-3)" stroke="var(--border)" stroke-width="1"/>
          <rect x="153" y="40" width="16" height="42" rx="2" fill="var(--accent)" opacity="0.18"/>
          <rect x="173" y="58" width="20" height="24" rx="2" fill="var(--bg-4)" opacity="0.5"/>
        </svg>
        <p class="empty-search-text">${escapeHtml(emptyMessage)}</p>
        <div id="search-suggestions" style="display:none" class="search-suggestions"></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center">${clearBtn}${addActionHtml}</div>
      </div>`;
      document.getElementById('no-results-clear-filters')?.addEventListener('click', () => {
        document.getElementById('filter-clear-all')?.click();
      });
      document.getElementById('no-results-add-game')?.addEventListener('click', () => {
        const term = state.search;
        const searchInput = document.getElementById('collection-search');
        if (searchInput) searchInput.value = '';
        state.search = '';
        const clearBtn = document.getElementById('clear-search');
        if (clearBtn) clearBtn.style.display = 'none';
        switchView('add');
        setTimeout(() => {
          const nameInput = document.getElementById('m-name');
          if (nameInput) { nameInput.value = term; nameInput.focus(); }
        }, 100);
      });
      // "Did you mean?" suggestions — fetch close-match game names when search
      // finds no results and no filters are active.
      if (state.search && !filtersActive) {
        const term = state.search;
        API.searchSuggestions(term).then(({ suggestions }) => {
          if (suggestions && suggestions.length && state.search === term) {
            const sugEl = document.getElementById('search-suggestions');
            if (!sugEl) return;
            const links = suggestions.map(s => `<button class="suggestion-chip" type="button">${escapeHtml(s)}</button>`).join('');
            sugEl.innerHTML = `<span class="suggestion-label">Did you mean:</span> ${links}`;
            sugEl.style.display = 'block';
            sugEl.querySelectorAll('.suggestion-chip').forEach(btn => {
              btn.addEventListener('click', () => {
                const searchInput = document.getElementById('collection-search');
                if (searchInput) searchInput.value = btn.textContent;
                state.search = btn.textContent;
                renderCollection();
              });
            });
          }
        }).catch(() => {});
      }
    if (currentCollectionDisplayPrefs.show_recently_played !== false) {
      renderRecentlyPlayedShelf();
    }
      return;
    }

    if (currentCollectionDisplayPrefs.show_recently_played !== false) {
      renderRecentlyPlayedShelf();
    }

    // Wishlist value banner
    const existingBanner = document.querySelector('.wishlist-banner');
    if (existingBanner) existingBanner.remove();
    if (state.statusFilter === 'wishlist' && filtered.length > 0) {
      const totalTarget = filtered.reduce((s, g) => s + (g.target_price || 0), 0);
      const priorityCount = filtered.filter(g => g.priority).length;
      const banner = document.createElement('div');
      banner.className = 'wishlist-banner';
      banner.innerHTML = `<span class="wishlist-banner-stat"><strong>${filtered.length}</strong> ${filtered.length === 1 ? 'game' : 'games'} wanted</span>`
        + (totalTarget > 0 ? `<span class="wishlist-banner-stat">Target total: <strong>$${totalTarget.toFixed(2)}</strong></span>` : '')
        + (priorityCount > 0 ? `<span class="wishlist-banner-stat"><strong>${priorityCount}</strong> prioritized</span>` : '');
      if (container.parentNode) container.parentNode.insertBefore(banner, container);
    }

    container.className = state.viewMode === 'grid' ? 'games-grid' : 'games-list';
    if (state.viewMode === 'grid' && state.gridDensity && state.gridDensity !== 'large') {
      container.classList.add(`density-${state.gridDensity}`);
    }

    // Grouped view: base games with nested expansion rows.
    if (state.viewMode === 'grouped') {
      container.className = 'games-grouped';
      // Build expansion map from the full games list (expansions may be filtered out
      // of `filtered` when showExpansions is false, so always use state.games).
      const expansionsByParent = {};
      for (const g of state.games) {
        if (g.parent_game_id) {
          (expansionsByParent[g.parent_game_id] ||= []).push(g);
        }
      }
      // In grouped view, only base games (no parent) are primary cards.
      const baseGames = filtered.filter(g => !g.parent_game_id);

      function _buildGroupedCard(game) {
        const wrapper = document.createElement('div');
        wrapper.className = 'grouped-game-wrapper';
        const gameWithMeta = Object.assign({}, game, { _expansionCount: game.expansion_count || 0 });
        const card = buildGameListItem(gameWithMeta);
        card.tabIndex = 0;
        card.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openGameModal(game); }
        });
        if (state.bulkMode) {
          card.style.position = 'relative';
          const cb = document.createElement('div');
          cb.className = 'bulk-checkbox';
          cb.setAttribute('role', 'checkbox');
          cb.setAttribute('aria-checked', state.selectedGameIds.has(game.id) ? 'true' : 'false');
          cb.setAttribute('aria-label', `Select ${game.name}`);
          cb.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>';
          card.insertBefore(cb, card.firstChild);
          if (state.selectedGameIds.has(game.id)) card.classList.add('selected');
        }
        wrapper.appendChild(card);

        const exps = expansionsByParent[game.id] || [];
        if (exps.length > 0) {
          const toggle = document.createElement('button');
          toggle.className = 'expansion-toggle';
          toggle.type = 'button';
          toggle.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="chevron"><polyline points="6 9 12 15 18 9"/></svg> ${exps.length} expansion${exps.length > 1 ? 's' : ''} <span class="rolled-up-plays">(${game.rolled_up_session_count || 0} plays total)</span>`;
          const expList = document.createElement('div');
          expList.className = 'expansion-list';
          expList.style.display = 'none';
          exps.forEach(exp => {
            const expCard = buildGameListItem(exp);
            expCard.tabIndex = 0;
            expCard.addEventListener('keydown', e => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openGameModal(exp); }
            });
            expCard.addEventListener('click', () => openGameModal(exp));
            expList.appendChild(expCard);
          });
          toggle.addEventListener('click', () => {
            const isOpen = expList.style.display !== 'none';
            expList.style.display = isOpen ? 'none' : 'block';
            toggle.classList.toggle('open', !isOpen);
          });
          wrapper.appendChild(toggle);
          wrapper.appendChild(expList);
        }
        return wrapper;
      }

      state.virtualOffset = 0;
      const firstPage = baseGames.slice(0, VIRTUAL_PAGE_SIZE);
      firstPage.forEach(game => container.appendChild(_buildGroupedCard(game)));
      if (baseGames.length > VIRTUAL_PAGE_SIZE) {
        state.virtualOffset = VIRTUAL_PAGE_SIZE;
        const sentinel = document.createElement('div');
        sentinel.className = 'virtual-sentinel';
        container.appendChild(sentinel);
        const io = new IntersectionObserver((entries) => {
          if (!entries[0].isIntersecting) return;
          const next = baseGames.slice(state.virtualOffset, state.virtualOffset + VIRTUAL_PAGE_SIZE);
          if (next.length === 0) { io.disconnect(); return; }
          next.forEach(game => container.insertBefore(_buildGroupedCard(game), sentinel));
          state.virtualOffset += next.length;
        });
        io.observe(sentinel);
      }
      return;
    }

    // Build a single card element for a game
    function _buildCard(game) {
      const gameWithMeta = Object.assign({}, game, { _expansionCount: game.expansion_count || 0 });
      const el = state.viewMode === 'grid' ? buildGameCard(gameWithMeta) : buildGameListItem(gameWithMeta);
      el.tabIndex = 0;
      el.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openGameModal(game); }
      });
      if (state.bulkMode) {
        el.style.position = 'relative';
        const cb = document.createElement('div');
        cb.className = 'bulk-checkbox';
        cb.setAttribute('role', 'checkbox');
        cb.setAttribute('aria-checked', state.selectedGameIds.has(game.id) ? 'true' : 'false');
        cb.setAttribute('aria-label', `Select ${game.name}`);
        cb.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>';
        el.insertBefore(cb, el.firstChild);
        if (state.selectedGameIds.has(game.id)) el.classList.add('selected');
      } else if (state.viewMode === 'grid') {
        const cardMedia = el.querySelector('.game-card-image');
        if (cardMedia && game.image_url && game.image_url.includes(`/games/${game.id}/images/`)) {
          cardMedia.classList.add('gallery-clickable');
        }
      }
      return el;
    }

    // Wire scroll-in animation for newly appended grid cards
    function _observeNewCards() {
      if (state.viewMode !== 'grid' || !('IntersectionObserver' in window)) return;
      const cards = container.querySelectorAll('.game-card:not([data-observed])');
      const io = new IntersectionObserver((entries, obs) => {
        entries.forEach(e => {
          if (!e.isIntersecting) return;
          e.target.classList.add('card-visible');
          obs.unobserve(e.target);
        });
      }, { threshold: 0.04 });
      // Separate persistent observer to pause/resume heat-pulse animation.
      // Uses the module-level _heatIo so it can be disconnected in renderCollection teardown.
      if (!_heatIo) {
        _heatIo = new IntersectionObserver(entries => {
          entries.forEach(e => e.target.classList.toggle('in-view', e.isIntersecting));
        }, { threshold: 0.01 });
      }
      cards.forEach((c, i) => {
        c.dataset.observed = '1';
        c.style.transitionDelay = `${Math.min(i * 28, 250)}ms`;
        io.observe(c);
        if (c.dataset.heat === '3') _heatIo.observe(c);
      });
    }

    state.virtualOffset = 0;

    // Render first page
    const firstPage = filtered.slice(0, VIRTUAL_PAGE_SIZE);
    firstPage.forEach(game => container.appendChild(_buildCard(game)));
    _observeNewCards();

    // If there are more in state.games to render, attach an intersection sentinel
    if (filtered.length > VIRTUAL_PAGE_SIZE) {
      state.virtualOffset = VIRTUAL_PAGE_SIZE;
      const sentinel = document.createElement('div');
      sentinel.id = 'virtual-sentinel';
      container.after(sentinel);

      _virtualPageObserver = new IntersectionObserver((entries) => {
        if (!entries[0].isIntersecting) return;
        const src = state.filteredGames;
        const next = src.slice(state.virtualOffset, state.virtualOffset + VIRTUAL_PAGE_SIZE);
        if (!next.length) { _virtualPageObserver?.disconnect(); _virtualPageObserver = null; sentinel.remove(); return; }
        next.forEach(game => container.appendChild(_buildCard(game)));
        state.virtualOffset += VIRTUAL_PAGE_SIZE;
        _observeNewCards();
        if (state.virtualOffset >= src.length) { _virtualPageObserver?.disconnect(); _virtualPageObserver = null; sentinel.remove(); }

        // Recycle cards that have scrolled far above the viewport. Measure
        // the height of the block to be removed *before* removing it, then
        // compensate with padding-top so the scroll position doesn't jump.
        // Browsers with scroll-anchoring handle this automatically; the
        // padding ensures correct behaviour everywhere else.
        const allCards = Array.from(container.querySelectorAll('.game-card'));
        if (allCards.length > 3 * VIRTUAL_PAGE_SIZE) {
          const toRemove  = allCards.slice(0, VIRTUAL_PAGE_SIZE);
          const firstKept = allCards[VIRTUAL_PAGE_SIZE];
          const removedHeight = firstKept
            ? firstKept.getBoundingClientRect().top - toRemove[0].getBoundingClientRect().top
            : 0;
          toRemove.forEach(c => c.remove());
          container.style.paddingTop =
            `${parseFloat(container.style.paddingTop || '0') + removedHeight}px`;
        }
      }, { rootMargin: '300px' });

      _virtualPageObserver.observe(sentinel);
    }

    // If the server has more games beyond the current page, show a "Load more" button
    if (state.serverTotal > state.serverOffset) {
      const remaining = state.serverTotal - state.serverOffset;
      const btn = document.createElement('button');
      btn.id = 'server-load-more';
      btn.className = 'btn btn-secondary';
      btn.style.cssText = 'display:block;margin:24px auto;min-width:200px';
      btn.textContent = `Load ${Math.min(remaining, SERVER_PAGE_SIZE)} more games…`;
      container.after(btn);
      btn.addEventListener('click', async () => {
        const capturedReqId = _loadCollectionReqId;
        await withLoading(btn, async () => {
          try {
            const { data: nextPage, total } = await API.getGames(buildFilterParams(state.serverOffset));
            if (capturedReqId !== _loadCollectionReqId) return;  // superseded by newer load
            if (nextPage) {
              state.games = state.games.concat(nextPage);
              state.serverOffset += nextPage.length;
              state.serverTotal = total;
            }
          } catch (err) {
            showToast(classifyError(err), 'error');
            return;
          }
          renderCollection();
        }, 'Loading…');
      });
    }
  }

  // ===== Game Modal =====
  function _findGameNavIndex(gameId) {
    return state.games.findIndex(g => g.id === gameId);
  }

  async function openGameModal(game, mode = 'view', onBack = null) {
    const isLogMode = mode === 'log';
    const effectiveMode = isLogMode ? 'view' : mode;
    const [sessResult, imgResult] = await Promise.allSettled([
      API.getSessions(game.id),
      API.getImages(game.id),
    ]);
    const sessions = sessResult.status === 'fulfilled' ? sessResult.value : [];
    const images   = imgResult.status  === 'fulfilled' ? imgResult.value  : [];

    const onSwitchToEdit = () => openGameModal(game, 'edit', onBack);
    const onSwitchToView = (freshGame) => {
      if (freshGame) {
        updateGameInState(freshGame.id, freshGame);
      }
      const fresh = state.games.find(g => g.id === game.id) || freshGame || game;
      openGameModal(fresh, isLogMode ? 'log' : 'view', onBack);
    };

    const onShareGame = async () => {
      const tokens = await API.getShareTokens() ?? [];
      const permanent = tokens.find(t => !t.expires_at);
      let rawToken;
      if (permanent) {
        rawToken = localStorage.getItem(`share_token_${permanent.token}`);
      }
      if (!rawToken) {
        const newToken = await API.createShareToken('Game Share', 10);
        rawToken = newToken.token;
        if (newToken.token_hash) {
          localStorage.setItem(`share_token_${newToken.token_hash}`, rawToken);
        }
      }
      return `${window.location.origin}/share.html#token=${rawToken}&game=${game.id}`;
    };

    const navIdx = effectiveMode === 'view' ? _findGameNavIndex(game.id) : -1;
    const prevGame = navIdx > 0 ? state.games[navIdx - 1] : null;
    const nextGame = navIdx >= 0 && navIdx < state.games.length - 1 ? state.games[navIdx + 1] : null;
    const navInfo = effectiveMode === 'view' ? {
      prevGame,
      nextGame,
      onPrev: prevGame ? () => openGameModal(prevGame, 'view') : null,
      onNext: nextGame ? () => openGameModal(nextGame, 'view') : null,
    } : null;

    const contentEl = buildModalContent({
      game, sessions,
      onSave: handleSaveGame,
      onDelete: handleDeleteGame,
      onAddSession: handleAddSession,
      onDeleteSession: handleDeleteSession,
      onUpdateSession: handleUpdateSession,
      onUploadInstructions: handleUploadInstructions,
      onDeleteInstructions: handleDeleteInstructions,
      onUploadImage: handleUploadImage,
      onDeleteImage: handleDeleteImage,
      images,
      onUploadGalleryImage: handleUploadGalleryImage,
      onDeleteGalleryImage: handleDeleteGalleryImage,
      onReorderGalleryImages: handleReorderGalleryImages,
      onAddGalleryImageFromUrl: handleAddGalleryImageFromUrl,
      onUpdateGalleryImageCaption: handleUpdateGalleryImageCaption,
      mode: effectiveMode,
      onSwitchToEdit,
      onSwitchToView,
      allGames: state.games,
      onOpenGame: (targetGame) => openGameModal(targetGame, 'view', () => openGameModal(game, 'view', onBack)),
      onShareGame,
      onCloseModal: () => { activeModal = null; closeModal(); },
      navInfo,
    });

    if (onBack) {
      const backBtn = document.createElement('button');
      backBtn.className = 'modal-back-btn';
      backBtn.setAttribute('aria-label', 'Back');
      backBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>`;
      backBtn.addEventListener('click', (e) => { e.stopPropagation(); onBack(); });
      const hero = contentEl.querySelector('.modal-hero');
      if (hero) hero.appendChild(backBtn);
    }

    activeModal = { game, mode: effectiveMode };
    openModal(contentEl);

    // Initialize chip inputs for edit mode
    if (effectiveMode === 'edit') {
      requestAnimationFrame(() => {
        _renderChipInput('edit-categories', JSON.parse(game.categories || '[]'), 'Category', 'dl-categories');
        _renderChipInput('edit-mechanics',  JSON.parse(game.mechanics  || '[]'), 'Mechanic', 'dl-mechanics');
        _renderChipInput('edit-designers',  JSON.parse(game.designers  || '[]'), 'Designer', 'dl-designers');
        _renderChipInput('edit-publishers', JSON.parse(game.publishers || '[]'), 'Publisher', 'dl-publishers');
        _renderChipInput('edit-labels',     JSON.parse(game.labels     || '[]'), 'Label', 'dl-labels');
      });
    }

    if (isLogMode) {
      requestAnimationFrame(() => {
        const sessionForm = document.getElementById('log-session-form');
        const sessionToggle = document.getElementById('log-session-toggle');
        if (sessionForm && sessionToggle) {
          sessionForm.style.display = 'block';
          sessionToggle.textContent = '− Cancel';
        }
      });
    }
  }

  function openQuickLogSession(game) {
    const today = new Date().toLocaleDateString('en-CA');
    openCompactQuickLog(game, null, today);
  }

  function openCompactQuickLog(game, anchorEl, today) {
    // If there's already a compact popover, remove it
    const existing = document.querySelector('.ql-compact-popover');
    if (existing) { existing.remove(); return; }

    const todayStr = today || new Date().toLocaleDateString('en-CA');
    const prevFocus = document.activeElement;
    const popover = document.createElement('div');
    popover.className = 'ql-compact-popover';
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-modal', 'true');
    popover.setAttribute('aria-label', `Quick log: ${game.name}`);
    popover.innerHTML = `
      <div class="ql-compact-header">
        <span class="ql-compact-game">${escapeHtml(game.name)}</span>
      </div>
      <div class="ql-compact-fields">
        <div class="ql-compact-row">
          <label class="ql-compact-label" for="qlc-date">Date</label>
          <input type="date" class="ql-compact-input" id="qlc-date" value="${todayStr}" autocomplete="off">
        </div>
        <div class="ql-compact-row">
          <span class="ql-compact-label" id="qlc-rating-label">Rating</span>
          <div class="star-picker ql-compact-stars" id="qlc-rating" data-value="0" role="group" aria-labelledby="qlc-rating-label">
            ${[1,2,3,4,5].map(n => `<button type="button" class="star-btn star-btn-sm" data-val="${n}" title="${n} star${n>1?'s':''}" aria-label="${n} star${n>1?'s':''}"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><polygon points="8 1.5 10 5.5 14.5 6.1 11.2 9.2 12 13.7 8 11.6 4 13.7 4.8 9.2 1.5 6.1 6 5.5"/></svg></button>`).join('')}
          </div>
        </div>
        <div class="ql-compact-row">
          <label class="ql-compact-label" for="qlc-duration">Duration</label>
          <input type="number" class="ql-compact-input" id="qlc-duration" min="1" placeholder="min" autocomplete="off">
        </div>
      </div>
      <div class="ql-compact-actions">
        <button class="btn btn-primary btn-sm" id="qlc-submit">Log it</button>
        <button class="btn btn-ghost btn-sm" id="qlc-more">More</button>
      </div>
      <button class="ql-compact-close" id="qlc-close" aria-label="Close"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3.5 3.5 L12.5 12.5 M12.5 3.5 L3.5 12.5"/></svg></button>
    `;

    document.body.appendChild(popover);
    pushModalOpen();

    const ac = new AbortController();
    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      ac.abort();
      popover.classList.remove('open');
      setTimeout(() => { popover.remove(); popModalOpen(); if (prevFocus && prevFocus.focus) prevFocus.focus(); }, 200);
    }

    function onKeyDown(e) {
      if (e.key === 'Escape') { close(); return; }
      if (e.key === 'Tab') {
        const focusable = popover.querySelector('button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])');
        const all = Array.from(popover.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'));
        if (!all.length) return;
        const first = all[0], last = all[all.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }

    function onOutsideClick(e) {
      if (!popover.contains(e.target) && e.target !== anchorEl && !(anchorEl && anchorEl.contains(e.target))) {
        close();
      }
    }

    // Position logic: if anchorEl provided, position near it; otherwise centered
    if (anchorEl) {
      const anchorRect = anchorEl.getBoundingClientRect();
      const popoverW = 260;
      const gap = 8;
      let left = anchorRect.left + anchorRect.width / 2 - popoverW / 2;
      let top = anchorRect.top - gap;
      if (left < 8) left = 8;
      if (left + popoverW > window.innerWidth - 8) left = window.innerWidth - popoverW - 8;
      // Flip below if not enough room above (use anchor height, not magic number)
      if (top < 8 || (anchorRect.top < popover.offsetHeight + gap && anchorRect.bottom + popover.offsetHeight + gap < window.innerHeight)) {
        if (anchorRect.bottom + gap + 200 < window.innerHeight) {
          top = anchorRect.bottom + gap;
        }
      }
      popover.style.left = left + 'px';
      popover.style.top = top + 'px';
    } else {
      popover.classList.add('ql-compact-centered');
    }
    requestAnimationFrame(() => {
      popover.classList.add('open');
      popover.querySelector('#qlc-date').focus();
    });

    document.addEventListener('keydown', onKeyDown, { signal: ac.signal });
    popover.querySelector('#qlc-close').addEventListener('click', close, { signal: ac.signal });

    // Star picker
    const ratingPicker = popover.querySelector('#qlc-rating');
    ratingPicker.addEventListener('click', e => {
      const btn = e.target.closest('.star-btn');
      if (!btn) return;
      const val = parseInt(btn.dataset.val, 10);
      ratingPicker.dataset.value = val;
      ratingPicker.querySelectorAll('.star-btn').forEach(b => b.classList.toggle('active', parseInt(b.dataset.val, 10) <= val));
    }, { signal: ac.signal });
    ratingPicker.addEventListener('mouseover', e => {
      const btn = e.target.closest('.star-btn');
      if (!btn) return;
      const val = parseInt(btn.dataset.val, 10);
      ratingPicker.querySelectorAll('.star-btn').forEach(b => b.classList.toggle('active', parseInt(b.dataset.val, 10) <= val));
    }, { signal: ac.signal });
    ratingPicker.addEventListener('mouseleave', () => {
      const saved = parseInt(ratingPicker.dataset.value, 10) || 0;
      ratingPicker.querySelectorAll('.star-btn').forEach(b => b.classList.toggle('active', parseInt(b.dataset.val, 10) <= saved));
    }, { signal: ac.signal });

    // Submit
    popover.querySelector('#qlc-submit').addEventListener('click', async () => {
      const dateVal = popover.querySelector('#qlc-date').value;
      if (!dateVal) { showToast('Please enter a date.', 'error'); return; }
      const rating = parseInt(ratingPicker.dataset.value, 10) || null;
      const duration = parseInt(popover.querySelector('#qlc-duration').value, 10) || null;
      await withLoading(popover.querySelector('#qlc-submit'), () => handleAddSession(game.id, {
        played_at: dateVal,
        session_rating: rating,
        duration_minutes: duration,
      }, () => {
        renderCollection();
        refreshStatsBackground();
        refreshCollectionStats();
      }), 'Logging…');
      close();
    });

    // More options — open full form
    popover.querySelector('#qlc-more').addEventListener('click', () => {
      close();
      const compactDate = popover.querySelector('#qlc-date').value;
      openQuickLogSessionFull(game, compactDate);
    }, { signal: ac.signal });

    document.addEventListener('mousedown', onOutsideClick, { signal: ac.signal });
  }

  function openQuickLogSessionFull(game, presetDate) {
    const today = presetDate || new Date().toLocaleDateString('en-CA');
    const prevFocus = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'quick-log-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', `Log play: ${game.name}`);
    overlay.innerHTML = `
      <div class="quick-log-backdrop"></div>
      <div class="quick-log-popup">
        <button class="quick-log-close" aria-label="Close" type="button">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6 L18 18 M18 6 L6 18"/></svg>
        </button>
        <div class="quick-log-header">
          <span class="quick-log-label">Log Play</span>
          <span class="quick-log-game"></span>
        </div>
        <div class="quick-log-form">
          <div class="quick-log-field">
            <label for="ql-date">Date</label>
            <input type="date" id="ql-date" class="form-input" value="${escapeHtml(today)}" autocomplete="off">
          </div>
          <div class="quick-log-field">
            <label for="ql-players">Players</label>
            <input type="number" id="ql-players" class="form-input" min="1" max="20" placeholder="optional" autocomplete="off">
          </div>
          <div class="quick-log-field">
            <label for="ql-duration">Duration (min)</label>
            <input type="number" id="ql-duration" class="form-input" min="1" placeholder="optional" autocomplete="off">
          </div>
          <div class="quick-log-field ql-full">
            <label for="ql-notes">Notes</label>
            <input type="text" id="ql-notes" class="form-input" placeholder="optional" autocomplete="off">
          </div>
          <div class="quick-log-field ql-full">
            <span id="ql-rating-label" class="quick-log-field-label">Session Rating</span>
            <div class="star-picker" id="ql-rating-picker" role="group" aria-labelledby="ql-rating-label" data-value="0">
              ${[1,2,3,4,5].map(n => `<button type="button" class="star-btn" data-val="${n}" title="${n} star${n>1?'s':''}" aria-label="${n} star${n>1?'s':''}">★</button>`).join('')}
            </div>
          </div>
          <div class="quick-log-field ql-full">
            <div class="quick-log-toggle-row">
              <label class="inline-toggle">
                <input type="checkbox" id="ql-solo"> Solo game
              </label>
              <label class="inline-toggle">
                <input type="checkbox" id="ql-coop"> Cooperative
              </label>
            </div>
          </div>
          <div id="ql-coop-fields" class="ql-hidden">
            <div class="quick-log-field ql-full">
              <span class="quick-log-field-label">Outcome</span>
              <div class="ql-coop-outcome">
                ${[['win','🏆 Win'],['loss','❌ Loss'],['draw','🤝 Draw'],['incomplete','⏹ Incomplete']].map(([v,l]) => `<label class="inline-toggle"><input type="radio" name="ql-outcome" value="${v}"> ${l}</label>`).join('')}
              </div>
            </div>
            <div class="quick-log-field ql-full">
              <label for="ql-scenario">Scenario / Difficulty</label>
              <input type="text" id="ql-scenario" class="form-input" placeholder="optional" autocomplete="off">
            </div>
          </div>
          <div id="ql-multiplayer-fields">
            <div class="quick-log-field ql-full" id="ql-winner-field">
              <label for="ql-winner">Winner</label>
              <input type="text" id="ql-winner" class="form-input" placeholder="optional" autocomplete="off" list="ql-player-list">
              <datalist id="ql-player-list">${state.players.map(p => `<option value="${escapeHtml(p)}">`).join('')}</datalist>
            </div>
            <div class="quick-log-field ql-full">
              <label>Who played?</label>
              ${state.players.length ? `<div class="ql-player-chips" id="ql-player-chips">
                ${(() => {
                  const playerMap = Object.fromEntries((state.playerObjects || []).map(p => [p.name, p]));
                  return state.players.slice(0, 10).map(name => {
                    const pObj = playerMap[name] || { name, avatar_url: null };
                    return `<button type="button" class="ql-player-chip" data-name="${escapeHtml(name)}">${renderPlayerAvatar(pObj, 'ql-chip-avatar')}${escapeHtml(name)}</button>`;
                  }).join('');
                })()}
              </div>` : ''}
              <input type="text" id="ql-players-names" class="form-input" placeholder="${state.players.length ? 'Or type additional names…' : 'comma-separated names'}" autocomplete="off">
            </div>
            <div id="ql-scores-section" class="ql-hidden">
              <div class="quick-log-field ql-full">
                <span class="quick-log-field-label">Scores (optional)</span>
                <div id="ql-scores-list" class="ql-scores-list"></div>
              </div>
            </div>
          </div>
        </div>
        <div class="quick-log-actions">
          <button class="btn btn-primary btn-sm" id="ql-submit">Log Play</button>
          <button class="btn btn-ghost btn-sm" id="ql-cancel">Cancel</button>
        </div>
      </div>`;

    document.body.appendChild(overlay);
    overlay.querySelector('.quick-log-game').textContent = game.name;
    requestAnimationFrame(() => overlay.classList.add('open'));
    pushModalOpen();
    requestAnimationFrame(() => overlay.querySelector('#ql-date').focus());

    const popup = overlay.querySelector('.quick-log-popup');
    function trapFocus(e) {
      if (e.key !== 'Tab') return;
      const focusable = popup.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }

    function close() {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keydown', trapFocus);
      overlay.classList.remove('open');
      setTimeout(() => { overlay.remove(); popModalOpen(); if (prevFocus) prevFocus.focus(); }, 200);
    }

    function onKeyDown(e) {
      if (e.key === 'Escape') { close(); }
    }

    overlay.querySelector('.quick-log-backdrop').addEventListener('click', close);
    overlay.querySelector('#ql-cancel').addEventListener('click', close);
    overlay.querySelector('.quick-log-close').addEventListener('click', close);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keydown', trapFocus);

    // Star picker for quick log
    const qlRatingPicker = overlay.querySelector('#ql-rating-picker');
    if (qlRatingPicker) {
      qlRatingPicker.addEventListener('click', e => {
        const btn = e.target.closest('.star-btn');
        if (!btn) return;
        const val = parseInt(btn.dataset.val, 10);
        qlRatingPicker.dataset.value = val;
        qlRatingPicker.querySelectorAll('.star-btn').forEach(b => b.classList.toggle('active', parseInt(b.dataset.val, 10) <= val));
      });
      qlRatingPicker.addEventListener('mouseover', e => {
        const btn = e.target.closest('.star-btn');
        if (!btn) return;
        const val = parseInt(btn.dataset.val, 10);
        qlRatingPicker.querySelectorAll('.star-btn').forEach(b => b.classList.toggle('active', parseInt(b.dataset.val, 10) <= val));
      });
      qlRatingPicker.addEventListener('mouseleave', () => {
        const saved = parseInt(qlRatingPicker.dataset.value, 10) || 0;
        qlRatingPicker.querySelectorAll('.star-btn').forEach(b => b.classList.toggle('active', parseInt(b.dataset.val, 10) <= saved));
      });
    }

    // Solo / Cooperative mode toggle
    const soloCheckbox = overlay.querySelector('#ql-solo');
    const coopCheckbox = overlay.querySelector('#ql-coop');
    const multiplayerFields = overlay.querySelector('#ql-multiplayer-fields');
    const coopFields = overlay.querySelector('#ql-coop-fields');
    const winnerField = overlay.querySelector('#ql-winner-field');
    function applyMode() {
      const isSolo = soloCheckbox.checked;
      const isCoop = coopCheckbox.checked;
      multiplayerFields.classList.toggle('ql-hidden', isSolo);
      coopFields.classList.toggle('ql-hidden', !isCoop);
      if (winnerField) winnerField.classList.toggle('ql-hidden', isCoop);
    }
    soloCheckbox.addEventListener('change', () => {
      if (soloCheckbox.checked && coopCheckbox.checked) coopCheckbox.checked = false;
      applyMode();
    });
    coopCheckbox.addEventListener('change', () => {
      if (coopCheckbox.checked && soloCheckbox.checked) soloCheckbox.checked = false;
      applyMode();
    });

    // Player chip toggle + scores
    const chipsContainer = overlay.querySelector('#ql-player-chips');
    const scoresList = overlay.querySelector('#ql-scores-list');
    const scoresSection = overlay.querySelector('#ql-scores-section');

    function updateScoresList() {
      if (!scoresList) return;
      const activeChips = chipsContainer
        ? [...chipsContainer.querySelectorAll('.ql-player-chip.active')].map(c => c.dataset.name)
        : [];
      const typedNames = (overlay.querySelector('#ql-players-names').value || '').split(',').map(s => s.trim()).filter(Boolean);
      const allNames = [...new Set([...activeChips, ...typedNames])];
      if (!allNames.length) { scoresSection.classList.add('ql-hidden'); return; }
      scoresSection.classList.remove('ql-hidden');
      // Preserve existing score values
      const existing = {};
      scoresList.querySelectorAll('.ql-score-row').forEach(row => {
        existing[row.dataset.name] = row.querySelector('input').value;
      });
      scoresList.innerHTML = allNames.map(name => `
        <div class="ql-score-row" data-name="${escapeHtml(name)}">
          <span class="ql-score-name">${escapeHtml(name)}</span>
          <input type="number" class="form-input ql-score-input" placeholder="score" value="${escapeHtml(existing[name] || '')}" autocomplete="off">
        </div>`).join('');
    }

    if (chipsContainer) {
      chipsContainer.addEventListener('click', e => {
        const chip = e.target.closest('.ql-player-chip');
        if (chip) { chip.classList.toggle('active'); updateScoresList(); }
      });
    }
    overlay.querySelector('#ql-players-names').addEventListener('input', updateScoresList);

    const qlSubmitBtn = overlay.querySelector('#ql-submit');
    qlSubmitBtn.addEventListener('click', async () => {
      const dateVal = overlay.querySelector('#ql-date').value;
      if (!dateVal) { showToast('Please enter a date.', 'error'); return; }
      const isSolo = overlay.querySelector('#ql-solo').checked;
      const isCoop = overlay.querySelector('#ql-coop').checked;
      const outcomeEl = overlay.querySelector('input[name="ql-outcome"]:checked');
      // Merge chip selection + text input
      const chipSelected = (!isSolo && chipsContainer)
        ? [...chipsContainer.querySelectorAll('.ql-player-chip.active')].map(c => c.dataset.name)
        : [];
      const playerNamesRaw = isSolo ? '' : (overlay.querySelector('#ql-players-names').value || '');
      const typedNames = playerNamesRaw.split(',').map(s => s.trim()).filter(Boolean);
      const playerNames = [...new Set([...chipSelected, ...typedNames])];
      // Collect scores
      const scores = {};
      if (!isSolo && scoresList) {
        scoresList.querySelectorAll('.ql-score-row').forEach(row => {
          const val = parseInt(row.querySelector('input').value, 10);
          if (!isNaN(val)) scores[row.dataset.name] = val;
        });
      }
      const qlRp = overlay.querySelector('#ql-rating-picker');
      await withLoading(qlSubmitBtn, () => handleAddSession(game.id, {
        played_at:        dateVal,
        player_count:     parseInt(overlay.querySelector('#ql-players').value, 10) || null,
        duration_minutes: parseInt(overlay.querySelector('#ql-duration').value, 10) || null,
        notes:            overlay.querySelector('#ql-notes').value.trim() || null,
        session_rating:   qlRp ? (parseInt(qlRp.dataset.value, 10) || null) : null,
        winner:           (isSolo || isCoop) ? null : (overlay.querySelector('#ql-winner').value.trim() || null),
        solo:             isSolo,
        cooperative:      isCoop,
        outcome:          isCoop ? (outcomeEl ? outcomeEl.value : null) : null,
        scenario:         isCoop ? (overlay.querySelector('#ql-scenario').value.trim() || null) : null,
        player_names:     playerNames.length ? playerNames : null,
        scores:           Object.keys(scores).length ? scores : null,
      }, () => {
        renderCollection();
        refreshStatsBackground();
        refreshCollectionStats();
        // Refresh players list
        if (playerNames.length) {
          API.getPlayers().then(p => { state.players = p.map(pl => pl.name); state.playerObjects = p; }).catch(() => {});
        }
      }), 'Logging…');
      close();
    });
  }

  async function handleQuickStatusChange(gameId, newStatus) {
    const game = state.games.find(g => g.id === gameId);
    const oldStatus = game ? game.status : null;
    const gameName = game ? game.name : 'Game';
    // Optimistic update: apply immediately, roll back on failure
    if (game && oldStatus !== newStatus) {
      updateGameInState(gameId, { status: newStatus });
      renderCollection();
      refreshStatsBackground();
      refreshCollectionStats();
    }
    try {
      const updated = await API.updateGame(gameId, { status: newStatus });
      updateGameInState(gameId, updated);
      renderCollection();
      refreshStatsBackground();
      refreshCollectionStats();
      showToast('Added to collection!', 'success');
      if (oldStatus && oldStatus !== newStatus) {
        showUndoToast(`"${gameName}" moved to collection.`, async () => {
          try {
            const reverted = await API.updateGame(gameId, { status: oldStatus });
            updateGameInState(gameId, reverted);
            renderCollection();
            refreshStatsBackground();
            refreshCollectionStats();
            showToast(`"${gameName}" moved back to ${oldStatus}.`, 'success');
          } catch (err) {
            showToast(`Could not undo: ${classifyError(err)}`, 'error');
          }
        });
      }
    } catch (err) {
      if (oldStatus) {
        updateGameInState(gameId, { status: oldStatus });
        renderCollection();
        refreshStatsBackground();
        refreshCollectionStats();
      }
      showToast(`Update failed: ${classifyError(err)}`, 'error');
    }
  }

  async function handleSaveGame(gameId, payload) {
    try {
      const updated = await API.updateGame(gameId, payload);
      showToast('Changes saved!', 'success');
      closeModal();
      activeModal = null;
      updateGameInState(gameId, updated);
      renderCollection();
      refreshStatsBackground();
      refreshCollectionStats();
    } catch (err) {
      showToast(`Save failed: ${classifyError(err)}`, 'error');
    }
  }

  async function handleDeleteGame(gameId, gameName) {
    const confirmed = await showConfirm(
      'Remove Game',
      `Are you sure you want to remove "${gameName}" from your collection?`,
      { confirmLabel: 'Remove' }
    );
    if (!confirmed) return;
    try {
      const deletedGame = state.games.find(g => g.id === gameId);
      await API.deleteGame(gameId);
      closeModal();
      activeModal = null;
      state.games = state.games.filter(g => g.id !== gameId);
      renderCollection();
      refreshStatsBackground();
      refreshCollectionStats();

      // Undo toast — note: re-creating does NOT restore media files
      showUndoToast(`"${gameName}" removed.`, async () => {
        if (!deletedGame) return;
        try {
          const { id: _id, date_modified: _dm, image_cached: _ic, parent_game_name: _pgn, ...payload } = deletedGame;
          const restored = await API.createGame(payload);
          state.games.push(restored);
          state.games = sortGames(state.games, state.sortBy, state.sortDir);
          renderCollection();
          refreshCollectionStats();
          showToast(`"${gameName}" restored.`, 'success');
        } catch (err) {
          showToast(`Could not restore game: ${classifyError(err)}`, 'error');
        }
      });
    } catch (err) {
      showToast(`Failed to remove: ${classifyError(err)}`, 'error');
    }
  }

  async function checkAndShowMilestones(gameId, gameName, { count: preCount, totalMinutes: preTotalMinutes } = {}) {
    try {
      let count, totalHours;
      if (preCount != null && preTotalMinutes != null) {
        count = preCount;
        totalHours = preTotalMinutes / 60;
      } else {
        const summary = await API.getSessionSummary(gameId);
        count = summary.session_count;
        totalHours = summary.total_minutes / 60;
      }
      const earned     = loadMilestones();
      const seenKeys   = new Set(earned.map(m => m.key));
      const newOnes    = [];

      for (const n of COUNT_MILESTONES) {
        const key = `${gameId}:count:${n}`;
        if (count >= n && !seenKeys.has(key))
          newOnes.push({ key, gameId, gameName, type: 'count', value: n, earnedAt: new Date().toISOString() });
      }
      for (const h of HOURS_MILESTONES) {
        const key = `${gameId}:hours:${h}`;
        if (totalHours >= h && !seenKeys.has(key))
          newOnes.push({ key, gameId, gameName, type: 'hours', value: h, earnedAt: new Date().toISOString() });
      }

      if (!newOnes.length) return;
      saveMilestones([...earned, ...newOnes]);
      newOnes.forEach((m, i) => setTimeout(() => {
        const msg = m.type === 'count'
          ? `🎉 ${ordinal(m.value)} play of ${m.gameName}!`
          : `⏱ ${m.value} hours with ${m.gameName}!`;
        showMilestoneToast(msg, m.gameId, (id) => {
          const g = state.games.find(g => g.id === id);
          if (g) openGameModal(g);
        });
        const bigEnough = m.type === 'count' ? m.value >= CONFETTI_COUNT_THRESHOLD : m.value >= CONFETTI_HOURS_THRESHOLD;
        if (bigEnough) launchConfetti();
      }, i * 900));
    } catch (_) { /* non-fatal: never block normal session logging */ }
  }

  async function handleAddSession(gameId, sessionData, onSuccess) {
    // Optimistic update: bump session count and last_played immediately
    const game = state.games.find(g => g.id === gameId);
    const prevCount = game ? (game.session_count ?? 0) : 0;
    const prevLastPlayed = game ? game.last_played : null;
    const playedAt = sessionData.played_at || new Date().toLocaleDateString('en-CA');
    if (game) {
      updateGameInState(gameId, {
        session_count: prevCount + 1,
        last_played: !game.last_played || playedAt > game.last_played ? playedAt : game.last_played,
      });
      renderCollection();
    }
    try {
      const created = await API.addSession(gameId, sessionData);
      showToast('Session logged!', 'success');
      // +1 float animation on the game card
      const cardEl = document.querySelector(`.game-card[data-game-id="${gameId}"]`);
      if (cardEl) floatPlusOne(cardEl);
      // Update from server (which has authoritative count)
      updateGameInState(gameId, {
        last_played: created.played_at || playedAt,
        session_count: created.game_session_count,
      });
      renderCollection();
      if (onSuccess) onSuccess(created);
      // Milestone check fires after callback so UI updates first
      const gameName = state.games.find(g => g.id === gameId)?.name || 'this game';
      checkAndShowMilestones(gameId, gameName, {
        count: created.game_session_count,
        totalMinutes: created.game_total_minutes,
      });
      refreshCollectionStats();
    } catch (err) {
      if (err.isOfflineQueued) {
        // Keep the optimistic update — session is queued and will sync on reconnect
        showToast('Offline — session queued, will sync when back online.', 'info', 5000);
        return;
      }
      // Roll back optimistic update
      if (game) {
        updateGameInState(gameId, {
          session_count: prevCount,
          last_played: prevLastPlayed,
        });
        renderCollection();
      }
      showToast(`Failed to log session: ${classifyError(err)}`, 'error');
    }
  }

  async function handleUpdateSession(sessionId, gameId, data, onSuccess) {
    try {
      const updated = await API.updateSession(sessionId, data);
      showToast('Session updated!', 'success');
      try {
        const freshGame = await API.getGame(gameId);
        updateGameInState(gameId, { last_played: freshGame.last_played });
      } catch (_) { /* non-fatal */ }
      if (onSuccess) onSuccess(updated);
      refreshCollectionStats();
    } catch (err) {
      showToast(`Failed to update session: ${classifyError(err)}`, 'error');
    }
  }

  async function quickRepeatLastSession(game) {
    try {
      const sessions = await API.getSessions(game.id);
      if (!sessions || !sessions.length) {
        showToast('No previous sessions to repeat.', 'error');
        return;
      }
      const last = sessions.reduce((a, b) => a.played_at > b.played_at ? a : b);
      const today = new Date().toLocaleDateString('en-CA');
      const payload = {
        played_at: today,
        player_count: last.player_count,
        duration_minutes: last.duration_minutes,
        player_names: last.players || [],
        notes: '',
        winner: last.winner || '',
        session_rating: last.session_rating || null,
        solo: !!last.solo,
      };
      if (last.player_scores && Object.keys(last.player_scores).length) {
        payload.scores = last.player_scores;
      }
      await handleAddSession(game.id, payload, () => {
        renderCollection();
        refreshStatsBackground();
        refreshCollectionStats();
      });
      const playerList = payload.player_names.length
        ? ` with ${payload.player_names.join(', ')}`
        : ` (${payload.player_count || '?'}p, ${payload.duration_minutes || '?'}min)`;
      const prevLabel = last.played_at ? formatDate(last.played_at) : 'previous';
      showToast(`Last session repeated from ${prevLabel}${playerList}`, 'success');
    } catch (err) {
      showToast(`Failed to repeat session: ${classifyError(err)}`, 'error');
    }
  }

  async function handleDeleteSession(sessionId, gameId, onSuccess, sessionData = null) {
    const confirmed = await showConfirm('Delete Session', 'Remove this session?', { confirmLabel: 'Delete' });
    if (!confirmed) return;
    try {
      const capturedSession = sessionData || null;
      await API.deleteSession(sessionId);
      try {
        const updated = await API.getGame(gameId);
        updateGameInState(gameId, { last_played: updated.last_played });
      } catch (_) { /* non-fatal */ }
      if (onSuccess) onSuccess(sessionId);
      refreshCollectionStats();

      if (capturedSession) {
        const dateLabel = capturedSession.played_at ? formatDate(capturedSession.played_at) : 'session';
        showUndoToast(`Session on ${dateLabel} removed.`, async () => {
          try {
            const payload = {
              played_at: capturedSession.played_at,
              player_count: capturedSession.player_count,
              duration_minutes: capturedSession.duration_minutes,
              player_names: capturedSession.players || [],
              notes: capturedSession.notes || '',
              winner: capturedSession.winner || '',
              session_rating: capturedSession.session_rating || null,
              solo: !!capturedSession.solo,
            };
            if (capturedSession.player_scores) {
              payload.player_scores = capturedSession.player_scores;
            }
            await API.addSession(gameId, payload);
            showToast('Session restored.', 'success');
            if (onSuccess) onSuccess(null);
            refreshCollectionStats();
          } catch (err) {
            showToast(`Could not restore session: ${classifyError(err)}`, 'error');
          }
        });
      }
    } catch (err) {
      showToast(`Failed to delete session: ${classifyError(err)}`, 'error');
    }
  }

  async function handleUploadInstructions(gameId, file, onSuccess) {
    try {
      await API.uploadInstructions(gameId, file);
      showToast('Instructions uploaded!', 'success');
      updateGameInState(gameId, { instructions_filename: file.name });
      if (onSuccess) onSuccess(file.name);
    } catch (err) {
      showToast(`Upload failed: ${classifyError(err)}`, 'error');
    }
  }

  async function handleDeleteInstructions(gameId, onSuccess) {
    try {
      await API.deleteInstructions(gameId);
      showToast('Instructions removed.', 'success');
      updateGameInState(gameId, { instructions_filename: null });
      if (onSuccess) onSuccess();
    } catch (err) {
      showToast(`Failed to remove instructions: ${classifyError(err)}`, 'error');
    }
  }

  async function handleUploadImage(gameId, file, onSuccess) {
    try {
      await API.uploadImage(gameId, file);
      showToast('Image updated!', 'success');
      updateGameInState(gameId, { image_url: `/api/games/${gameId}/image`, image_cached: true });
      if (onSuccess) onSuccess();
    } catch (err) {
      showToast(`Image upload failed: ${classifyError(err)}`, 'error');
    }
  }

  async function handleDeleteImage(gameId, onSuccess) {
    try {
      await API.deleteImage(gameId);
      showToast('Image removed.', 'success');
      updateGameInState(gameId, { image_url: null, image_cached: false });
      if (onSuccess) onSuccess();
    } catch (err) {
      showToast(`Failed to remove image: ${classifyError(err)}`, 'error');
    }
  }

  // ===== Gallery (Multi-Image) =====

  async function handleUploadGalleryImage(gameId, file, onSuccess) {
    try {
      const newImg = await API.uploadGalleryImage(gameId, file);
      // If first gallery image, update local state image_url
      if (newImg.sort_order === 0) {
        updateGameInState(gameId, { image_url: `/api/games/${gameId}/images/${newImg.id}/file` });
      }
      if (onSuccess) onSuccess(newImg);
    } catch (err) {
      showToast(`Photo upload failed: ${classifyError(err)}`, 'error');
    }
  }

  async function handleDeleteGalleryImage(gameId, imgId, newPrimaryUrl, onSuccess) {
    const confirmed = await showConfirm('Delete Photo', 'Remove this photo? This cannot be undone.', { confirmLabel: 'Delete' });
    if (!confirmed) return;
    try {
      await API.deleteGalleryImage(gameId, imgId);
      updateGameInState(gameId, { image_url: newPrimaryUrl });
      if (onSuccess) onSuccess();
    } catch (err) {
      showToast(`Failed to remove photo: ${classifyError(err)}`, 'error');
    }
  }

  async function handleReorderGalleryImages(gameId, orderedIds, newPrimaryUrl, onSuccess) {
    try {
      await API.reorderGalleryImages(gameId, orderedIds);
      updateGameInState(gameId, { image_url: newPrimaryUrl });
      if (onSuccess) onSuccess();
    } catch (err) {
      showToast(`Failed to reorder photos: ${classifyError(err)}`, 'error');
    }
  }

  async function handleUpdateGalleryImageCaption(gameId, imgId, caption, onSuccess) {
    try {
      const updated = await API.updateGalleryImage(gameId, imgId, { caption });
      if (onSuccess) onSuccess(updated);
    } catch (err) {
      showToast(`Failed to save caption: ${classifyError(err)}`, 'error');
    }
  }

  async function handleAddGalleryImageFromUrl(gameId, url, onSuccess, onError) {
    try {
      const newImg = await API.addGalleryImageFromUrl(gameId, url);
      if (newImg.sort_order === 0) {
        updateGameInState(gameId, { image_url: `/api/games/${gameId}/images/${newImg.id}/file` });
      }
      showToast('Image added!', 'success');
      if (onSuccess) onSuccess(newImg);
    } catch (err) {
      showToast(`Failed to add image: ${classifyError(err)}`, 'error');
      if (onError) onError();
    }
  }

  // ===== Modal Backdrop =====
  function bindModalBackdrop() {
    document.getElementById('modal-backdrop').addEventListener('click', () => { activeModal = null; closeModal(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.getElementById('game-modal').classList.contains('open')) { activeModal = null; closeModal(); }
    });
  }

  // ===== Keyboard Shortcuts =====
  function bindKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.target.isContentEditable) return;
      if (e.target.closest('.base-game-dropdown')) return;
      if (e.target.closest('#game-modal')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === 'Escape' && state.bulkMode && !document.getElementById('game-modal').classList.contains('open')) {
        state.bulkMode = false;
        state.selectedGameIds.clear();
        _lastBulkClickedId = null;
        const bulkToggle = document.getElementById('bulk-select-toggle');
        if (bulkToggle) { bulkToggle.classList.remove('active'); bulkToggle.setAttribute('aria-pressed', false); bulkToggle.setAttribute('data-tooltip', 'Select games for bulk actions'); }
        renderCollection();
        renderBulkToolbar();
        return;
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (!activeModal || activeModal.mode !== 'view') return;
        e.preventDefault();
        const navIdx = _findGameNavIndex(activeModal.game.id);
        if (e.key === 'ArrowLeft' && navIdx > 0) {
          openGameModal(state.games[navIdx - 1], 'view');
        } else if (e.key === 'ArrowRight' && navIdx >= 0 && navIdx < state.games.length - 1) {
          openGameModal(state.games[navIdx + 1], 'view');
        }
      } else if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        document.querySelector('[data-view="add"]')?.click();
      } else if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        if (!document.getElementById('view-collection')?.classList.contains('active')) {
          switchView('collection');
        }
        document.getElementById('collection-search')?.focus();
      } else if (e.key === 'e' || e.key === 'E') {
        if (activeModal && activeModal.mode === 'view') {
          e.preventDefault();
          openGameModal(activeModal.game, 'edit');
        } else if (!activeModal && hoveredGame) {
          e.preventDefault();
          openGameModal(hoveredGame, 'edit');
        }
      } else if (e.key === '/') {
        e.preventDefault();
        const searchEl = document.getElementById('collection-search');
        if (searchEl) searchEl.focus();
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        if (currentCollectionDisplayPrefs.show_recommend_card !== false) loadRecommendCard();
      }
    });
  }

  // ===== Player Profile Chart Helpers =====

  // Renders a player profile bar chart. Each month in `months` must have
  // pre-computed `px` (bar height in pixels) and `tip` (tooltip string).
  function _buildPlayerBarChart(title, months) {
    return `<div class="player-profile-section-title">${title}</div>
      <div class="player-sessions-chart">
        ${months.map(m => `<div class="player-sessions-col" title="${escapeHtml(m.tip)}">
          <div class="player-sessions-bar" style="height:${m.px}px"></div>
          <div class="player-sessions-label">${m.label.charAt(0)}</div>
        </div>`).join('')}
      </div>`;
  }

  // ===== Players Modal =====
  function bindPlayersModal() {
    const btn = document.getElementById('players-btn');
    if (!btn) return;
    btn.addEventListener('click', openPlayersModal);
  }


  async function openPlayersModal() {
    const modal    = document.getElementById('players-modal');
    const inner    = document.getElementById('players-modal-inner');
    const backdrop = document.getElementById('players-modal-backdrop');
    const prevFocus = document.activeElement;

    inner.innerHTML = '<div class="loading-spinner" style="padding:40px 20px;"><div class="spinner"></div><p>Loading players…</p></div>';
    modal.style.display = 'flex';
    pushModalOpen();

    let trapHandler = null;
    requestAnimationFrame(() => {
      modal.classList.add('open');
      const focusables = () => [...modal.querySelectorAll(FOCUSABLE)].filter(el => el.offsetParent !== null);
      const first = focusables()[0];
      if (first) first.focus();
      trapHandler = (e) => {
        if (e.key !== 'Tab') return;
        const els = focusables();
        if (!els.length) return;
        if (e.shiftKey && document.activeElement === els[0]) { e.preventDefault(); els[els.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === els[els.length - 1]) { e.preventDefault(); els[0].focus(); }
      };
      modal.addEventListener('keydown', trapHandler);
    });

    function close() {
      modal.classList.remove('open');
      if (trapHandler) { modal.removeEventListener('keydown', trapHandler); trapHandler = null; }
      if (prevFocus) prevFocus.focus();
      setTimeout(() => { modal.style.display = 'none'; inner.innerHTML = ''; popModalOpen(); }, 200);
      backdrop.removeEventListener('click', close);
      document.removeEventListener('keydown', onKeyDown);
    }
    function onKeyDown(e) { if (e.key === 'Escape') close(); }
    backdrop.addEventListener('click', close);
    document.addEventListener('keydown', onKeyDown);

    function buildPlayerRow(p) {
      const sessionLabel = p.session_count === 1 ? '1 session' : `${p.session_count} sessions`;
      const winLabel = p.win_count > 0
        ? `<span class="player-wins"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" fill="currentColor"/></svg>${p.win_count}</span>`
        : '';
      return `
        <div class="player-row" data-player-id="${p.id}" data-player-name="${escapeHtml(p.name)}">
          ${renderPlayerAvatar(p, 'player-avatar')}
          <span class="player-name">${escapeHtml(p.name)}</span>
          <span class="player-count">${sessionLabel}${winLabel}</span>
          <div class="player-actions">
            <button class="player-action-btn player-rename-btn" title="Rename player">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="player-action-btn danger player-delete-btn" title="Delete player">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>
            </button>
          </div>
        </div>`;
    }

    let playerSortKey = 'name';
    let playerSearch  = '';

    async function renderPlayers() {
      const allPlayers = await API.getPlayers().catch(err => {
        console.error('Failed to load players:', err);
        showToast(`Failed to load players: ${classifyError(err)}`, 'error');
        return [];
      });

      function getSortedFiltered() {
        let list = allPlayers.filter(p => p.name.toLowerCase().includes(playerSearch.toLowerCase()));
        if (playerSortKey === 'sessions') list = list.slice().sort((a, b) => b.session_count - a.session_count);
        else if (playerSortKey === 'wins')    list = list.slice().sort((a, b) => (b.win_count||0) - (a.win_count||0));
        else                                  list = list.slice().sort((a, b) => a.name.localeCompare(b.name));
        return list;
      }

      const playersEmptyHtml = `
        <div class="players-empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="40" height="40"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          <p>No players yet.</p>
          <p class="players-empty-sub">Add someone above to start tracking who plays.</p>
        </div>`;

      function renderList() {
        const listEl = inner.querySelector('#players-list');
        if (!listEl) return;
        const filtered = getSortedFiltered();
        if (!filtered.length && allPlayers.length === 0) {
          listEl.innerHTML = playersEmptyHtml;
        } else if (!filtered.length) {
          listEl.innerHTML = `<div class="secondary-empty">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
            <span class="secondary-empty-text">No players match <strong>"${escapeHtml(playerSearch)}"</strong></span>
          </div>`;
        } else {
          listEl.innerHTML = filtered.map(p => buildPlayerRow(p)).join('');
        }
      }

      inner.innerHTML = `
        <div class="modal-content-panel">
          <div class="modal-panel-header">
            <h2 id="players-modal-title">Players</h2>
            <button class="modal-close" id="players-modal-close" aria-label="Close">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="18" height="18"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <div class="players-add-row">
            <input type="text" id="new-player-name" class="form-input" placeholder="Player name" autocomplete="off" maxlength="255">
            <button class="btn btn-primary" id="add-player-btn">Add</button>
          </div>
          ${allPlayers.length > 1 ? `
          <div class="players-controls">
            <input type="search" id="players-search" class="form-input players-search-input" placeholder="Search players…" value="${escapeHtml(playerSearch)}" autocomplete="off">
            <div class="players-sort-bar">
              <span class="players-sort-label">Sort:</span>
              <button class="players-sort-btn${playerSortKey==='name'?' active':''}" data-sort="name" aria-pressed="${playerSortKey==='name'}">Name</button>
              <button class="players-sort-btn${playerSortKey==='sessions'?' active':''}" data-sort="sessions" aria-pressed="${playerSortKey==='sessions'}">Sessions</button>
              <button class="players-sort-btn${playerSortKey==='wins'?' active':''}" data-sort="wins" aria-pressed="${playerSortKey==='wins'}">Wins</button>
            </div>
          </div>` : ''}
          <div class="players-list" id="players-list"></div>
          <div class="modal-close-bar">
            <button class="btn btn-ghost btn-sm modal-close-sticky-btn" id="players-modal-close-sticky" aria-label="Close">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              Close
            </button>
          </div>
        </div>`;

      inner.querySelector('#players-modal-close').addEventListener('click', (e) => { e.stopPropagation(); close(); });
      const playersStickyClose = inner.querySelector('#players-modal-close-sticky');
      if (playersStickyClose) playersStickyClose.addEventListener('click', (e) => { e.stopPropagation(); close(); });

      const addInput = inner.querySelector('#new-player-name');
      const addBtn   = inner.querySelector('#add-player-btn');

      addBtn.addEventListener('click', async () => {
        const name = addInput.value.trim();
        if (!name) return;
        try {
          await withLoading(addBtn, async () => {
            const player = await API.createPlayer(name);
            state.players = [...new Set([...state.players, player.name])].sort();
            if (!(state.playerObjects || []).some(p => p.id === player.id)) {
              state.playerObjects = [...(state.playerObjects || []), player].sort((a, b) => a.name.localeCompare(b.name));
            }
            addInput.value = '';
            playerSearch = '';
            await renderPlayers();
            inner.querySelector('#new-player-name').focus();
          }, 'Adding…');
        } catch (err) {
          showToast(`Failed to add player: ${classifyError(err)}`, 'error');
        }
      });

      addInput.addEventListener('keydown', e => { if (e.key === 'Enter') addBtn.click(); });

      const searchInput = inner.querySelector('#players-search');
      if (searchInput) {
        searchInput.addEventListener('input', () => {
          playerSearch = searchInput.value;
          renderList();
        });
      }

      inner.addEventListener('click', e => {
        const btn = e.target.closest('.players-sort-btn');
        if (!btn) return;
        playerSortKey = btn.dataset.sort;
        inner.querySelectorAll('.players-sort-btn').forEach(b => {
          const active = b.dataset.sort === playerSortKey;
          b.classList.toggle('active', active);
          b.setAttribute('aria-pressed', String(active));
        });
        renderList();
      });

      renderList();
      bindListEvents(allPlayers, playersEmptyHtml);
    }

    function bindListEvents(allPlayers, playersEmptyHtml) {
      const listEl = inner.querySelector('#players-list');
      if (!listEl) return;

      listEl.addEventListener('click', async e => {
        const row = e.target.closest('.player-row');
        if (!row) return;
        const playerId = parseInt(row.dataset.playerId, 10);

        // Rename
        if (e.target.closest('.player-rename-btn')) {
          if (row.querySelector('.player-edit-input')) return;
          const nameSpan    = row.querySelector('.player-name');
          const countSpan   = row.querySelector('.player-count');
          const actionsDiv  = row.querySelector('.player-actions');
          const currentName = row.dataset.playerName;

          nameSpan.style.display = 'none';
          if (countSpan) countSpan.style.display = 'none';
          actionsDiv.style.display = 'none';

          const editInput = document.createElement('input');
          editInput.type = 'text';
          editInput.className = 'player-edit-input';
          editInput.value = currentName;
          editInput.maxLength = 255;

          const saveBtn   = document.createElement('button');
          saveBtn.className = 'btn btn-primary btn-sm';
          saveBtn.textContent = 'Save';

          const cancelBtn = document.createElement('button');
          cancelBtn.className = 'btn btn-ghost btn-sm';
          cancelBtn.textContent = 'Cancel';

          const editActions = document.createElement('div');
          editActions.className = 'player-actions';
          editActions.append(saveBtn, cancelBtn);

          row.append(editInput, editActions);
          editInput.focus();
          editInput.select();

          cancelBtn.addEventListener('click', () => {
            editInput.remove();
            editActions.remove();
            nameSpan.style.display = '';
            if (countSpan) countSpan.style.display = '';
            actionsDiv.style.display = '';
          });

          async function doRename() {
            const newName = editInput.value.trim();
            if (!newName || newName === currentName) {
              cancelBtn.click();
              return;
            }
            try {
              await withLoading(saveBtn, async () => {
                const updated = await API.renamePlayer(playerId, newName);
                state.players = state.players.map(n => n === currentName ? updated.name : n);
                state.players = [...new Set(state.players)].sort();
                const pObj = (state.playerObjects || []).find(p => p.id === playerId);
                if (pObj) pObj.name = updated.name;
                await renderPlayers();
              }, 'Saving…');
            } catch (err) {
              showToast(classifyError(err), 'error');
            }
          }

          saveBtn.addEventListener('click', doRename);
          editInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') doRename();
            if (e.key === 'Escape') cancelBtn.click();
          });
          return;
        }

        // Delete
        if (e.target.closest('.player-delete-btn')) {
          if (row.querySelector('.player-confirm-row')) return;
          const playerName = row.dataset.playerName;

          const confirmRow = document.createElement('div');
          confirmRow.className = 'player-confirm-row';
          confirmRow.innerHTML = `
            <span>Delete <strong>${escapeHtml(playerName)}</strong>?</span>
            <button class="btn btn-danger btn-sm confirm-yes">Delete</button>
            <button class="btn btn-ghost btn-sm confirm-no">Cancel</button>`;

          row.style.display = 'none';
          row.insertAdjacentElement('afterend', confirmRow);

          confirmRow.querySelector('.confirm-no').addEventListener('click', () => {
            confirmRow.remove();
            row.style.display = '';
          });

          const confirmYesBtn = confirmRow.querySelector('.confirm-yes');
          confirmRow.querySelector('.confirm-yes').addEventListener('click', async () => {
            const capturedPlayerObj = allPlayers.find(p => p.id === playerId);
            try {
              await withLoading(confirmYesBtn, async () => {
                await API.deletePlayer(playerId);
                state.players = state.players.filter(n => n !== playerName);
                state.playerObjects = (state.playerObjects || []).filter(p => p.id !== playerId);
                confirmRow.remove();
                row.remove();
                if (!listEl.querySelector('.player-row')) {
                  listEl.innerHTML = playersEmptyHtml;
                }
              }, 'Deleting…');
              if (capturedPlayerObj) {
                showUndoToast(`Player "${playerName}" removed.`, async () => {
                  try {
                    const created = await API.createPlayer(playerName);
                    state.players.push(created.name);
                    state.playerObjects = state.playerObjects || [];
                    state.playerObjects.push(created);
                    showToast(`"${playerName}" restored.`, 'success');
                    openPlayersModal();
                  } catch (e) {
                    showToast(`Could not restore player: ${classifyError(e)}`, 'error');
                  }
                });
              }
            } catch (err) {
              showToast(`Failed to delete player: ${classifyError(err)}`, 'error');
              confirmRow.remove();
              row.style.display = '';
            }
          });
          return;
        }

        // Profile click (not on action buttons)
        if (!e.target.closest('.player-actions')) {
          const playerObj = allPlayers.find(p => p.id === playerId);
          if (playerObj) openPlayerProfile(playerObj);
        }
      });
    }

    const _AVATAR_PRESETS = [
      { id: 'meeple', label: 'Meeple' },
      { id: 'dice',   label: 'Dice'   },
      { id: 'robot',  label: 'Robot'  },
      { id: 'crown',  label: 'Crown'  },
      { id: 'cat',    label: 'Cat'    },
      { id: 'fox',    label: 'Fox'    },
      { id: 'bear',   label: 'Bear'   },
      { id: 'knight', label: 'Knight' },
    ];

    function _buildProfileAvatarWrap(player) {
      const hasAvatar = !!(player.avatar_url || player.avatar_preset);
      return `<div class="player-avatar-wrap player-profile-avatar-wrap">
        ${renderPlayerAvatar(player, 'player-profile-avatar')}
        <div class="avatar-controls-overlay">
          <label class="avatar-ctrl-btn" title="Upload photo">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
            <input type="file" class="avatar-file-input" accept=".jpg,.jpeg,.png,.webp,.gif" hidden>
          </label>
          <button class="avatar-ctrl-btn avatar-preset-trigger" title="Choose avatar" type="button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>
          </button>
        </div>
        ${hasAvatar ? '<button class="avatar-delete-btn" title="Remove avatar" type="button">×</button>' : ''}
      </div>`;
    }

    function _openAvatarPicker(panel, player) {
      _closeAvatarPicker(panel);
      const wrap = panel.querySelector('.player-profile-avatar-wrap');
      if (!wrap) return;
      const rect = wrap.getBoundingClientRect();

      const picker = document.createElement('div');
      picker.className = 'avatar-preset-popover';
      _AVATAR_PRESETS.forEach(p => {
        const img = document.createElement('img');
        img.src = `/avatars/${p.id}.svg`;
        img.className = 'avatar-preset-item' + (player.avatar_preset === p.id ? ' active' : '');
        img.title = p.label;
        img.alt = p.label;
        img.loading = 'lazy';
        img.tabIndex = 0;
        img.role = 'button';
        img.setAttribute('aria-label', `Set avatar to ${p.label}`);
        const apply = () => _applyAvatarPreset(panel, player, p.id);
        img.addEventListener('click', apply);
        img.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); apply(); }
        });
        picker.appendChild(img);
      });
      picker.style.cssText = `position:fixed;top:${rect.bottom + 8}px;left:${rect.left + rect.width / 2}px;transform:translateX(-50%);`;
      picker.setAttribute('role', 'listbox');
      picker.setAttribute('aria-label', 'Choose avatar preset');
      document.body.appendChild(picker);
      panel._avatarPicker = picker;
      panel._avatarTrigger = panel.querySelector('.avatar-preset-trigger');

      const onOutside = e => {
        if (!picker.contains(e.target) && !e.target.closest('.avatar-preset-trigger')) {
          _closeAvatarPicker(panel);
          document.removeEventListener('click', onOutside, true);
        }
      };
      const onEscape = e => {
        if (e.key === 'Escape') { _closeAvatarPicker(panel); document.removeEventListener('keydown', onEscape, true); }
      };
      setTimeout(() => {
        document.addEventListener('click', onOutside, true);
        document.addEventListener('keydown', onEscape, true);
        const first = picker.querySelector('.avatar-preset-item');
        if (first) first.focus();
      }, 0);
      picker._onOutside = onOutside;
      picker._onEscape = onEscape;
    }

    function _closeAvatarPicker(panel) {
      if (panel._avatarPicker) {
        if (panel._avatarPicker._onOutside) {
          document.removeEventListener('click', panel._avatarPicker._onOutside, true);
        }
        if (panel._avatarPicker._onEscape) {
          document.removeEventListener('keydown', panel._avatarPicker._onEscape, true);
        }
        panel._avatarPicker.remove();
        panel._avatarPicker = null;
        if (panel._avatarTrigger) {
          panel._avatarTrigger.focus();
          panel._avatarTrigger = null;
        }
      }
    }

    async function _applyAvatarPreset(panel, player, presetId) {
      _closeAvatarPicker(panel);
      try {
        const updated = await API.setPlayerAvatarPreset(player.id, presetId);
        _syncPlayerAvatar(panel, player, updated);
        showToast('Avatar updated', 'success');
      } catch (err) {
        showToast(`Failed to set avatar: ${classifyError(err)}`, 'error');
      }
    }

    function _syncPlayerAvatar(panel, player, updated) {
      player.avatar_url    = updated.avatar_url;
      player.avatar_preset = updated.avatar_preset;
      const wrap = panel.querySelector('.player-profile-avatar-wrap');
      if (wrap) { wrap.insertAdjacentHTML('afterend', _buildProfileAvatarWrap(player)); wrap.remove(); }
      const pObj = (state.playerObjects || []).find(p => p.id === player.id);
      if (pObj) { pObj.avatar_url = updated.avatar_url; pObj.avatar_preset = updated.avatar_preset; }
    }

    function openPlayerProfile(player) {
      const panel = document.createElement('div');
      panel.className = 'player-profile-panel';
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'true');
      panel.setAttribute('aria-label', `${player.name} profile`);
      panel.innerHTML = `
        <div class="player-profile-header">
          <button class="player-profile-back btn btn-ghost btn-sm">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14"><polyline points="15 18 9 12 15 6"/></svg>
            Back
          </button>
          ${_buildProfileAvatarWrap(player)}
          <h3 class="player-profile-name">${escapeHtml(player.name)}</h3>
        </div>
        <div class="player-profile-body">
          <div class="player-profile-loading"><div class="spinner" style="margin:0 auto 10px;"></div>Loading stats…</div>
        </div>`;

      inner.querySelector('.modal-content-panel').appendChild(panel);
      requestAnimationFrame(() => {
        panel.classList.add('open');
        panel.querySelector('.player-profile-back')?.focus();
      });

      // Hide underlying list from AT and mark inert so the parent modal trap skips it
      const panelSiblings = [...panel.parentElement.children].filter(el => el !== panel);
      panelSiblings.forEach(el => { el.setAttribute('aria-hidden', 'true'); if ('inert' in el) el.inert = true; });

      const profileTrap = (e) => {
        if (e.key !== 'Tab') return;
        const els = [...panel.querySelectorAll(FOCUSABLE)].filter(el => el.offsetParent !== null);
        if (!els.length) return;
        if (e.shiftKey && document.activeElement === els[0]) { e.preventDefault(); els[els.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === els[els.length - 1]) { e.preventDefault(); els[0].focus(); }
      };
      panel.addEventListener('keydown', profileTrap);

      const closePanel = () => {
        _closeAvatarPicker(panel);
        panel.classList.remove('open');
        panelSiblings.forEach(el => { el.removeAttribute('aria-hidden'); if ('inert' in el) el.inert = false; });
        panel.removeEventListener('keydown', profileTrap);
        setTimeout(() => panel.remove(), 220);
      };

      panel.querySelector('.player-profile-back').addEventListener('click', closePanel);

      // Avatar upload via delegated events so they survive wrap re-renders
      panel.addEventListener('change', async e => {
        const input = e.target.closest('.avatar-file-input');
        if (!input) return;
        const file = input.files[0];
        if (!file) return;
        try {
          const updated = await API.uploadPlayerAvatar(player.id, file);
          _syncPlayerAvatar(panel, player, updated);
          showToast('Photo updated', 'success');
        } catch (err) {
          showToast(`Failed to upload: ${classifyError(err)}`, 'error');
        }
        input.value = '';
      });

      panel.addEventListener('click', async e => {
        if (e.target.closest('.avatar-preset-trigger')) {
          panel._avatarPicker ? _closeAvatarPicker(panel) : _openAvatarPicker(panel, player);
          return;
        }
        if (e.target.closest('.avatar-delete-btn')) {
          _closeAvatarPicker(panel);
          try {
            await API.deletePlayerAvatar(player.id);
            _syncPlayerAvatar(panel, player, { avatar_url: null, avatar_preset: null });
            showToast('Avatar removed', 'success');
          } catch (err) {
            showToast(`Failed to remove: ${classifyError(err)}`, 'error');
          }
          return;
        }
      });

      API.getPlayerStats(player.id).then(stats => {
        const winRate = stats.session_count > 0
          ? Math.round((stats.win_count / stats.session_count) * 100)
          : 0;
        const lastPlayed = stats.last_played
          ? new Date(stats.last_played).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
          : '—';

        const topGamesHtml = stats.top_games.length
          ? `<div class="player-profile-section-title">Top Games</div>
             <div class="player-profile-top-games">
               ${stats.top_games.map(g => `
                 <div class="player-top-game-row">
                   <span class="player-top-game-name">${escapeHtml(g.game_name)}</span>
                   <span class="player-top-game-count">${pluralize(g.play_count, 'play')}</span>
                 </div>`).join('')}
             </div>`
          : '';

        const barAreaPx = 44;

        let sessionsByMonthHtml = '';
        if (stats.sessions_by_month && stats.sessions_by_month.length > 0) {
          const months = stats.sessions_by_month.map(m => ({
            key: m.month,
            label: new Date(m.month + '-01T12:00:00').toLocaleDateString(undefined, { month: 'short' }),
            count: m.count,
          }));
          const maxCount = Math.max(...months.map(m => m.count), 1);
          months.forEach(m => {
            m.px  = m.count > 0 ? Math.max(3, Math.round(m.count / maxCount * barAreaPx)) : 0;
            m.tip = `${m.label}: ${m.count}`;
          });
          sessionsByMonthHtml = _buildPlayerBarChart('Sessions (12 months)', months);
        }

        const recentForm = stats.recent_form || [];
        const recentFormHtml = recentForm.length ? `
          <div class="player-profile-section-title">Recent Form</div>
          <div class="player-recent-form">
            ${recentForm.map(r => `<span class="form-pip form-pip-${r === 'W' ? 'win' : 'loss'}" title="${r === 'W' ? 'Win' : 'Loss'}">${r}</span>`).join('')}
          </div>` : '';

        const streak = stats.current_streak || { kind: '', length: 0 };
        const streakLabel = streak.kind === 'W' ? 'win' : 'loss';
        const streakHtml = streak.length > 1 ? `
          <div class="player-streak-line player-streak-${streakLabel}">
            ${streak.length} ${streakLabel} streak
          </div>` : '';

        let winRateTrendHtml = '';
        if (stats.win_rate_by_month && stats.win_rate_by_month.length > 0) {
          const months = stats.win_rate_by_month.map(m => {
            const label = new Date(m.month + '-01T12:00:00').toLocaleDateString(undefined, { month: 'short' });
            const hasData = m.sessions > 0;
            return {
              key: m.month,
              label,
              px:  hasData ? Math.max(3, Math.round(m.win_rate / 100 * barAreaPx)) : 0,
              tip: hasData
                ? `${label}: ${m.win_rate}% over ${pluralize(m.sessions, 'session')}`
                : `${label}: no decided sessions`,
            };
          });
          winRateTrendHtml = _buildPlayerBarChart('Win Rate (12 months)', months);
        }

        // Co-players: show all, top 3 visible, rest collapsible
        const coPlayersAll = stats.most_played_with;
        const coPlayersVisible = coPlayersAll.slice(0, 3);
        const coPlayersExtra = coPlayersAll.slice(3);
        function buildCoPlayerRow(co) {
          const w = co.wins_against, l = co.losses_to;
          const rivalryHtml = (w + l > 0) ? `<span class="rivalry-record">${w}W–${l}L</span>` : '';
          return `<div class="player-coplayer-row">
            ${renderPlayerAvatar({ name: co.player_name, avatar_url: co.avatar_url }, 'player-avatar player-avatar-sm')}
            <span>${escapeHtml(co.player_name)}</span>
            ${rivalryHtml}
            <span class="player-top-game-count">${pluralize(co.count, 'time')}</span>
          </div>`;
        }
        const mostWithHtml = coPlayersAll.length
          ? `<div class="player-profile-section-title">Most Played With</div>
             <div class="player-profile-coplayers">
               ${coPlayersVisible.map(buildCoPlayerRow).join('')}
               ${coPlayersExtra.length ? `
                 <div class="player-coplayers-extra" style="display:none">
                   ${coPlayersExtra.map(buildCoPlayerRow).join('')}
                 </div>
                 <button class="btn btn-ghost btn-sm player-coplayers-toggle" data-count="${coPlayersExtra.length}">+${coPlayersExtra.length} more</button>` : ''}
             </div>`
          : '';

        panel.querySelector('.player-profile-body').innerHTML = `
          <div class="player-profile-stats">
            <div class="player-profile-stat">
              <span class="player-profile-stat-val">${stats.session_count}</span>
              <span class="player-profile-stat-label">Sessions</span>
            </div>
            <div class="player-profile-stat">
              <span class="player-profile-stat-val">${stats.win_count}</span>
              <span class="player-profile-stat-label">Wins</span>
            </div>
            <div class="player-profile-stat">
              <span class="player-profile-stat-val">${winRate}%</span>
              <span class="player-profile-stat-label">Win Rate</span>
            </div>
            <div class="player-profile-stat">
              <span class="player-profile-stat-val">${lastPlayed}</span>
              <span class="player-profile-stat-label">Last Played</span>
            </div>
          </div>
          ${streakHtml}
          ${recentFormHtml}
          ${sessionsByMonthHtml}
          ${winRateTrendHtml}
          ${topGamesHtml}
          ${mostWithHtml}`;

        // Bind the "show more co-players" toggle
        const toggleBtn = panel.querySelector('.player-coplayers-toggle');
        if (toggleBtn) {
          toggleBtn.addEventListener('click', () => {
            const extra = panel.querySelector('.player-coplayers-extra');
            const isOpen = extra.style.display !== 'none';
            extra.style.display = isOpen ? 'none' : '';
            toggleBtn.textContent = isOpen ? `+${coPlayersExtra.length} more` : 'Show less';
          });
        }
      }).catch(() => {
        panel.querySelector('.player-profile-body').innerHTML = '<p class="empty-state-note">Failed to load stats.</p>';
      });
    }

    await renderPlayers();
  }

  // ===== Shortcuts Modal =====
  function bindShortcutsOverlay() {
    const btn = document.getElementById('shortcuts-btn');
    if (!btn) return;

    const SHORTCUTS = [
      { key: 'N',   desc: 'Add a new game' },
      { key: 'S',   desc: 'Focus the search bar' },
      { key: 'E',   desc: 'Edit hovered or open game' },
      { key: 'R',   desc: 'Refresh "Play This Next" recommendation' },
      { key: '/',   desc: 'Focus the search bar (anywhere)' },
      { key: '← / →', desc: 'Navigate between games in modal' },
      { key: 'Esc', desc: 'Close modal or overlay' },
    ];

    btn.addEventListener('click', () => {
      const el = document.createElement('div');
      el.className = 'modal-content-panel';
      el.innerHTML = `
        <div class="modal-panel-header">
          <h2 id="modal-title">Keyboard Shortcuts</h2>
          <button class="modal-close" id="shortcuts-modal-close" aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="18" height="18"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <ul class="shortcuts-list">
          ${SHORTCUTS.map(s => `
            <li class="shortcuts-row">
              <kbd class="kbd">${escapeHtml(s.key)}</kbd>
              <span class="shortcuts-desc">${escapeHtml(s.desc)}</span>
            </li>`).join('')}
        </ul>`;

      el.querySelector('#shortcuts-modal-close').addEventListener('click', (e) => { e.stopPropagation(); closeModal(); });
      openModal(el);
    });
  }

  // ===== BGG Search (Add Game) =====
  function bindBggSearch() {
    const input   = document.getElementById('bgg-search-input');
    const results = document.getElementById('bgg-search-results');
    if (!input || !results) return;

    let _debounce = null;
    input.addEventListener('input', () => {
      clearTimeout(_debounce);
      const q = input.value.trim();
      if (q.length < 2) { results.style.display = 'none'; return; }
      _debounce = setTimeout(async () => {
        results.innerHTML = '<div class="bgg-search-loading">Searching…</div>';
        results.style.display = '';
        try {
          const items = await API.bggSearch(q);
          if (!items.length) { results.innerHTML = `<div class="secondary-empty" style="padding:16px"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg><span class="secondary-empty-text">No results on BoardGameGeek</span></div>`; return; }
          results.innerHTML = items.map(item => `
            <div class="bgg-search-result" data-bgg-id="${item.bgg_id}">
              <button type="button" class="bgg-result-main">
                ${item.thumbnail ? `<span class="bgg-result-thumb"><img src="${escapeHtml(item.thumbnail)}" alt="" loading="lazy" width="40" height="40"></span>` : '<span class="bgg-result-thumb bgg-result-thumb-empty"></span>'}
                <span class="bgg-result-name">${escapeHtml(item.name)}</span>
                ${item.year_published ? `<span class="bgg-result-year">${item.year_published}</span>` : ''}
              </button>
              <button type="button" class="bgg-result-instant" title="Instant add">+</button>
            </div>`).join('');
          results.querySelectorAll('.bgg-search-result').forEach(row => {
            const bggId = parseInt(row.dataset.bggId, 10);
            // Main button: pre-fill form
            row.querySelector('.bgg-result-main').addEventListener('click', async () => {
              results.style.display = 'none';
              input.value = '';
              showToast('Fetching from BGG…', 'info', 2000);
              try {
                const data = await API.bggFetch(bggId);
                _prefillAddGameForm(data);
                showToast(`Filled in: ${escapeHtml(data.name)}`, 'success');
              } catch (err) {
                showToast('BGG fetch failed: ' + classifyError(err), 'error');
              }
            });
            // Instant add: create immediately
            row.querySelector('.bgg-result-instant').addEventListener('click', async () => {
              results.style.display = 'none';
              input.value = '';
              showToast('Creating game from BGG…', 'info', 2000);
              try {
                const data = await API.bggFetch(bggId);
                const payload = {
                  name: data.name,
                  status: 'owned',
                  year_published: data.year_published || null,
                  min_players: data.min_players || null,
                  max_players: data.max_players || null,
                  min_playtime: data.min_playtime || null,
                  max_playtime: data.max_playtime || null,
                  difficulty: data.difficulty || null,
                  bgg_id: data.bgg_id || null,
                  bgg_rating: data.bgg_rating || null,
                  image_url: data.image_url || null,
                  description: data.description || null,
                  categories: data.categories?.length ? JSON.stringify(data.categories) : null,
                  mechanics: data.mechanics?.length ? JSON.stringify(data.mechanics) : null,
                  designers: data.designers?.length ? JSON.stringify(data.designers) : null,
                  publishers: data.publishers?.length ? JSON.stringify(data.publishers) : null,
                };
                const resp = await API.createGame(payload);
                invalidateCollectionEtag();
                await loadCollection();
                showToast(`Added: ${escapeHtml(data.name)}`, 'success');
                // Switch to collection view
                switchView('collection');
              } catch (err) {
                showToast('Instant add failed: ' + classifyError(err), 'error');
              }
            });
          });
        } catch (err) {
          results.innerHTML = `<div class="bgg-search-empty">Error: ${escapeHtml(classifyError(err))}</div>`;
        }
      }, 400);
    });

    document.addEventListener('click', e => {
      if (!e.target.closest('#bgg-search-bar')) results.style.display = 'none';
    });
    bggInput.addEventListener('keydown', e => {
      if (e.key === 'Escape') results.style.display = 'none';
    });
  }

  function _prefillAddGameForm(data) {
    const f = id => document.getElementById(id);
    if (data.name)          f('m-name').value = data.name;
    if (data.year_published) f('m-year').value = data.year_published;
    if (data.min_players)   f('m-min-players').value = data.min_players;
    if (data.max_players)   f('m-max-players').value = data.max_players;
    if (data.min_playtime)  f('m-min-playtime').value = data.min_playtime;
    if (data.max_playtime)  f('m-max-playtime').value = data.max_playtime;
    if (data.difficulty) {
      const diffVal = Math.round(parseFloat(data.difficulty));
      const diffBtn = document.querySelector(`#m-difficulty .segment[data-value="${diffVal}"]`);
      if (diffBtn) {
        document.querySelectorAll('#m-difficulty .segment').forEach(b => b.classList.remove('active'));
        diffBtn.classList.add('active');
        document.getElementById('m-difficulty-value').value = diffVal;
      }
    }
    if (data.description)   f('m-description').value = data.description;
    if (data.image_url)     { f('m-image-url').value = data.image_url; f('m-image-url').dispatchEvent(new Event('input')); }
    // Chip inputs
    if (data.labels)        _renderChipInput('m-labels', JSON.parse(data.labels || '[]'), 'Favourite, Solo, Kid-friendly', 'dl-labels');
    if (data.categories)    _renderChipInput('m-categories', JSON.parse(data.categories || '[]'), 'Strategy, Card Game', 'dl-categories');
    if (data.mechanics)     _renderChipInput('m-mechanics', JSON.parse(data.mechanics || '[]'), 'Hand Management, Set Collection', 'dl-mechanics');
    if (data.designers)     _renderChipInput('m-designers', JSON.parse(data.designers || '[]'), 'Alan Moon', 'dl-designers');
    if (data.publishers)    _renderChipInput('m-publishers', JSON.parse(data.publishers || '[]'), 'Days of Wonder', 'dl-publishers');
    if (data.bgg_id)        { const bggEl = f('m-bgg-id'); if (bggEl) bggEl.value = data.bgg_id; }
  }

  // ===== Add Game =====
  function bindAddGame() {
    const form      = document.getElementById('manual-form');
    const fileInput = document.getElementById('add-image-file');
    const urlInput  = document.getElementById('m-image-url');
    const preview   = document.getElementById('add-image-preview');
    const removeBtn = document.getElementById('add-image-remove');

    function setPreview(src) {
      const safe = src && (isSafeUrl(src) || src.startsWith('blob:'));
      if (safe) {
        preview.innerHTML = `<img src="${escapeHtml(src)}" alt="Preview">`;
        removeBtn.style.display = '';
      } else {
        preview.innerHTML = '<span class="image-edit-empty">No image</span>';
        removeBtn.style.display = 'none';
      }
    }

    fileInput.addEventListener('change', () => {
      if (!fileInput.files[0]) return;
      urlInput.value = '';
      if (_addGamePreviewBlobUrl) { URL.revokeObjectURL(_addGamePreviewBlobUrl); _addGamePreviewBlobUrl = null; }
      _addGamePreviewBlobUrl = URL.createObjectURL(fileInput.files[0]);
      setPreview(_addGamePreviewBlobUrl);
    });

    urlInput.addEventListener('input', () => {
      const url = urlInput.value.trim();
      if (url) {
        fileInput.value = '';
        setPreview(url);
      } else {
        setPreview(null);
      }
    });

    removeBtn.addEventListener('click', () => {
      fileInput.value = '';
      urlInput.value  = '';
      if (_addGamePreviewBlobUrl) { URL.revokeObjectURL(_addGamePreviewBlobUrl); _addGamePreviewBlobUrl = null; }
      setPreview(null);
    });

    // ---- Wishlist conditional fields ----
    const statusEl = document.getElementById('m-status');
    const wishlistFields = document.getElementById('m-wishlist-fields');
    function syncWishlistFields() {
      wishlistFields.style.display = statusEl.value === 'wishlist' ? 'contents' : 'none';
    }
    statusEl.addEventListener('change', syncWishlistFields);
    syncWishlistFields();

    // ---- Inline validation ----
    function f(id) { return form.querySelector(`#${id}`); }
    function e(id) { return form.querySelector(`#err-${id}`); }

    function validateAddForm() {
      let valid = true;

      const nameEl = f('m-name');
      if (!nameEl.value.trim()) {
        setFieldError(e('name'), nameEl, 'Name is required'); valid = false;
      } else { clearFieldError(e('name'), nameEl); }

      const minPEl = f('m-min-players'), maxPEl = f('m-max-players');
      const minP = parseInt(minPEl.value, 10), maxP = parseInt(maxPEl.value, 10);
      if (minP && maxP && minP > maxP) {
        setFieldError(e('max-players'), maxPEl, 'Must be ≥ min players'); valid = false;
      } else { clearFieldError(e('max-players'), maxPEl); }

      const minTEl = f('m-min-playtime'), maxTEl = f('m-max-playtime');
      const minT = parseInt(minTEl.value, 10), maxT = parseInt(maxTEl.value, 10);
      if (minT && maxT && minT > maxT) {
        setFieldError(e('max-playtime'), maxTEl, 'Must be ≥ min playtime'); valid = false;
      } else { clearFieldError(e('max-playtime'), maxTEl); }

      const diffEl = f('m-difficulty');
      const diff = parseFloat(diffEl.value);
      if (diffEl.value && (isNaN(diff) || diff < 1 || diff > 5)) {
        setFieldError(e('difficulty'), diffEl, 'Must be between 1 and 5'); valid = false;
      } else { clearFieldError(e('difficulty'), diffEl); }

      return valid;
    }

    // Real-time inline validation — show errors while typing, mark valid when correct
    f('m-name').addEventListener('input', () => {
      const el = f('m-name');
      if (el.value.trim()) {
        clearFieldError(e('name'), el);
        el.classList.add('valid');
      } else {
        setFieldError(e('name'), el, 'Name is required');
        el.classList.remove('valid');
      }
    });
    ['m-min-players', 'm-max-players'].forEach(id => {
      f(id).addEventListener('input', () => {
        const minEl = f('m-min-players'), maxEl = f('m-max-players');
        const minP = parseInt(minEl.value, 10), maxP = parseInt(maxEl.value, 10);
        if (minP && maxP && minP > maxP) {
          setFieldError(e('max-players'), maxEl, 'Must be ≥ min players');
          maxEl.classList.remove('valid');
        } else {
          clearFieldError(e('max-players'), maxEl);
          if (maxP) maxEl.classList.add('valid');
          if (minP) minEl.classList.add('valid');
        }
      });
    });
    ['m-min-playtime', 'm-max-playtime'].forEach(id => {
      f(id).addEventListener('input', () => {
        const minEl = f('m-min-playtime'), maxEl = f('m-max-playtime');
        const minT = parseInt(minEl.value, 10), maxT = parseInt(maxEl.value, 10);
        if (minT && maxT && minT > maxT) {
          setFieldError(e('max-playtime'), maxEl, 'Must be ≥ min playtime');
          maxEl.classList.remove('valid');
        } else {
          clearFieldError(e('max-playtime'), maxEl);
          if (maxT) maxEl.classList.add('valid');
          if (minT) minEl.classList.add('valid');
        }
      });
    });
    // Segmented control for difficulty
    const difficultyControl = document.getElementById('m-difficulty');
    const difficultyValue = document.getElementById('m-difficulty-value');
    if (difficultyControl) {
      difficultyControl.querySelectorAll('.segment').forEach(btn => {
        btn.addEventListener('click', () => {
          difficultyControl.querySelectorAll('.segment').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          difficultyValue.value = btn.dataset.value;
        });
      });
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!validateAddForm()) return;
      const submitBtn = form.querySelector('[type="submit"]');
      const fd   = new FormData(form);
      const file = fileInput.files[0];

      const purchasePriceRaw = fd.get('purchase_price');
      const purchasePriceParsed = parseFloat(purchasePriceRaw);
      const payload = {
        name:              fd.get('name'),
        status:            fd.get('status') || 'owned',
        year_published:    parseInt(fd.get('year_published'), 10) || null,
        min_players:       parseInt(fd.get('min_players'), 10) || null,
        max_players:       parseInt(fd.get('max_players'), 10) || null,
        min_playtime:      parseInt(fd.get('min_playtime'), 10) || null,
        max_playtime:      parseInt(fd.get('max_playtime'), 10) || null,
        difficulty:        parseFloat(fd.get('difficulty')) || null,
        bgg_id:            parseInt(fd.get('bgg_id'), 10) || null,
        // If a file is selected, skip the URL — image will be uploaded after creation
        image_url:         file ? null : (fd.get('image_url') || null),
        description:       fd.get('description') || null,
        categories:        _getChipTags('m-categories'),
        mechanics:         _getChipTags('m-mechanics'),
        designers:         _getChipTags('m-designers'),
        publishers:        _getChipTags('m-publishers'),
        labels:            _getChipTags('m-labels'),
        purchase_date:     fd.get('purchase_date') || null,
        purchase_price:    Number.isFinite(purchasePriceParsed) ? purchasePriceParsed : null,
        purchase_location: fd.get('purchase_location') || null,
        location:           fd.get('location') || null,
        show_location:      fd.get('show_location') === 'on',
        condition:          fd.get('condition') || null,
        edition:            fd.get('edition')?.trim() || null,
        priority:           parseInt(fd.get('priority'), 10) || null,
        target_price:       fd.get('target_price') ? parseFloat(fd.get('target_price')) : null,
      };

      // Cross-field range validation
      if (payload.min_players !== null && payload.max_players !== null && payload.min_players > payload.max_players) {
        showToast('Min players cannot exceed max players', 'error');
        return;
      }
      if (payload.min_playtime !== null && payload.max_playtime !== null && payload.min_playtime > payload.max_playtime) {
        showToast('Min playtime cannot exceed max playtime', 'error');
        return;
      }

      // Duplicate / expansion guard: check backend for exact, similar, or same BGG ID
      let allowDuplicate = false;
      try {
        const dupCheck = await API.checkDuplicate(payload.name, payload.bgg_id);
        if (dupCheck.duplicates && dupCheck.duplicates.length > 0) {
          const dups = dupCheck.duplicates;
          const exact = dups.find(d => d.reason === 'exact_name');
          const sameBgg = dups.find(d => d.reason === 'same_bgg_id');
          const similar = dups.find(d => d.reason === 'similar_name');
          const expansion = dups.find(d => d.reason === 'possible_expansion');
          let title = 'Possible Duplicate';
          let msg = '';
          if (exact) {
            title = 'Exact Duplicate Found';
            msg = `"${exact.name}" is already in your collection (${exact.status}). Add it again anyway?`;
          } else if (sameBgg) {
            title = 'Same BGG ID Found';
            msg = `"${sameBgg.name}" shares the same BGG ID. Add it again anyway?`;
          } else if (expansion) {
            title = 'Possible Expansion';
            msg = `"${expansion.name}" looks like it might be an expansion or related game. Add it anyway?`;
          } else if (similar) {
            title = 'Similar Game Found';
            msg = `"${similar.name}" is very similar. Add it anyway?`;
          }
          const proceed = await showConfirm(title, msg, { confirmLabel: 'Add Anyway', danger: false });
          if (!proceed) return;
          allowDuplicate = true;
        }
      } catch (dupErr) {
        // API unavailable — fall back to a local exact-name check
        const nameLower = payload.name.toLowerCase();
        const localDup = state.games.find(g => g.name.toLowerCase() === nameLower);
        if (localDup) {
          const proceed = await showConfirm(
            'Possible Duplicate',
            `"${localDup.name}" is already in your collection. Add it again anyway?`,
            { confirmLabel: 'Add Anyway', danger: false }
          );
          if (!proceed) return;
          allowDuplicate = true;
        }
      }

      try {
        await withLoading(submitBtn, async () => {
          const created = await API.createGame(payload, allowDuplicate);
          if (file) {
            try {
              await API.uploadImage(created.id, file);
            } catch (imgErr) {
              showToast(`Game added but image upload failed: ${imgErr.message}`, 'error');
            }
          }
          showToast(`"${payload.name}" added to collection!`, 'success');
          launchConfetti();
          form.reset();
          initAddFormChipInputs();
          form.querySelectorAll('.valid').forEach(el => el.classList.remove('valid'));
          if (_addGamePreviewBlobUrl) { URL.revokeObjectURL(_addGamePreviewBlobUrl); _addGamePreviewBlobUrl = null; }
          setPreview(null);
          switchView('collection');
          refreshStatsBackground();
          refreshCollectionStats();
        }, 'Adding…');
      } catch (err) {
        if (err.status === 409) {
          showToast(`Duplicate: ${classifyError(err)}`, 'warning');
        } else {
          showToast(`Failed to add game: ${classifyError(err)}`, 'error');
        }
      }
    });
    _initFormWizard();
  }

  function _initFormWizard() {
    const form = document.getElementById('manual-form');
    const fieldsets = form.querySelectorAll('fieldset.form-section');
    const steps = document.querySelectorAll('#form-wizard-nav .wizard-step');
    const prevBtn = document.getElementById('wizard-prev');
    const nextBtn = document.getElementById('wizard-next');
    const submitBtn = document.getElementById('form-submit-btn');
    if (!fieldsets.length || !steps.length) return;

    let currentStep = 0;

    function showStep(idx, skipScroll) {
      fieldsets.forEach((fs, i) => {
        fs.classList.toggle('active', i === idx);
      });
      steps.forEach((st, i) => {
        st.classList.toggle('active', i === idx);
        st.classList.toggle('completed', i < idx);
      });
      prevBtn.style.visibility = idx === 0 ? 'hidden' : 'visible';
      const wizardActive = getComputedStyle(document.getElementById('form-wizard-nav')).display !== 'none';
      if (wizardActive) {
        if (idx === fieldsets.length - 1) {
          nextBtn.style.display = 'none';
          submitBtn.style.display = 'inline-flex';
        } else {
          nextBtn.style.display = 'inline-flex';
          submitBtn.style.display = 'none';
        }
      } else {
        nextBtn.style.display = '';
        submitBtn.style.display = '';
      }
      if (!skipScroll) fieldsets[idx].scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    nextBtn.addEventListener('click', () => {
      if (currentStep < fieldsets.length - 1) {
        currentStep++;
        showStep(currentStep);
      }
    });

    prevBtn.addEventListener('click', () => {
      if (currentStep > 0) {
        currentStep--;
        showStep(currentStep);
      }
    });

    steps.forEach(step => {
      step.addEventListener('click', () => {
        const target = parseInt(step.dataset.step, 10);
        currentStep = target;
        showStep(currentStep);
      });
    });

    // Initialize
    showStep(0, true);
  }

  // ===== Status Pills =====
  function bindStatusPills() {
    document.querySelectorAll('#status-pills .pill').forEach(btn => {
      btn.addEventListener('click', () => {
        state.statusFilter = btn.dataset.status;
        document.querySelectorAll('#status-pills .pill').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        saveCollectionPrefs();
        syncUrlParams();
        clearBulkSelection();
        loadCollection();
      });
    });
  }

  // ===== Advanced Filters =====
  function renderFilterChips() {
    const mechRow = document.getElementById('filter-mechanics-chips');
    const catRow  = document.getElementById('filter-categories-chips');
    const locRow  = document.getElementById('filter-locations-chips');
    const labelRow    = document.getElementById('filter-labels-chips');
    const designerRow = document.getElementById('filter-designers-chips');
    const publisherRow = document.getElementById('filter-publishers-chips');

    function buildChips(container, items, stateKey) {
      if (!container) return;
      container.innerHTML = '';
      if (!items.length) { container.style.display = 'none'; return; }
      container.style.display = 'flex';
      items.forEach(name => {
        const btn = document.createElement('button');
        btn.className = 'filter-pill' + (state[stateKey].includes(name) ? ' active' : '');
        btn.type = 'button';
        btn.textContent = name;
        btn.addEventListener('click', () => {
          if (state[stateKey].includes(name)) {
            state[stateKey] = state[stateKey].filter(v => v !== name);
            btn.classList.remove('active');
          } else {
            state[stateKey] = [...state[stateKey], name];
            btn.classList.add('active');
          }
          clearBulkSelection();
          saveCollectionPrefs();
          syncUrlParams();
          scheduleFilteredLoad();
        });
      });
    }

    function buildLocationChips(container) {
      if (!container) return;
      container.innerHTML = '';
      const locs = (state.collectionStats && state.collectionStats.locations) || {};
      const entries = Object.entries(locs).sort((a, b) => {
        if (a[0] === NO_LOCATION_SENTINEL) return 1;
        if (b[0] === NO_LOCATION_SENTINEL) return -1;
        return b[1] - a[1] || a[0].localeCompare(b[0]);
      });
      if (!entries.length) { container.style.display = 'none'; return; }
      container.style.display = 'flex';
      const buttons = [];
      entries.forEach(([key, count]) => {
        const btn = document.createElement('button');
        btn.className = 'filter-pill' + (state.filterLocation === key ? ' active' : '');
        btn.type = 'button';
        btn.textContent = `${_locationLabel(key)} (${count})`;
        btn.addEventListener('click', () => {
          const becomingActive = state.filterLocation !== key;
          state.filterLocation = becomingActive ? key : null;
          buttons.forEach(b => b.classList.remove('active'));
          if (becomingActive) btn.classList.add('active');
          clearBulkSelection();
          saveCollectionPrefs();
          syncUrlParams();
          scheduleFilteredLoad();
          syncFilterActiveBar();
        });
        buttons.push(btn);
        container.appendChild(btn);
      });
    }

    const collStats = state.collectionStats || {};
    const topM = Object.keys(collStats.mechanic_counts || {}).slice(0, 10);
    const topC = Object.keys(collStats.category_counts || {}).slice(0, 10);
    const topL = Object.keys(collStats.label_counts || {}).slice(0, 10);
    const topD = Object.keys(collStats.designer_counts || {}).slice(0, 10);
    const topP = Object.keys(collStats.publisher_counts || {}).slice(0, 10);

    buildChips(mechRow, topM, 'filterMechanics');
    buildChips(catRow,  topC, 'filterCategories');
    if (locRow) buildLocationChips(locRow);
    buildChips(labelRow,    topL, 'filterLabels');
    buildChips(designerRow, topD, 'filterDesigners');
    buildChips(publisherRow, topP, 'filterPublishers');
  }

  function bindFilters() {
    const panel      = document.getElementById('filter-panel');
    const searchEl   = document.getElementById('collection-search');
    const searchWrap = searchEl.closest('.search-wrapper');
    const neverBtn   = document.getElementById('filter-never-played');
    const playersEl  = document.getElementById('filter-players');
    const timeEl     = document.getElementById('filter-time');
    const clearBtn   = document.getElementById('filter-clear-all');
    const toggleBtn  = document.getElementById('filter-toggle-btn');
    const loanedBtn  = document.getElementById('filter-loaned');
    const conditionEl = document.getElementById('filter-condition');
    const priceMinEl = document.getElementById('filter-price-min');
    const priceMaxEl = document.getElementById('filter-price-max');

    function openPanel()  { renderFilterChips(); panel.classList.add('open'); syncFilterActiveBar(); toggleBtn.setAttribute('aria-expanded', 'true'); }
    function closePanel() { if (!hasActiveFilters()) panel.classList.remove('open'); syncFilterActiveBar(); toggleBtn.setAttribute('aria-expanded', 'false'); }

    searchEl.addEventListener('click', openPanel);

    toggleBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (panel.classList.contains('open')) {
        panel.classList.remove('open');
        toggleBtn.setAttribute('aria-expanded', 'false');
      } else {
        openPanel();
      }
      syncFilterActiveBar();
    });

    const _filterEsc = (e) => { if (e.key === 'Escape' && panel.classList.contains('open')) { panel.classList.remove('open'); toggleBtn.setAttribute('aria-expanded', 'false'); syncFilterActiveBar(); } };
    document.addEventListener('keydown', _filterEsc);

    document.addEventListener('mousedown', e => {
      if (!panel.contains(e.target) && !searchWrap.contains(e.target) && e.target !== toggleBtn && !toggleBtn.contains(e.target)) closePanel();
    });

    neverBtn.addEventListener('click', () => {
      state.filterNeverPlayed = !state.filterNeverPlayed;
      neverBtn.classList.toggle('active', state.filterNeverPlayed);
      clearBulkSelection();
      saveCollectionPrefs();
      syncUrlParams();
      scheduleFilteredLoad();
    });

    if (loanedBtn) {
      loanedBtn.classList.toggle('active', state.filterLoaned === true);
      loanedBtn.addEventListener('click', () => {
        state.filterLoaned = (state.filterLoaned === true) ? null : true;
        loanedBtn.classList.toggle('active', state.filterLoaned === true);
        clearBulkSelection();
        saveCollectionPrefs();
        syncUrlParams();
        scheduleFilteredLoad();
        syncFilterActiveBar();
      });
    }

    if (conditionEl) {
      conditionEl.value = state.filterCondition || '';
      conditionEl.addEventListener('change', () => {
        state.filterCondition = conditionEl.value || null;
        clearBulkSelection();
        saveCollectionPrefs();
        syncUrlParams();
        scheduleFilteredLoad();
        syncFilterActiveBar();
      });
    }

    let priceDebounce;
    function onPriceInput() {
      clearTimeout(priceDebounce);
      priceDebounce = setTimeout(() => {
        state.filterPriceMin = priceMinEl.value ? parseFloat(priceMinEl.value) : null;
        state.filterPriceMax = priceMaxEl.value ? parseFloat(priceMaxEl.value) : null;
        clearBulkSelection();
        saveCollectionPrefs();
        syncUrlParams();
        scheduleFilteredLoad();
        syncFilterActiveBar();
      }, 300);
    }
    if (priceMinEl) priceMinEl.addEventListener('input', onPriceInput);
    if (priceMaxEl) priceMaxEl.addEventListener('input', onPriceInput);

    let playerDebounce, timeDebounce;

    playersEl.addEventListener('input', () => {
      clearTimeout(playerDebounce);
      playerDebounce = setTimeout(() => {
        state.filterPlayers = playersEl.value ? parseInt(playersEl.value, 10) : null;
        clearBulkSelection();
        saveCollectionPrefs();
        syncUrlParams();
        scheduleFilteredLoad();
      }, 300);
    });

    timeEl.addEventListener('input', () => {
      clearTimeout(timeDebounce);
      timeDebounce = setTimeout(() => {
        state.filterTime = timeEl.value ? parseInt(timeEl.value, 10) : null;
        clearBulkSelection();
        saveCollectionPrefs();
        syncUrlParams();
        scheduleFilteredLoad();
      }, 300);
    });

    clearBtn.addEventListener('click', () => {
      state.filterNeverPlayed = false;
      state.filterPlayers = null;
      state.filterTime = null;
      state.filterMechanics = [];
      state.filterCategories = [];
      state.filterLabels = [];
      state.filterDesigners = [];
      state.filterPublishers = [];
      state.filterCondition = null;
      state.filterLoaned = null;
      state.filterPriceMin = null;
      state.filterPriceMax = null;
      state.filterLocation = null;
      saveCollectionPrefs();
      neverBtn.classList.remove('active');
      playersEl.value = '';
      timeEl.value = '';
      if (loanedBtn) loanedBtn.classList.remove('active');
      if (conditionEl) conditionEl.value = '';
      if (priceMinEl) priceMinEl.value = '';
      if (priceMaxEl) priceMaxEl.value = '';
      document.querySelectorAll('.filter-chips-row .filter-pill')
        .forEach(el => el.classList.remove('active'));
      panel.classList.remove('open');
      clearBulkSelection();
      syncUrlParams();
      loadCollection();
      syncFilterActiveBar();
    });

    // Wire the filter active bar clear button
    document.getElementById('filter-active-clear')?.addEventListener('click', () => {
      clearBtn.click();
    });

    // Share filtered link button
    document.getElementById('filter-active-share')?.addEventListener('click', () => {
      const url = location.href;
      if (navigator.share) {
        navigator.share({ title: 'Cardboard Collection', url }).catch(() => {});
      } else if (navigator.clipboard) {
        navigator.clipboard.writeText(url)
          .then(() => showToast('Filtered link copied to clipboard', 'info'))
          .catch(() => showToast('Could not copy link', 'error'));
      }
    });

    // Sync bar whenever filter inputs change
    [neverBtn, playersEl, timeEl].forEach(el => {
      el.addEventListener('change', syncFilterActiveBar);
    });
    playersEl.addEventListener('input', syncFilterActiveBar);
    timeEl.addEventListener('input', syncFilterActiveBar);
    neverBtn.addEventListener('click', syncFilterActiveBar);
    // Sync when panel opens/closes — but only schedule the timeout when the
    // filter bar is actually visible, to avoid allocating a task on every
    // mousedown anywhere on the page.
    document.addEventListener('mousedown', () => {
      const bar = document.getElementById('filter-active-bar');
      if (bar && bar.style.display === 'flex') {
        setTimeout(syncFilterActiveBar, 50);
      }
    });
  }

  // ===== Game Night Planner =====
  function bindGameNightModal() {
    const btn = document.getElementById('game-night-btn');
    if (!btn) return;
    btn.addEventListener('click', openGameNightModal);
  }

  function openGameNightModal() {
    const modal   = document.getElementById('game-night-modal');
    const inner   = document.getElementById('game-night-inner');
    const backdrop = document.getElementById('game-night-backdrop');
    const prevFocus = document.activeElement;

    const playerOptions = (state.playerObjects || []).map(p =>
      `<label class="gn-player-chip"><input type="checkbox" value="${p.id}" data-gn-player>${escapeHtml(p.name)}</label>`
    ).join('');

    inner.innerHTML = `
      <div class="modal-content-panel">
        <div class="modal-panel-header">
          <h2 id="game-night-title">Game Night</h2>
          <button class="modal-close" id="game-night-close" aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="18" height="18"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="gn-mode-toggle" role="group" aria-label="Game night mode" style="margin-bottom:12px">
          <button class="btn btn-ghost btn-sm gn-mode-btn active" data-mode="suggest" type="button" aria-pressed="true">Single Pick</button>
          <button class="btn btn-ghost btn-sm gn-mode-btn" data-mode="plan" type="button" aria-pressed="false">Plan Evening</button>
        </div>
        <div class="form-grid" style="margin-bottom:12px">
          <div class="form-group">
            <label class="form-label" for="gn-players">Player count</label>
            <input type="number" id="gn-players" class="form-input" min="1" max="20" placeholder="Any" value="${state.filterPlayers || ''}" autocomplete="off">
          </div>
          <div class="form-group gn-time-group">
            <label class="form-label" for="gn-time"><span class="gn-time-label-suggest">Max time (min)</span><span class="gn-time-label-plan" style="display:none">Total time (min)</span></label>
            <input type="number" id="gn-time" class="form-input" min="1" placeholder="Any" value="${state.filterTime || ''}" autocomplete="off">
          </div>
        </div>
        <div class="gn-plan-options" style="display:none;margin-bottom:12px">
          <label class="form-label" style="margin-bottom:6px">Options</label>
          <label class="gn-player-chip"><input type="checkbox" id="gn-teach-mode"> Teach a new game (favor unplayed, low-complexity)</label>
        </div>
        ${playerOptions ? `<div class="gn-player-select" style="margin-bottom:12px"><div class="form-label" style="margin-bottom:6px">Or pick players</div><div class="gn-player-chips">${playerOptions}</div></div>` : ''}
        <button class="btn btn-primary" id="gn-suggest-btn" style="width:100%"><span class="gn-btn-label-suggest">Suggest Games</span><span class="gn-btn-label-plan" style="display:none">Plan Evening</span></button>
        <div id="gn-results"></div>
        <div class="modal-close-bar">
          <button class="modal-close-sticky-btn" id="game-night-close-sticky" aria-label="Close">
            Close
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="16" height="16"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      </div>`;

    modal.style.display = 'flex';
    pushModalOpen();

    let gnMode = 'suggest';
    function updateMode(mode) {
      gnMode = mode;
      inner.querySelectorAll('.gn-mode-btn').forEach(b => {
        const isActive = b.dataset.mode === mode;
        b.classList.toggle('active', isActive);
        b.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      });
      const isPlan = mode === 'plan';
      inner.querySelector('.gn-plan-options').style.display = isPlan ? '' : 'none';
      inner.querySelector('.gn-time-label-suggest').style.display = isPlan ? 'none' : '';
      inner.querySelector('.gn-time-label-plan').style.display = isPlan ? '' : 'none';
      inner.querySelector('.gn-btn-label-suggest').style.display = isPlan ? 'none' : '';
      inner.querySelector('.gn-btn-label-plan').style.display = isPlan ? '' : 'none';
      inner.querySelector('#gn-results').innerHTML = '';
    }
    inner.querySelectorAll('.gn-mode-btn').forEach(b => b.addEventListener('click', () => updateMode(b.dataset.mode)));

    let trapHandler = null;
    requestAnimationFrame(() => {
      modal.classList.add('open');
      inner.querySelector('#gn-players').focus();
      const focusables = () => [...modal.querySelectorAll(FOCUSABLE)].filter(el => el.offsetParent !== null);
      trapHandler = (e) => {
        if (e.key !== 'Tab') return;
        const els = focusables();
        if (!els.length) return;
        if (e.shiftKey && document.activeElement === els[0]) { e.preventDefault(); els[els.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === els[els.length - 1]) { e.preventDefault(); els[0].focus(); }
      };
      modal.addEventListener('keydown', trapHandler);
    });

    const _gnEscape = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', _gnEscape);

    function close() {
      modal.classList.remove('open');
      if (trapHandler) { modal.removeEventListener('keydown', trapHandler); trapHandler = null; }
      document.removeEventListener('keydown', _gnEscape);
      if (prevFocus) prevFocus.focus();
      setTimeout(() => { modal.style.display = 'none'; inner.innerHTML = ''; popModalOpen(); }, 200);
      backdrop.removeEventListener('click', close);
    }

    backdrop.addEventListener('click', close);
    inner.querySelector('#game-night-close').addEventListener('click', (e) => { e.stopPropagation(); close(); });
    const stickyClose = inner.querySelector('#game-night-close-sticky');
    if (stickyClose) stickyClose.addEventListener('click', (e) => { e.stopPropagation(); close(); });

    inner.querySelector('#gn-suggest-btn').addEventListener('click', async () => {
      const playerCount = parseInt(inner.querySelector('#gn-players').value, 10) || null;
      const maxMinutes  = parseInt(inner.querySelector('#gn-time').value, 10) || null;
      const selectedPlayerIds = [...inner.querySelectorAll('[data-gn-player]:checked')].map(cb => +cb.value);
      const resultsEl   = inner.querySelector('#gn-results');
      const btn         = inner.querySelector('#gn-suggest-btn');
      const dismissedIds = new Set();
      let allSuggestions = [];
      const useGroupRecommend = selectedPlayerIds.length > 0;
      const isPlanMode = gnMode === 'plan';
      const teachMode = !!inner.querySelector('#gn-teach-mode')?.checked;

      function renderPlanTimeline(plan) {
        if (!plan.slots || !plan.slots.length) {
          resultsEl.innerHTML = `<p class="game-night-empty">${escapeHtml(plan.note || 'No suitable games found.')}</p>`;
          return;
        }
        const roleIcons = { opener: '🎬', main: '🎯', closer: '🏁' };
        const roleLabels = { opener: 'Opener', main: 'Main', closer: 'Closer' };
        const totalLabel = plan.feasible
          ? `Total: ${plan.total_est_minutes} min`
          : `Total: ${plan.total_est_minutes} min (over budget)`;
        const chips = [];
        if (playerCount) chips.push(`👥 ${playerCount}`);
        if (selectedPlayerIds.length) chips.push(`👥 ${selectedPlayerIds.length} players`);
        if (teachMode) chips.push('📖 Teach mode');
        const chipsHtml = chips.length ? `<div class="gn-active-filters">${chips.map(c => `<span class="reason-chip">${escapeHtml(c)}</span>`).join('')}</div>` : '';
        const noteHtml = plan.note ? `<p class="gn-plan-note">${escapeHtml(plan.note)}</p>` : '';

        resultsEl.innerHTML = chipsHtml + noteHtml + `<div class="gn-plan-timeline">${plan.slots.map(s => `
          <div class="gn-plan-slot gn-plan-${escapeHtml(s.role)}" data-game-id="${s.game.id}" role="button" tabindex="0" aria-label="${escapeHtml(roleLabels[s.role] || s.role)}: ${escapeHtml(s.game.name)}">
            <div class="gn-plan-role">${roleIcons[s.role] || ''} ${escapeHtml(roleLabels[s.role] || s.role)}</div>
            <div class="gn-plan-thumb">${isSafeUrl(s.game.image_url) ? `<img src="${escapeHtml(s.game.image_url)}" alt="" loading="lazy">` : placeholderSvg()}</div>
            <div class="gn-plan-info">
              <div class="gn-plan-name">${escapeHtml(s.game.name)}</div>
              <div class="gn-plan-meta">
                <span>~${s.est_minutes} min</span>
                ${s.game.difficulty ? `<span>Difficulty ${+s.game.difficulty.toFixed(2)}</span>` : ''}
                ${s.game.user_rating ? `<span>★ ${s.game.user_rating.toFixed(1)}</span>` : ''}
              </div>
              ${s.reason ? `<div class="gn-plan-reason"><span class="reason-chip">${escapeHtml(s.reason)}</span></div>` : ''}
            </div>
          </div>`).join('')}</div><div class="gn-plan-total">${escapeHtml(totalLabel)}</div>`;

        resultsEl.querySelectorAll('.gn-plan-slot').forEach(el => {
          const open = () => {
            const game = state.games.find(g => g.id === +el.dataset.gameId);
            if (game) { close(); openGameModal(game); }
          };
          el.addEventListener('click', open);
          el.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
          });
        });
      }

      function renderResults(suggestions) {
        const visible = suggestions.filter(s => !dismissedIds.has(s.id));
        if (!visible.length) {
          resultsEl.innerHTML = `
            <p class="game-night-empty">All games dismissed.</p>
            <button class="btn btn-ghost btn-sm gn-reset-btn">Reset &amp; re-roll</button>
          `;
          resultsEl.querySelector('.gn-reset-btn')?.addEventListener('click', () => {
            dismissedIds.clear();
            renderResults(allSuggestions);
          });
          return;
        }
        const activeChips = [];
        if (useGroupRecommend) activeChips.push(`👥 ${selectedPlayerIds.length} players`);
        else if (playerCount) activeChips.push(`👥 ${playerCount} players`);
        if (maxMinutes) activeChips.push(`⏱ ≤ ${maxMinutes} min`);
        const filterChipsHtml = activeChips.length
          ? `<div class="gn-active-filters">${activeChips.map(c => `<span class="reason-chip">${escapeHtml(c)}</span>`).join('')}</div>`
          : '';

        resultsEl.innerHTML = filterChipsHtml + visible.map((s, i) => `
          <div class="game-night-item${i === 0 ? ' gn-top-pick' : ''}" data-game-id="${s.id}" role="button" tabindex="0" aria-label="${escapeHtml(s.name)}">
            <div class="game-night-thumb">
              ${isSafeUrl(s.image_url) ? `<img src="${escapeHtml(s.image_url)}" alt="" loading="lazy">` : placeholderSvg()}
            </div>
            <div class="game-night-info">
              <div class="game-night-name">${escapeHtml(s.name)}</div>
              <div class="game-night-meta">
                ${s.min_players || s.max_players ? `<span>${formatPlayers(s.min_players, s.max_players)}</span>` : ''}
                ${s.min_playtime || s.max_playtime ? `<span>${formatPlaytime(s.min_playtime, s.max_playtime)}</span>` : ''}
                ${s.difficulty ? `<span>Difficulty ${+s.difficulty.toFixed(2)}</span>` : ''}
                ${s.user_rating ? `<span>★ ${s.user_rating.toFixed(1)}</span>` : ''}
              </div>
              <div class="game-night-reasons">${(s.reasons || [s.reason]).filter(Boolean).map(r => `<span class="reason-chip">${escapeHtml(r)}</span>`).join('')}</div>
            </div>
            <button class="gn-dismiss-btn" data-game-id="${s.id}" aria-label="Not interested in ${escapeHtml(s.name)}" title="Not interested">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>
            </button>
          </div>`).join('');

        if (visible.length < allSuggestions.length) {
          resultsEl.insertAdjacentHTML('beforeend', '<button class="btn btn-ghost btn-sm gn-reroll-btn" style="margin-top:12px">🔄 Re-roll with new games</button>');
          resultsEl.querySelector('.gn-reroll-btn')?.addEventListener('click', () => {
            resultsEl.innerHTML = `<div class="gn-thinking"><div class="gn-dice">🎲</div><p>Finding more games…</p></div>`;
            fetchAndRender();
          });
        }

        resultsEl.querySelectorAll('.gn-dismiss-btn').forEach(b => {
          b.addEventListener('click', e => {
            e.stopPropagation();
            const id = +b.dataset.gameId;
            dismissedIds.add(id);
            const item = b.closest('.game-night-item');
            if (item) {
              item.style.maxHeight = item.offsetHeight + 'px';
              requestAnimationFrame(() => item.classList.add('gn-dismissed'));
              setTimeout(() => renderResults(allSuggestions), 250);
            }
          });
        });

        resultsEl.querySelectorAll('.game-night-item').forEach(el => {
          const open = (e) => {
            if (e.target.closest('.gn-dismiss-btn')) return;
            const game = state.games.find(g => g.id === +el.dataset.gameId);
            if (game) { close(); openGameModal(game); }
          };
          el.addEventListener('click', open);
          el.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(e); }
          });
        });
      }

      async function fetchAndRender() {
        try {
          if (isPlanMode) {
            if (!maxMinutes) {
              resultsEl.innerHTML = '<p class="game-night-empty">Enter a total time budget to plan an evening.</p>';
              return;
            }
            const effectivePlayerCount = playerCount || (selectedPlayerIds.length || null);
            const plan = await API.planEvening(maxMinutes, effectivePlayerCount, selectedPlayerIds, teachMode);
            renderPlanTimeline(plan);
            return;
          }
          let suggestions;
          if (useGroupRecommend) {
            const resp = await API.groupRecommend(selectedPlayerIds, maxMinutes, null);
            suggestions = (resp.recommendations || []).map(r => ({
              ...r.game,
              reasons: [r.reason],
              reason: r.reason,
            }));
          } else {
            suggestions = await API.suggestGames(playerCount, maxMinutes);
          }
          allSuggestions = suggestions;
          if (!allSuggestions.length) {
            resultsEl.innerHTML = '<p class="game-night-empty">No matching games found. Try adjusting the filters.</p>';
            return;
          }
          dismissedIds.clear();
          renderResults(allSuggestions);
        } catch (err) { showToast(classifyError(err), 'error'); }
      }

      // Show thinking animation immediately
      const thinkingMsg = isPlanMode ? 'Planning your evening…' : 'Finding your game…';
      resultsEl.innerHTML = `<div class="gn-thinking"><div class="gn-dice">🎲</div><p>${escapeHtml(thinkingMsg)}</p></div>`;
      await withLoading(btn, fetchAndRender, isPlanMode ? 'Planning…' : 'Finding games…');
    });
  }

  // ===== Stats =====
  let _statsLoading = false;
  let _statsPrefetched = null;
  let _statsPrefetchInFlight = false;
  let _pendingBggHighlight = false; // set when user clicks "Import from BGG" on the empty state
  const STATS_PREFS_KEY = 'cardboard_stats_prefs';
  const STATS_PREFS_DEFAULTS = {
    show_summary: true, show_most_played: true, show_top_players: true,
    show_recently_played: true,
    show_recently_added: true,
    show_ratings: true, show_labels: true, show_added_by_month: true,
    show_sessions_by_month: true, show_play_heatmap: true,
    show_sessions_by_dow: true, show_never_played: true,
    show_dormant: true, show_top_mechanics: true, show_collection_value: true,
    show_milestones: true, show_goals: true, show_cooling_off: true, show_trade_sell: true,
    added_by_month_include_wishlist: true,
    section_order: ['summary', 'most_played', 'top_players', 'recently_played', 'recently_added',
                    'ratings', 'labels', 'added_by_month', 'sessions_by_month', 'play_heatmap',
                    'sessions_by_dow',
                    'never_played', 'cooling_off', 'dormant', 'top_mechanics', 'collection_value',
                    'trade_sell', 'milestones', 'goals'],
  };

  function loadStatsPrefs() {
    try {
      const merged = { ...STATS_PREFS_DEFAULTS, ...loadJsonFromStorage(STATS_PREFS_KEY, {}) };
      // Keep saved order but append any newly added sections at the end
      const all = STATS_PREFS_DEFAULTS.section_order;
      const valid = (merged.section_order || []).filter(k => all.includes(k));
      merged.section_order = [...valid, ...all.filter(k => !valid.includes(k))];
      return merged;
    } catch { return { ...STATS_PREFS_DEFAULTS }; }
  }

  function saveStatsPrefs(newPrefs) {
    try {
      localStorage.setItem(STATS_PREFS_KEY, JSON.stringify(newPrefs));
    } catch (_) { /* quota exceeded — preferences not saved, non-fatal */ }
  }

  // ===== Collection Display Prefs =====
  const COLLECTION_DISPLAY_PREFS_KEY = 'cardboard_collection_display_prefs';
  const COLLECTION_DISPLAY_PREFS_DEFAULTS = {
    show_status_pills: true,
    show_collection_stats: true,
    show_recently_played: true,
    show_recommend_card: true,
    show_action_plan: true,
    show_reminder_banner: true,
    show_game_night_btn: true,
    show_bulk_select: true,
    show_expansions_btn: true,
    section_order: ['toolbar', 'filters', 'status_pills', 'collection_stats',
                    'recently_played', 'recommend_card', 'action_plan', 'reminder_banner', 'games'],
  };

  let currentCollectionDisplayPrefs = { ...COLLECTION_DISPLAY_PREFS_DEFAULTS };

  function loadCollectionDisplayPrefs() {
    try {
      const merged = { ...COLLECTION_DISPLAY_PREFS_DEFAULTS, ...loadJsonFromStorage(COLLECTION_DISPLAY_PREFS_KEY, {}) };
      const all = COLLECTION_DISPLAY_PREFS_DEFAULTS.section_order;
      const valid = (merged.section_order || []).filter(k => all.includes(k));
      merged.section_order = [...valid, ...all.filter(k => !valid.includes(k))];
      return merged;
    } catch { return { ...COLLECTION_DISPLAY_PREFS_DEFAULTS }; }
  }

  function saveCollectionDisplayPrefs(newPrefs) {
    try {
      localStorage.setItem(COLLECTION_DISPLAY_PREFS_KEY, JSON.stringify(newPrefs));
    } catch (_) { /* quota exceeded — preferences not saved, non-fatal */ }
  }

  function applyCollectionDisplayPrefs(prefs) {
    const toggles = [
      ['show_status_pills',    'status-pills'],
      ['show_collection_stats','collection-stats'],
      ['show_recently_played', 'recently-played-shelf'],
      ['show_recommend_card',  'recommend-card'],
      ['show_action_plan',     'action-plan-card'],
      ['show_reminder_banner', 'reminder-banner'],
      ['show_bulk_select',     'bulk-select-toggle'],
      ['show_expansions_btn',  'show-expansions-btn'],
    ];
    toggles.forEach(([prefKey, elId]) => {
      const el = document.getElementById(elId);
      if (el) el.style.display = prefs[prefKey] ? '' : 'none';
    });
    const gameNightBtn = document.getElementById('game-night-btn');
    if (gameNightBtn) gameNightBtn.style.display = prefs.show_game_night_btn ? '' : 'none';

    // Reorder collection sections
    const container = document.getElementById('view-collection');
    if (container) {
      prefs.section_order.forEach(key => {
        const section = container.querySelector(`[data-collection-section="${key}"]`);
        if (section) container.appendChild(section);
      });
    }
  }

  const EXPORT_COLS = [
    { key: 'name',              label: 'Name',               list: false, on: true  },
    { key: 'status',            label: 'Status',             list: false, on: true  },
    { key: 'year_published',    label: 'Year Published',     list: false, on: true  },
    { key: 'min_players',       label: 'Min Players',        list: false, on: true  },
    { key: 'max_players',       label: 'Max Players',        list: false, on: true  },
    { key: 'min_playtime',      label: 'Min Playtime (min)', list: false, on: true  },
    { key: 'max_playtime',      label: 'Max Playtime (min)', list: false, on: true  },
    { key: 'difficulty',        label: 'Difficulty',         list: false, on: true  },
    { key: 'user_rating',       label: 'Rating',             list: false, on: true  },
    { key: 'user_notes',        label: 'Notes',              list: false, on: true  },
    { key: 'description',       label: 'Description',        list: false, on: false },
    { key: 'labels',            label: 'Labels',             list: true,  on: true  },
    { key: 'categories',        label: 'Categories',         list: true,  on: true  },
    { key: 'mechanics',         label: 'Mechanics',          list: true,  on: true  },
    { key: 'designers',         label: 'Designers',          list: true,  on: true  },
    { key: 'publishers',        label: 'Publishers',         list: true,  on: true  },
    { key: 'purchase_date',     label: 'Purchase Date',      list: false, on: true  },
    { key: 'purchase_price',    label: 'Purchase Price',     list: false, on: true  },
    { key: 'purchase_location', label: 'Purchase Location',  list: false, on: true  },
    { key: 'location',          label: 'Location',           list: false, on: true  },
    { key: 'last_played',       label: 'Last Played',        list: false, on: true  },
    { key: 'date_added',        label: 'Date Added',         list: false, on: true  },
    { key: 'date_modified',     label: 'Date Modified',      list: false, on: false },
    { key: 'image_url',         label: 'Image URL',          list: false, on: false },
  ];

  const EXPORT_PREFS_KEY = 'cardboard_export_prefs';

  function loadExportPrefs() {
    const saved = loadJsonFromStorage(EXPORT_PREFS_KEY, {});
    return EXPORT_COLS.map(c => ({ ...c, on: c.key in saved ? saved[c.key] : c.on }));
  }

  function saveExportPrefs(cols) {
    const obj = {};
    cols.forEach(c => { obj[c.key] = c.on; });
    localStorage.setItem(EXPORT_PREFS_KEY, JSON.stringify(obj));
  }

  function _closeExportDropdown(e) {
    const wrapper = document.getElementById('stats-export-cols-wrapper');
    if (!wrapper || wrapper.contains(e.target)) return;
    const dd = document.getElementById('stats-export-cols-dropdown');
    const btn = document.getElementById('stats-export-cols-btn');
    if (dd) dd.hidden = true;
    if (btn) btn.classList.remove('open');
  }

  function exportCollectionJSON(cols) {
    const enabled = cols.filter(c => c.on);
    const data = state.games.map(g => {
      const out = {};
      enabled.forEach(c => { out[c.key] = g[c.key] ?? null; });
      return out;
    });
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `cardboard-export-${new Date().toISOString().split('T')[0]}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  function exportCollectionCSV(cols) {
    const enabled = cols.filter(c => c.on);
    function csvField(val) {
      if (val == null) return '';
      const s = String(val);
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? `"${s.replace(/"/g, '""')}"` : s;
    }
    const rows = [enabled.map(c => c.label).join(',')];
    for (const g of state.games) {
      rows.push(enabled.map(c => csvField(c.list ? parseList(g[c.key]).join('; ') : g[c.key])).join(','));
    }
    const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `cardboard-export-${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  let _statsEscController = null;

  function _bindStatsSectionDragDrop(statsView) {
    const sectionsGrid = statsView.querySelector('#stats-sections');
    if (!sectionsGrid) return;

    const allowedKeys = new Set(STATS_PREFS_DEFAULTS.section_order);

    const gripSvg = `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
      <circle cx="9" cy="5" r="1.5"/><circle cx="15" cy="5" r="1.5"/>
      <circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/>
      <circle cx="9" cy="19" r="1.5"/><circle cx="15" cy="19" r="1.5"/>
    </svg>`;

    let dragSrcKey = null;

    sectionsGrid.querySelectorAll('.stats-section').forEach(section => {
      const key = section.dataset.section;
      if (!key || !allowedKeys.has(key)) return;
      if (section.hasAttribute('data-has-handle')) return;
      section.setAttribute('draggable', 'true');

      // Add drag handle
      const handle = document.createElement('span');
      handle.className = 'stats-drag-handle';
      handle.innerHTML = gripSvg;
      handle.setAttribute('aria-label', 'Drag to reorder');
      section.insertBefore(handle, section.firstChild);
      section.setAttribute('data-has-handle', '');

      section.addEventListener('dragstart', e => {
        dragSrcKey = key;
        section.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      });

      section.addEventListener('dragend', () => {
        section.classList.remove('dragging');
        sectionsGrid.querySelectorAll('.drag-over').forEach(s => s.classList.remove('drag-over'));
        dragSrcKey = null;
      });

      section.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (key !== dragSrcKey) {
          section.classList.add('drag-over');
        }
      });

      section.addEventListener('dragleave', () => {
        section.classList.remove('drag-over');
      });

      section.addEventListener('drop', e => {
        e.preventDefault();
        section.classList.remove('drag-over');
        if (!dragSrcKey || dragSrcKey === key) return;

        const srcSection = sectionsGrid.querySelector(`[data-section="${dragSrcKey}"]`);
        if (!srcSection) return;

        const sections = [...sectionsGrid.querySelectorAll('[data-section]')].filter(s => allowedKeys.has(s.dataset.section));
        const srcIdx = sections.indexOf(srcSection);
        const dstIdx = sections.indexOf(section);
        sectionsGrid.insertBefore(srcSection, srcIdx < dstIdx ? section.nextSibling : section);

        // Persist new order
        const newOrder = [...sectionsGrid.querySelectorAll('[data-section]')].filter(s => allowedKeys.has(s.dataset.section)).map(s => s.dataset.section);
        saveStatsPrefs({ ...loadStatsPrefs(), section_order: newOrder });
      });
    });
  }

  function wireStatsView(statsView, stats = {}) {
    const allGames = state.games;
    if (_statsEscController) _statsEscController.abort();
    _statsEscController = new AbortController();
    statsView.querySelector('#stats-log-first-play')?.addEventListener('click', () => {
      const firstGame = state.games[0];
      if (firstGame) openQuickLogSession(firstGame);
    });

    // Direct drag-and-drop reordering of stats sections
    _bindStatsSectionDragDrop(statsView);
    statsView.addEventListener('click', (e) => {
      const btn = e.target.closest('.health-info-btn');
      if (!btn) return;
      e.stopPropagation();
      // The popover is always the next sibling element after the button's parent (.health-header or .stats-section-header)
      const parent = btn.parentElement;
      const popover = parent.nextElementSibling?.classList.contains('health-info-popover')
        ? parent.nextElementSibling
        : btn.closest('.stats-section')?.querySelector('.health-info-popover');
      if (!popover) return;
      const open = !popover.hidden;
      // Close any other open popovers in the stats view first
      statsView.querySelectorAll('.health-info-popover:not([hidden])').forEach(p => {
        if (p !== popover) {
          p.hidden = true;
          p.previousElementSibling?.querySelector('.health-info-btn')?.setAttribute('aria-expanded', 'false');
          p.previousElementSibling?.querySelector('.health-info-btn')?.classList.remove('active');
        }
      });
      popover.hidden = open;
      btn.setAttribute('aria-expanded', String(!open));
      btn.classList.toggle('active', !open);
    });
    document.addEventListener('keydown', function(e) {
      if (e.key !== 'Escape') return;
      statsView.querySelectorAll('.health-info-popover:not([hidden])').forEach(popover => {
        popover.hidden = true;
        popover.previousElementSibling?.querySelector('.health-info-btn')?.setAttribute('aria-expanded', 'false');
        popover.previousElementSibling?.querySelector('.health-info-btn')?.classList.remove('active');
      });
    }, { signal: _statsEscController.signal });

    // Heatmap right-edge fade: remove when scrolled to end
    const heatmapScroll = statsView.querySelector('.stats-heatmap-scroll');
    const heatmapWrap   = statsView.querySelector('.stats-heatmap-wrap');
    if (heatmapScroll && heatmapWrap) {
      const _checkHeatScroll = () => {
        const atEnd = heatmapScroll.scrollLeft + heatmapScroll.clientWidth >= heatmapScroll.scrollWidth - 4;
        heatmapWrap.classList.toggle('scrolled-end', atEnd);
      };
      heatmapScroll.addEventListener('scroll', _checkHeatScroll, { passive: true });
      // Defer scroll to the next frame — scrollWidth may be 0 if the element was
      // just inserted into the DOM in the same synchronous task.
      requestAnimationFrame(() => {
        heatmapScroll.scrollLeft = heatmapScroll.scrollWidth;
        _checkHeatScroll();
      });
    }

    const colsDropdown = statsView.querySelector('#stats-export-cols-dropdown');
    if (!colsDropdown) return;
    const exportCols = loadExportPrefs();
    colsDropdown.innerHTML = exportCols.map(c => `
      <label class="export-col-item">
        <input type="checkbox" value="${c.key}"${c.on ? ' checked' : ''}>
        <span>${c.label}</span>
      </label>`).join('');
    colsDropdown.querySelectorAll('input').forEach(cb => {
      cb.addEventListener('change', () => {
        const col = exportCols.find(c => c.key === cb.value);
        if (col) col.on = cb.checked;
        saveExportPrefs(exportCols);
      });
    });
    const colsBtn = statsView.querySelector('#stats-export-cols-btn');
    colsBtn.setAttribute('aria-haspopup', 'true');
    colsBtn.setAttribute('aria-expanded', 'false');
    const _closeColsDropdown = () => {
      colsDropdown.hidden = true;
      colsBtn.classList.remove('open');
      colsBtn.setAttribute('aria-expanded', 'false');
    };
    colsBtn.addEventListener('click', e => {
      e.stopPropagation();
      colsDropdown.hidden = !colsDropdown.hidden;
      colsBtn.classList.toggle('open', !colsDropdown.hidden);
      colsBtn.setAttribute('aria-expanded', !colsDropdown.hidden ? 'true' : 'false');
    });
    const _colsEsc = (e) => { if (e.key === 'Escape' && !colsDropdown.hidden) _closeColsDropdown(); };
    document.addEventListener('keydown', _colsEsc);
    document.removeEventListener('click', _closeExportDropdown);
    document.addEventListener('click', _closeExportDropdown);
    statsView.querySelector('#stats-export-json').addEventListener('click', () => exportCollectionJSON(exportCols));
    statsView.querySelector('#stats-export-csv').addEventListener('click', () => exportCollectionCSV(exportCols));

    const bggImportBtn  = statsView.querySelector('#stats-import-bgg');
    const bggFileInput  = statsView.querySelector('#stats-import-bgg-file');
    bggImportBtn.addEventListener('click', () => bggFileInput.click());
    bggFileInput.addEventListener('change', async () => {
      const file = bggFileInput.files[0];
      if (!file) return;
      bggFileInput.value = '';
      try {
        await withLoading(bggImportBtn, async () => {
          const result = await API.importBGG(file);
          const parts = [`${result.imported} imported`, `${result.skipped} skipped`];
          if (result.errors && result.errors.length) parts.push(`${result.errors.length} error(s)`);
          showToast(parts.join(' · '), result.imported > 0 ? 'success' : 'info');
          if (result.imported > 0) { await loadCollection(); await loadStats(); }
        }, 'Importing…');
      } catch (err) { showToast(`Import failed: ${classifyError(err)}`, 'error'); }
    });

    const backupBtn = statsView.querySelector('#stats-backup-download');
    backupBtn.addEventListener('click', () => {
      API.downloadBackup();
      showToast('Backup download started…', 'info');
    });

    // Restore from backup
    const restoreBtn   = statsView.querySelector('#stats-restore-btn');
    const restoreInput = statsView.querySelector('#stats-restore-file');
    if (restoreBtn && restoreInput) {
      restoreBtn.addEventListener('click', () => restoreInput.click());
      restoreInput.addEventListener('change', async () => {
        const file = restoreInput.files[0];
        if (!file) return;
        try {
          await withLoading(restoreBtn, async () => {
            const preview = await API.previewRestore(file);
            _showRestorePreview(preview, file, restoreBtn);
          }, 'Reading backup…');
        } catch (err) {
          showToast(`Could not read backup: ${classifyError(err)}`, 'error');
        }
      });

      function _showRestorePreview(preview, file, btn) {
        const gameListHtml = preview.games_preview && preview.games_preview.length
          ? preview.games_preview.map(n => `<li class="restore-preview-game">${escapeHtml(n)}</li>`).join('')
          : '<li class="restore-preview-empty">(empty)</li>';

        const content = `
          <div class="restore-preview" role="dialog" aria-modal="true" aria-labelledby="restore-preview-title">
            <div class="restore-preview-header">
              <h3 id="restore-preview-title">Backup Preview</h3>
              <button class="restore-preview-close" aria-label="Close">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
              </button>
            </div>
            <div class="restore-preview-stats">
              <div class="restore-preview-stat"><span class="restore-preview-num">${preview.game_count}</span> games</div>
              <div class="restore-preview-stat"><span class="restore-preview-num">${preview.session_count}</span> sessions</div>
              <div class="restore-preview-stat"><span class="restore-preview-num">${preview.player_count}</span> players</div>
              <div class="restore-preview-stat"><span class="restore-preview-num">${preview.media_file_count}</span> media files</div>
            </div>
            <div class="restore-preview-detail">
              <span class="restore-preview-subtitle">Status breakdown</span>
              <div class="restore-preview-statuses">
                <span class="status-pill">Owned: ${preview.owned_count ?? '—'}</span>
                <span class="status-pill">Wishlist: ${preview.wishlist_count ?? '—'}</span>
                <span class="status-pill">Sold: ${preview.sold_count ?? '—'}</span>
              </div>
            </div>
            <div class="restore-preview-games">
              <span class="restore-preview-subtitle">Games in backup</span>
              <ul class="restore-preview-game-list">${gameListHtml}</ul>
            </div>
            <p class="restore-preview-warning">This will replace <strong>all</strong> current data with the backup.</p>
            <div class="restore-preview-actions">
              <button class="btn btn-secondary" id="restore-preview-cancel">Cancel</button>
              <button class="btn btn-danger" id="restore-preview-confirm">Restore from Backup</button>
            </div>
          </div>
        `;

        const overlay = document.createElement('div');
        overlay.className = 'restore-preview-overlay';
        overlay.innerHTML = content;
        document.body.appendChild(overlay);

        const dialog = overlay.querySelector('.restore-preview');
        const closeBtn = overlay.querySelector('.restore-preview-close');
        const cancelBtn = overlay.querySelector('#restore-preview-cancel');
        const confirmBtn = overlay.querySelector('#restore-preview-confirm');
        const prevFocus = document.activeElement;
        pushModalOpen();

        const close = () => {
          document.removeEventListener('keydown', onKey);
          document.removeEventListener('keydown', trapFocus);
          overlay.classList.remove('open');
          dialog.classList.remove('open');
          setTimeout(() => {
            overlay.remove();
            popModalOpen();
            if (prevFocus && prevFocus.focus) prevFocus.focus();
          }, 200);
          restoreInput.value = '';
        };

        const onKey = (e) => {
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
        };

        const FOCUSABLE = 'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
        const trapFocus = (e) => {
          if (e.key !== 'Tab') return;
          const focusable = dialog.querySelectorAll(FOCUSABLE);
          if (!focusable.length) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        };

        document.addEventListener('keydown', onKey);
        document.addEventListener('keydown', trapFocus);

        overlay.addEventListener('click', (e) => {
          if (e.target === overlay) close();
        });
        cancelBtn.addEventListener('click', close);
        closeBtn.addEventListener('click', close);
        confirmBtn.addEventListener('click', async () => {
          close();
          const confirmed = await showConfirm(
            'Restore from Backup',
            'This will replace all current data. This cannot be undone. Continue?',
            { confirmLabel: 'Restore', danger: false }
          );
          if (!confirmed) return;
          try {
            await withLoading(btn, async () => {
              const result = await API.restoreBackup(file);
              showToast(result?.detail || 'Restore successful! Reloading…', 'success', 4000);
              setTimeout(() => location.reload(), 2000);
            }, 'Restoring…');
          } catch (err) {
            showToast(`Restore failed: ${classifyError(err)}`, 'error');
          }
        });

        requestAnimationFrame(() => {
          overlay.classList.add('open');
          dialog.classList.add('open');
          cancelBtn.focus();
        });
      }
    }

    // BGG plays import
    const bggPlaysBtn   = statsView.querySelector('#stats-import-bgg-plays');
    const bggPlaysInput = statsView.querySelector('#stats-import-bgg-plays-file');
    if (bggPlaysBtn && bggPlaysInput) {
      bggPlaysBtn.addEventListener('click', () => bggPlaysInput.click());
      bggPlaysInput.addEventListener('change', async () => {
        const file = bggPlaysInput.files[0];
        if (!file) return;
        bggPlaysInput.value = '';
        try {
          await withLoading(bggPlaysBtn, async () => {
            const result = await API.importBGGPlays(file);
            const parts = [`${result.imported} plays imported`, `${result.skipped} skipped`];
            if (result.errors && result.errors.length) parts.push(`${result.errors.length} error(s)`);
            showToast(parts.join(' · '), result.imported > 0 ? 'success' : 'info');
            if (result.imported > 0) { await loadCollection(); await loadStats(); }
          }, 'Importing…');
        } catch (err) { showToast(`Import failed: ${classifyError(err)}`, 'error'); }
      });
    }

    // CSV import
    const csvImportBtn   = statsView.querySelector('#stats-import-csv');
    const csvImportInput = statsView.querySelector('#stats-import-csv-file');
    if (csvImportBtn && csvImportInput) {
      csvImportBtn.addEventListener('click', () => csvImportInput.click());
      csvImportInput.addEventListener('change', async () => {
        const file = csvImportInput.files[0];
        if (!file) return;
        csvImportInput.value = '';
        try {
          await withLoading(csvImportBtn, async () => {
            const result = await API.importCSV(file);
            const parts = [`${result.imported} imported`, `${result.skipped} skipped`];
            if (result.errors && result.errors.length) parts.push(`${result.errors.length} error(s)`);
            showToast(parts.join(' · '), result.imported > 0 ? 'success' : 'info');
            if (result.imported > 0) { await loadCollection(); await loadStats(); }
          }, 'Importing…');
        } catch (err) { showToast(`Import failed: ${classifyError(err)}`, 'error'); }
      });
    }

    const wishlistToggle = statsView.querySelector('#added-wishlist-toggle');
    if (wishlistToggle) {
      wishlistToggle.addEventListener('change', () => {
        const prefs = loadStatsPrefs();
        prefs.added_by_month_include_wishlist = wishlistToggle.checked;
        saveStatsPrefs(prefs);
        const chart = statsView.querySelector('#added-by-month-chart');
        if (chart) {
          chart.innerHTML = buildAddedByMonthFromEntries(
            wishlistToggle.checked ? (stats.added_by_month || []) : (stats.added_by_month_owned_only || [])
          );
          chart.querySelectorAll('.stat-bar-fill[data-target-width]').forEach(bar => {
            bar.style.width = bar.dataset.targetWidth;
          });
        }
      });
    }
    const bucketFilters = {
      '1\u20132':  r => r < 3,
      '3\u20134':  r => r >= 3 && r < 5,
      '5\u20136':  r => r >= 5 && r < 7,
      '7\u20138':  r => r >= 7 && r < 9,
      '9\u201310': r => r >= 9,
    };

    statsView.addEventListener('click', e => {
      const ratingRow = e.target.closest('.stat-bar-row[data-bucket]');
      if (ratingRow) {
        if (!parseInt(ratingRow.dataset.count || '0', 10)) return;
        const bucket = ratingRow.dataset.bucket;
        const filterFn = bucketFilters[bucket];
        const gamesForBucket = filterFn
          ? allGames.filter(g => g.user_rating != null && filterFn(g.user_rating))
          : [];
        const n = gamesForBucket.length;
        const label = `Rated ${bucket} \u00b7 ${pluralize(n, 'game')}`;
        function showRatingList() {
          const listEl = buildMonthGameList(label, gamesForBucket,
            game => openGameModal(game, 'view', showRatingList),
            closeModal
          );
          openModal(listEl);
        }
        showRatingList();
        return;
      }

      const barRow = e.target.closest('.stat-bar-row[data-month]');
      if (barRow) {
        if (!parseInt(barRow.dataset.count || '0', 10)) return;
        const month = barRow.dataset.month;
        const type  = barRow.dataset.type;
        let gamesForMonth;
        if (type === 'added') {
          const parts = month.split(' ');
          if (parts.length !== 2) return;
          const [mon, yr] = parts;
          const monthIndex = new Date(`${mon} 1 ${yr}`).getMonth() + 1;
          const target = `${yr}-${String(monthIndex).padStart(2, '0')}`;
          const includeWishlist = statsView.querySelector('#added-wishlist-toggle')?.checked ?? true;
          gamesForMonth = allGames.filter(g =>
            g.date_added && g.date_added.slice(0, 7) === target &&
            (includeWishlist || g.status !== 'wishlist')
          );
        } else {
          const ids = JSON.parse(barRow.dataset.gameIds || '[]');
          gamesForMonth = ids.map(id => allGames.find(g => g.id === id)).filter(Boolean);
        }
        const n = gamesForMonth.length;
        const label = type === 'added'
          ? `${month} · ${pluralize(n, 'game')} added`
          : `${month} · ${pluralize(n, 'game')} played`;
        function showList() {
          const listEl = buildMonthGameList(label, gamesForMonth,
            game => openGameModal(game, 'view', showList),
            closeModal
          );
          openModal(listEl);
        }
        showList();
        return;
      }

      // Heatmap cell drill-down — show games played on that date
      const hmCell = e.target.closest('.hm-cell-clickable[data-date]');
      if (hmCell) {
        const count = parseInt(hmCell.dataset.count || '0', 10);
        if (!count) return;
        const date = hmCell.dataset.date;
        const ids = JSON.parse(hmCell.dataset.gameIds || '[]');
        const gamesForDay = ids.map(id => allGames.find(g => g.id === id)).filter(Boolean);
        const label = `${date} · ${pluralize(count, 'session')}`;
        function showHeatmapList() {
          const listEl = buildMonthGameList(label, gamesForDay,
            game => openGameModal(game, 'view', showHeatmapList),
            closeModal
          );
          openModal(listEl);
        }
        showHeatmapList();
        return;
      }

      // Day-of-week drill-down — show games played on that weekday
      const dowCol = e.target.closest('.stats-dow-col-clickable[data-dow]');
      if (dowCol) {
        const count = parseInt(dowCol.dataset.count || '0', 10);
        if (!count) return;
        const dowLabel = dowCol.dataset.dowLabel;
        const ids = JSON.parse(dowCol.dataset.gameIds || '[]');
        const gamesForDow = ids.map(id => allGames.find(g => g.id === id)).filter(Boolean);
        const label = `${dowLabel}s · ${pluralize(count, 'session')}`;
        function showDowList() {
          const listEl = buildMonthGameList(label, gamesForDow,
            game => openGameModal(game, 'view', showDowList),
            closeModal
          );
          openModal(listEl);
        }
        showDowList();
        return;
      }

      const moreBtn = e.target.closest('.insight-more-btn');
      if (moreBtn) {
        const overflow = moreBtn.previousElementSibling;
        const isOpen = overflow.classList.contains('open');
        if (!isOpen) {
          overflow.style.maxHeight = overflow.scrollHeight + 'px';
          overflow.classList.add('open');
          moreBtn.classList.add('open');
          moreBtn.textContent = 'Show less';
        } else {
          overflow.style.maxHeight = '0';
          overflow.classList.remove('open');
          moreBtn.classList.remove('open');
          moreBtn.textContent = `+${moreBtn.dataset.count} more`;
        }
        return;
      }
      const drilldownEl = e.target.closest('[data-drilldown]');
      if (drilldownEl && !e.target.closest('.insight-game-row, .most-played-item, .recent-session-item')) {
        const drill = drilldownEl.dataset.drilldown;
        state.filterNeverPlayed = false;
        state.filterMechanics = [];
        state.filterCategories = [];
        if (drill === 'owned')         { state.statusFilter = 'owned'; }
        else if (drill === 'wishlist') { state.statusFilter = 'wishlist'; }
        else if (drill === 'never_played') {
          state.statusFilter = 'owned';
          state.filterNeverPlayed = true;
        } else if (drill === 'mechanic') {
          state.statusFilter = 'owned';
          state.filterMechanics = [drilldownEl.dataset.mechanicName];
        }
        syncCollectionUI();
        const neverBtn = document.getElementById('filter-never-played');
        if (neverBtn) neverBtn.classList.toggle('active', state.filterNeverPlayed);
        switchView('collection');
        return;
      }

      // Player leaderboard drill-down — show sessions for that player
      const playerRow = e.target.closest('.player-leaderboard-item[data-player-id]');
      if (playerRow) {
        const playerId = parseInt(playerRow.dataset.playerId, 10);
        const playerName = playerRow.dataset.playerName || 'Player';
        async function showPlayerSessions() {
          try {
            const sessions = await API.getPlayerSessions(playerId);
            const listEl = buildPlayerSessionList(
              playerName,
              sessions,
              (gameId) => {
                const game = allGames.find(g => g.id === gameId) ?? state.games.find(g => g.id === gameId);
                if (game) openGameModal(game, 'view', showPlayerSessions);
              },
              closeModal
            );
            openModal(listEl);
          } catch (err) {
            showToast('Could not load sessions for this player.', 'error');
          }
        }
        showPlayerSessions();
        return;
      }

      const row = e.target.closest('.insight-game-row[data-game-id], .most-played-item[data-game-id], .recent-session-item[data-game-id], .insight-nudge[data-game-id]');
      if (row) {
        const game = allGames.find(g => g.id === parseInt(row.dataset.gameId, 10)) ?? state.games.find(g => g.id === parseInt(row.dataset.gameId, 10));
        if (game) openGameModal(game);
        return;
      }
      // Wishlist insight nudge drilldown
      const wishlistNudge = e.target.closest('.insight-nudge[data-drilldown="wishlist"]');
      if (wishlistNudge) {
        state.statusFilter = 'wishlist';
        syncCollectionUI();
        switchView('collection');
        return;
      }
    });

    // If the user came here via the empty-state "Import from BGG" button, open the
    // settings panel and highlight the Import from BGG row so they know where to go.
    if (_pendingBggHighlight) {
      _pendingBggHighlight = false;
      const settingsBtn   = statsView.querySelector('#stats-settings-btn');
      const settingsPanel = statsView.querySelector('#stats-settings-panel');
      if (settingsBtn && settingsPanel) {
        settingsPanel.style.display = 'block';
        settingsBtn.classList.add('active');
        // Find the "Import from BGG" group by its label text
        const bggGroup = [...statsView.querySelectorAll('.stats-export-group')].find(
          g => g.querySelector('.stats-export-label')?.textContent.trim() === 'Import from BGG'
        );
        if (bggGroup) {
          bggGroup.scrollIntoView({ behavior: 'smooth', block: 'center' });
          bggGroup.classList.add('highlight');
          bggGroup.addEventListener('animationend', () => bggGroup.classList.remove('highlight'), { once: true });
        }
      }
    }
  }

  function _injectMilestonesIntoGrid(statsView, prefs) {
    const milestonesEl = buildMilestonesSection(
      loadMilestones(),
      (gameId) => { const g = state.games.find(g => g.id === gameId); if (g) openGameModal(g); },
      () => saveMilestones([]),
    );
    milestonesEl.dataset.section = 'milestones';
    if (prefs.show_milestones === false) milestonesEl.style.display = 'none';
    const sectionsGrid = statsView.querySelector('#stats-sections');
    const order = prefs.section_order;
    const milIdx = order.indexOf('milestones');
    const nextKey = milIdx >= 0 ? order[milIdx + 1] : undefined;
    const nextEl = nextKey ? sectionsGrid.querySelector(`[data-section="${nextKey}"]`) : null;
    sectionsGrid.insertBefore(milestonesEl, nextEl); // insertBefore(el, null) === appendChild
  }

  function _animateStatBars(_container) {
    // Bar animation is now handled by IntersectionObserver in buildStatsView (ui.js)
  }


  async function _prefetchStats() {
    const statsContent = document.getElementById('stats-content');
    if (!statsContent || _statsLoading || _statsPrefetched || _statsPrefetchInFlight) return;
    if (statsContent.children.length > 0 && !statsContent.querySelector('.loading-spinner')) return;
    _statsPrefetchInFlight = true;
    try {
      const [stats, goals] = await Promise.all([
        API.getStats(),
        API.checkGoals().then(() => API.getGoals()).catch(() => []),
      ]);
      _statsPrefetched = { stats, goals };
    } catch (_) {
      _statsPrefetched = null;
    } finally {
      _statsPrefetchInFlight = false;
    }
  }

  const PREV_STATS_KEY = 'cardboard_prev_stats';
  function _loadPrevStats() {
    const data = loadJsonFromStorage(PREV_STATS_KEY, null);
    // Only use if less than 7 days old
    if (!data || Date.now() - data._storedAt > 7 * 86400000) return null;
    return data.stats;
  }
  function _savePrevStats(stats) {
    saveJsonToStorage(PREV_STATS_KEY, { stats, _storedAt: Date.now() });
  }
  const STAT_DELTA_METRICS = {
    total_games:    s => s.total_games || 0,
    owned:          s => s.by_status?.owned || 0,
    wishlist:       s => s.by_status?.wishlist || 0,
    total_sessions: s => s.total_sessions || 0,
    total_hours:    s => s.total_hours || 0,
    never_played:   s => s.never_played_count || 0,
  };
  function _computeStatDeltas(curr, prev) {
    const d = {};
    for (const [key, get] of Object.entries(STAT_DELTA_METRICS)) {
      const diff = get(curr) - get(prev);
      if (key === 'total_hours') {
        if (Math.abs(diff) >= 0.1) d[key] = +diff.toFixed(1);
      } else if (diff !== 0) {
        d[key] = diff;
      }
    }
    return Object.keys(d).length ? d : null;
  }

  // Render + wire the stats view into #stats-content (shared by all stats paths)
  function _renderStatsView(stats, goals) {
    const prefs = loadStatsPrefs();
    const prevStats = _loadPrevStats();
    const deltas = prevStats ? _computeStatDeltas(stats, prevStats) : null;
    const el = document.getElementById('stats-content');
    el.innerHTML = '';
    const statsView = buildStatsView(stats, [], prefs, saveStatsPrefs, goals, deltas);
    el.appendChild(statsView);
    wireStatsView(statsView, stats);
    wireGoalsSection(statsView, { reloadStats: loadStats });
    _injectMilestonesIntoGrid(statsView, prefs);
    _animateStatBars(el);
  }

  async function loadStats() {
    _statsLoading = true;
    const el = document.getElementById('stats-content');

    // Use prefetched data if available
    if (_statsPrefetched) {
      const { stats, goals } = _statsPrefetched;
      _statsPrefetched = null;
      _renderStatsView(stats, goals);
      _statsLoading = false;
      return;
    }

    el.innerHTML = '<div class="loading-spinner"><div class="spinner"></div><p>Loading statistics…</p></div>';
    try {
      const [stats, goals] = await Promise.all([
        API.getStats(),
        API.checkGoals().then(() => API.getGoals()).catch(() => []),
      ]);
      _renderStatsView(stats, goals);
      _savePrevStats(stats);
    } catch (err) {
      el.innerHTML = `<div class="loading-spinner">
        <p style="color:var(--danger);margin-bottom:0.75rem">Failed to load stats: ${escapeHtml(classifyError(err))}</p>
        <button class="btn btn-secondary" id="stats-retry-btn">Retry</button>
      </div>`;
      const _statsRetryBtn = document.getElementById('stats-retry-btn');
      if (_statsRetryBtn) _statsRetryBtn.addEventListener('click', loadStats, { once: true });
    } finally {
      _statsLoading = false;
    }
  }

  async function refreshCollectionStats() {
    API.invalidateCollectionEtag();
    try {
      const fresh = await API.getCollectionStats();
      if (fresh !== null) state.collectionStats = fresh;
    } catch (_) { /* non-fatal */ }
  }

  async function refreshStatsBackground() {
    if (_statsLoading) return;
    if (!document.getElementById('view-stats')?.classList.contains('active')) return;
    try {
      const [stats, goals] = await Promise.all([
        API.getStats(),
        API.checkGoals().then(() => API.getGoals()).catch(() => []),
      ]);
      _renderStatsView(stats, goals);
    } catch (_) { /* non-fatal */ }
  }

  // ===== Share Management =====
  async function updateShareBadge() {
    const shareBtn = document.getElementById('share-btn');
    if (!shareBtn) return;
    try {
      const reqs = await API.getWantToPlayRequests();
      const unseen = reqs.filter(r => !r.seen).length;
      let badge = shareBtn.querySelector('.share-notif-badge');
      if (unseen > 0) {
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'share-notif-badge';
          shareBtn.style.position = 'relative';
          shareBtn.appendChild(badge);
        }
        badge.textContent = unseen;
      } else if (badge) {
        badge.remove();
      }
    } catch (_) { /* non-fatal */ }
  }

  async function openShareManageModal() {
    let tokens = [];
    let requests = [];
    let fetchError = false;
    try {
      [tokens, requests] = await Promise.all([
        API.getShareTokens().catch(() => { fetchError = true; return []; }),
        API.getWantToPlayRequests().catch(() => []),
      ]);
    } catch (_) { fetchError = true; }

    function formatExpiry(t) {
      if (!t.expires_at) return '<span class="share-token-expiry never">Never expires</span>';
      const exp = new Date(t.expires_at);
      const now = new Date();
      if (exp <= now) return '<span class="share-token-expiry expired">Expired</span>';
      const diffMin = Math.round((exp - now) / 60000);
      if (diffMin < 1) return '<span class="share-token-expiry expiring">Expires in &lt;1 min</span>';
      if (diffMin < 60) return `<span class="share-token-expiry expiring">Expires in ${diffMin} min</span>`;
      const diffHrs = Math.round(diffMin / 60);
      return `<span class="share-token-expiry">Expires in ${diffHrs}h</span>`;
    }

    function isExpired(t) {
      return t.expires_at && new Date(t.expires_at) <= new Date();
    }

    function renderTokenList(container, list) {
      if (!list.length) {
        container.innerHTML = '<p class="share-empty">No share links yet. Create one below to share your collection.</p>';
        return;
      }
      const origin = window.location.origin;
      container.innerHTML = list.map(t => {
        const rawToken = localStorage.getItem(`share_token_${t.token}`);
        const shareUrl = rawToken ? `${origin}/share.html#token=${rawToken}` : '';
        const placeholder = rawToken ? '' : ' placeholder="Token not available — created in another session"';
        const copyDisabled = rawToken ? '' : ' disabled';
        return `
        <div class="share-token-row${isExpired(t) ? ' expired' : ''}" data-token="${escapeHtml(t.token)}">
          <div class="share-token-info">
            <div class="share-token-header">
              <span class="share-token-label">${escapeHtml(t.label || 'Untitled')}</span>
              ${t.created_at ? `<span class="share-token-created">Created ${escapeHtml(formatDate(t.created_at))}</span>` : ''}
              ${formatExpiry(t)}
            </div>
            <input class="share-link-input" type="text" readonly value="${escapeHtml(shareUrl)}" aria-label="Share link"${placeholder}>
          </div>
          <div class="share-token-actions">
            <button class="btn btn-secondary btn-sm share-copy-btn"${isExpired(t) ? ' disabled' : copyDisabled}>Copy</button>
            <button class="btn btn-danger btn-sm share-revoke-btn">Revoke</button>
          </div>
        </div>`;
      }).join('');

      container.querySelectorAll('.share-copy-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const input = btn.closest('.share-token-row').querySelector('.share-link-input');
          const url = input.value;
          if (navigator.clipboard) {
            navigator.clipboard.writeText(url).then(() => showToast('Link copied!', 'success')).catch(() => {
              const ta = Object.assign(document.createElement('textarea'), { value: url, style: 'position:fixed;opacity:0' });
              document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
              showToast('Link copied!', 'success');
            });
          } else {
            const ta = Object.assign(document.createElement('textarea'), { value: url, style: 'position:fixed;opacity:0' });
            document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
            showToast('Link copied!', 'success');
          }
        });
      });
      container.querySelectorAll('.share-revoke-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const row = btn.closest('.share-token-row');
          const token = row.dataset.token;
          const expired = row.classList.contains('expired');
          const msg = expired
            ? 'Remove this expired link?'
            : 'This will break anyone currently using this link. Continue?';
          const ok = await showConfirm('Revoke Link', msg, { confirmLabel: 'Revoke' });
          if (!ok) return;
          try {
            await withLoading(btn, async () => {
              await API.deleteShareToken(token);
              localStorage.removeItem(`share_token_${token}`);
              tokens = tokens.filter(t => t.token !== token);
              renderTokenList(container, tokens);
              showToast('Share link removed.', 'success');
            }, '…');
          } catch (err) {
            showToast(`Failed to revoke link: ${classifyError(err)}`, 'error');
          }
        });
      });
    }

    const unseenCount = requests.filter(r => !r.seen).length;

    function timeAgo(isoStr) {
      const diff = Date.now() - new Date(isoStr).getTime();
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return 'just now';
      if (mins < 60) return `${mins}m ago`;
      const hrs = Math.floor(mins / 60);
      if (hrs < 24) return `${hrs}h ago`;
      return `${Math.floor(hrs / 24)}d ago`;
    }

    const el = document.createElement('div');
    el.className = 'share-manage-panel';
    el.innerHTML = `
      <div class="share-modal-hero">
        <div class="share-modal-hero-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="32" height="32">
            <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
          </svg>
        </div>
        <div class="share-modal-hero-text">
          <h2 id="modal-title">Share Collection</h2>
          <p>Share your collection via live link or download a PDF.</p>
        </div>
        <button class="modal-close" id="share-modal-close" aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="18" height="18"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="share-modal-tabs" role="tablist" aria-label="Share management sections">
        <button class="share-tab active" data-tab="links" role="tab" id="share-tab-btn-links" aria-selected="true" aria-controls="share-tab-links">Links</button>
        <button class="share-tab" data-tab="requests" role="tab" id="share-tab-btn-requests" aria-selected="false" aria-controls="share-tab-requests">Requests${unseenCount > 0 ? ` <span class="share-req-badge" aria-label="${unseenCount} unseen">${unseenCount}</span>` : ''}</button>
      </div>
      <div class="modal-body">
        <div id="share-tab-links" role="tabpanel" aria-labelledby="share-tab-btn-links">
          <div class="share-token-list" id="share-token-list"></div>
          <div class="share-create-section">
            <div class="section-label">New Link</div>
            <div class="share-create-row">
              <input type="text" id="share-label-input" class="form-input" placeholder="Label (optional)">
              <select id="share-expiry-select" class="select">
                <option value="">Never</option>
                <option value="10">10 min</option>
                <option value="30">30 min</option>
                <option value="60">60 min</option>
              </select>
              <button class="btn btn-primary" id="share-create-btn">Create Link</button>
            </div>
          </div>
          <div class="share-export-section">
            <div class="section-label">PDF Export</div>
            <p class="share-export-desc">Download a PDF with your entire collection — includes cover image, title, description, difficulty, playtime, and player count for each game.</p>
            <button class="btn btn-secondary" id="share-export-pdf-btn">Download PDF</button>
          </div>
        </div>
        <div id="share-tab-requests" style="display:none" role="tabpanel" aria-labelledby="share-tab-btn-requests">
          <div id="share-requests-list"></div>
        </div>
      </div>`;

    el.querySelector('#share-modal-close').addEventListener('click', (e) => { e.stopPropagation(); closeModal(); });

    // PDF export button in share modal
    const staticExportBtn = el.querySelector('#share-export-pdf-btn');
    if (staticExportBtn) {
      staticExportBtn.addEventListener('click', () => {
        window.location.href = '/api/games/export/pdf';
        closeModal();
      });
    }

    // Tab switching
    const _shareTabs = Array.from(el.querySelectorAll('.share-tab'));
    _shareTabs.forEach((tab, i) => { tab.setAttribute('tabindex', i === 0 ? '0' : '-1'); });
    function _activateTab(target) {
      _shareTabs.forEach(t => {
        const isActive = t === target;
        t.classList.toggle('active', isActive);
        t.setAttribute('aria-selected', isActive ? 'true' : 'false');
        t.setAttribute('tabindex', isActive ? '0' : '-1');
        const tgt = t.dataset.tab;
        el.querySelector('#share-tab-links').style.display = tgt === 'links' ? '' : 'none';
        el.querySelector('#share-tab-requests').style.display = tgt === 'requests' ? '' : 'none';
      });
      target.focus();
    }
    _shareTabs.forEach(tab => {
      tab.addEventListener('click', () => _activateTab(tab));
      tab.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          const idx = _shareTabs.indexOf(tab);
          const next = e.key === 'ArrowRight' ? (idx + 1) % _shareTabs.length : (idx - 1 + _shareTabs.length) % _shareTabs.length;
          _activateTab(_shareTabs[next]);
        } else if (e.key === 'Home') {
          e.preventDefault(); _activateTab(_shareTabs[0]);
        } else if (e.key === 'End') {
          e.preventDefault(); _activateTab(_shareTabs[_shareTabs.length - 1]);
        }
      });
    });

    // Render requests
    function renderRequests(container, list) {
      if (!list.length) {
        container.innerHTML = '<p class="share-empty">No "Want to Play" requests yet.</p>';
        return;
      }
      container.innerHTML = list.map(r => `
        <div class="share-request-row${r.seen ? ' seen' : ''}" data-id="${r.id}">
          <div class="share-request-info">
            <div class="share-request-game">${escapeHtml(r.game_name)}</div>
            <div class="share-request-from">${escapeHtml(r.visitor_name || 'Anonymous')} · <span class="share-request-time">${escapeHtml(timeAgo(r.created_at))}</span></div>
            ${r.message ? `<div class="share-request-message">${escapeHtml(r.message)}</div>` : ''}
          </div>
          <div class="share-request-actions">
            ${!r.seen ? `<button class="btn btn-ghost btn-sm share-seen-btn">Mark seen</button>` : '<span class="share-seen-label">Seen</span>'}
            <button class="btn btn-ghost btn-sm share-delete-btn" title="Delete request" aria-label="Delete request">✕</button>
          </div>
        </div>`).join('');
      container.querySelectorAll('.share-seen-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const row = btn.closest('.share-request-row');
          const id = parseInt(row.dataset.id, 10);
          try {
            await withLoading(btn, async () => {
              await API.markRequestSeen(id);
              const req = requests.find(r => r.id === id);
              if (req) req.seen = true;
              row.classList.add('seen');
              btn.replaceWith(Object.assign(document.createElement('span'), { className: 'share-seen-label', textContent: 'Seen' }));
              // Remove badge from tab if all seen
              const remaining = requests.filter(r => !r.seen).length;
              const badge = el.querySelector('.share-req-badge');
              if (badge) { if (remaining > 0) { badge.textContent = remaining; badge.setAttribute('aria-label', `${remaining} unseen`); } else badge.remove(); }
              updateShareBadge();
            }, '…');
          } catch (_) { /* non-fatal */ }
        });
      });
      container.querySelectorAll('.share-delete-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const row = btn.closest('.share-request-row');
          const id = parseInt(row.dataset.id, 10);
          try {
            await withLoading(btn, async () => {
              await API.deleteRequest(id);
              requests = requests.filter(r => r.id !== id);
              row.remove();
              if (!requests.length) {
                renderRequests(container, requests);
              }
              const remaining = requests.filter(r => !r.seen).length;
              const badge = el.querySelector('.share-req-badge');
              if (badge) { if (remaining > 0) { badge.textContent = remaining; badge.setAttribute('aria-label', `${remaining} unseen`); } else badge.remove(); }
              updateShareBadge();
            }, '…');
          } catch (_) { /* non-fatal */ }
        });
      });
    }
    renderRequests(el.querySelector('#share-requests-list'), requests);

    const tokenListEl = el.querySelector('#share-token-list');
    if (fetchError) {
      tokenListEl.innerHTML = '<p class="share-empty" style="color:var(--danger)">Could not load share links. Check your connection and try again.</p>';
    } else {
      renderTokenList(tokenListEl, tokens);
    }

    el.querySelector('#share-create-btn').addEventListener('click', async () => {
      const label = el.querySelector('#share-label-input').value.trim() || null;
      const expiresIn = el.querySelector('#share-expiry-select').value || null;
      const btn = el.querySelector('#share-create-btn');
      try {
        await withLoading(btn, async () => {
          const newToken = await API.createShareToken(label, expiresIn);
          if (newToken.token_hash) {
            localStorage.setItem(`share_token_${newToken.token_hash}`, newToken.token);
          }
          tokens.push({
            token: newToken.token_hash || newToken.token,
            label: newToken.label,
            created_at: newToken.created_at,
            expires_at: newToken.expires_at,
          });
          renderTokenList(tokenListEl, tokens);
          el.querySelector('#share-label-input').value = '';
          el.querySelector('#share-expiry-select').value = '';
          showToast('Share link created!', 'success');
        }, 'Creating…');
      } catch (err) {
        showToast(`Failed to create link: ${classifyError(err)}`, 'error');
      }
    });

    openModal(el);
  }

  // ===== Undo Toast =====
  function showUndoToast(message, onUndo, duration = 5000) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast toast-success toast-undo';
    const seconds = Math.round(duration / 1000);
    toast.innerHTML = `<span class="toast-msg">${escapeHtml(message)}</span><button class="toast-undo-btn">Undo (${seconds}s)</button>`;
    container.appendChild(toast);

    let remaining = seconds;
    const undoBtn = toast.querySelector('.toast-undo-btn');
    const countdown = setInterval(() => {
      remaining -= 1;
      if (remaining >= 0) undoBtn.textContent = `Undo (${remaining}s)`;
    }, 1000);

    let timer = setTimeout(dismiss, duration);

    function dismiss() {
      clearTimeout(timer);
      clearInterval(countdown);
      _hideToast(toast);
    }

    undoBtn.addEventListener('click', () => {
      dismiss();
      onUndo();
    });
  }

  // ===== Pause Mode =====
  const PAUSE_MODE_KEY = 'cardboard_pause_mode';
  const pauseBtn = document.getElementById('pause-mode-btn');
  const pauseBanner = document.getElementById('pause-banner');
  const pauseResume = document.getElementById('pause-banner-resume');

  function _isPauseMode() {
    return localStorage.getItem(PAUSE_MODE_KEY) === 'true';
  }

  function _syncPauseUI() {
    const paused = _isPauseMode();
    if (pauseBtn) {
      pauseBtn.classList.toggle('active', paused);
      pauseBtn.setAttribute('title', paused ? 'Resume streak & heat tracking' : 'Pause streak tracking for vacations/breaks');
    }
    if (pauseBanner) {
      pauseBanner.style.display = paused ? 'flex' : 'none';
    }
  }

  function _setPauseMode(paused) {
    localStorage.setItem(PAUSE_MODE_KEY, paused ? 'true' : 'false');
    _syncPauseUI();
    API.setSetting(PAUSE_MODE_KEY, paused ? 'true' : '').catch(() => {});
  }

  if (pauseBtn) {
    pauseBtn.addEventListener('click', () => {
      const paused = !_isPauseMode();
      _setPauseMode(paused);
      showToast(paused ? 'Tracking paused. Streaks and heat are frozen.' : 'Tracking resumed.', 'info');
    });
  }

  if (pauseResume) {
    pauseResume.addEventListener('click', () => {
      _setPauseMode(false);
      showToast('Tracking resumed.', 'info');
    });
  }

  _syncPauseUI();

  document.getElementById('retake-tour-btn')?.addEventListener('click', resetTour);

  // ── Notifications ────────────────────────────────────────────────────────
  let _notifState = { notifications: [], dropdownOpen: false };

  const _NOTIF_ICONS = {
    dormant_favorite: '📅',
    unplayed_owned: '📦',
    goal_progress: '🎯',
    stale_collection: '⏰',
    streak_risk: '🔥',
    loan_overdue: '📤',
  };

  function _renderNotifications() {
    const body = document.getElementById('notif-dropdown-body');
    const empty = document.getElementById('notif-dropdown-empty');
    if (!body || !empty) return;
    body.innerHTML = '';
    if (_notifState.notifications.length === 0) {
      empty.style.display = 'block';
      body.style.display = 'none';
      return;
    }
    empty.style.display = 'none';
    body.style.display = 'block';
    for (const n of _notifState.notifications) {
      const item = document.createElement('div');
      item.className = 'notif-item' + (n.read_at ? '' : ' unread');
      const icon = _NOTIF_ICONS[n.kind] || '🔔';
      const timeStr = n.created_at ? new Date(n.created_at).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) : '';
      item.innerHTML = `
        <div class="notif-item-icon">${icon}</div>
        <div class="notif-item-content">
          <div class="notif-item-title">${escapeHtml(n.title)}</div>
          ${n.body ? `<div class="notif-item-body">${escapeHtml(n.body)}</div>` : ''}
          <div class="notif-item-time">${timeStr}</div>
          <div class="notif-item-actions">
            ${n.read_at ? '' : `<button class="notif-mark-read" data-id="${n.id}">Mark read</button>`}
            ${n.action_url ? `<button class="notif-open" data-url="${escapeHtml(n.action_url)}">Open</button>` : ''}
            <button class="notif-delete" data-id="${n.id}">Delete</button>
          </div>
        </div>`;
      body.appendChild(item);
    }
    body.querySelectorAll('.notif-mark-read').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = parseInt(btn.dataset.id, 10);
        try {
          await API.markNotificationRead(id);
          _notifState.notifications = _notifState.notifications.map(n =>
            n.id === id ? { ...n, read_at: new Date().toISOString() } : n
          );
          _renderNotifications();
          _updateNotifBadge();
        } catch (err) { console.warn('Failed to mark notification read:', err); }
      });
    });
    body.querySelectorAll('.notif-delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = parseInt(btn.dataset.id, 10);
        try {
          await API.deleteNotification(id);
          _notifState.notifications = _notifState.notifications.filter(n => n.id !== id);
          _renderNotifications();
          _updateNotifBadge();
        } catch (err) { console.warn('Failed to delete notification:', err); }
      });
    });
    body.querySelectorAll('.notif-open').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const url = btn.dataset.url;
        if (url) {
          _closeNotifDropdown();
          if (url.startsWith('/game/')) {
            const gid = parseInt(url.split('/game/')[1], 10);
            if (!isNaN(gid)) {
              const g = state.games.find(x => x.id === gid);
              if (g) openGameModal(g);
              else switchView('collection');
            }
          } else if (url.includes('view=stats')) {
            switchView('stats');
          } else if (url.includes('view=add')) {
            switchView('add');
          } else {
            switchView('collection');
          }
        }
      });
    });
  }

  function _updateNotifBadge() {
    const badge = document.getElementById('nav-bell-badge');
    if (!badge) return;
    const unread = _notifState.notifications.filter(n => !n.read_at).length;
    if (unread > 0) {
      badge.textContent = unread > 99 ? '99+' : String(unread);
      badge.style.display = 'flex';
    } else {
      badge.style.display = 'none';
    }
  }

  function _closeNotifDropdown() {
    const dropdown = document.getElementById('notif-dropdown');
    const bell = document.getElementById('nav-bell');
    if (dropdown) dropdown.style.display = 'none';
    if (bell) bell.setAttribute('aria-expanded', 'false');
    _notifState.dropdownOpen = false;
  }

  async function _loadNotifications() {
    try {
      _notifState.notifications = await API.refreshNotifications();
      _renderNotifications();
      _updateNotifBadge();
    } catch (err) {
      console.warn('Failed to load notifications:', err);
    }
  }

  function bindNotifications() {
    const bell = document.getElementById('nav-bell');
    const dropdown = document.getElementById('notif-dropdown');
    const readAllBtn = document.getElementById('notif-read-all');
    if (!bell || !dropdown) return;

    bell.addEventListener('click', (e) => {
      e.stopPropagation();
      _notifState.dropdownOpen = !_notifState.dropdownOpen;
      dropdown.style.display = _notifState.dropdownOpen ? 'flex' : 'none';
      bell.setAttribute('aria-expanded', String(_notifState.dropdownOpen));
      if (_notifState.dropdownOpen && _notifState.notifications.length === 0) {
        _loadNotifications();
      }
    });

    document.addEventListener('click', (e) => {
      if (_notifState.dropdownOpen && !dropdown.contains(e.target) && !bell.contains(e.target)) {
        _closeNotifDropdown();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && _notifState.dropdownOpen) _closeNotifDropdown();
    });

    if (readAllBtn) {
      readAllBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await API.markAllNotificationsRead();
          _notifState.notifications = _notifState.notifications.map(n => ({ ...n, read_at: new Date().toISOString() }));
          _renderNotifications();
          _updateNotifBadge();
        } catch (err) { console.warn('Failed to mark all read:', err); }
      });
    }

    _loadNotifications();
  }

})();
