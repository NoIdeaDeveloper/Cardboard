/**
 * Cardboard – main application logic
 */

import { state, saveCollectionPrefs, NO_LOCATION_SENTINEL } from './app/state.js';
import { sortGames } from './app/sort.js';
import { SERVER_PAGE_SIZE, buildFilterParams, hasActiveFilters, _activeFilterCount } from './app/filters.js';
import { classifyError } from './app/errors.js';

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
      if (['grid', 'list'].includes(v)) state.viewMode = v;
    }
    if (params.has('never_played')) state.filterNeverPlayed = true;
    if (params.has('players')) state.filterPlayers = parseInt(params.get('players'), 10) || null;
    if (params.has('time')) state.filterTime = parseInt(params.get('time'), 10) || null;
    if (params.has('mechanics')) state.filterMechanics = params.get('mechanics').split(',').filter(Boolean);
    if (params.has('categories')) state.filterCategories = params.get('categories').split(',').filter(Boolean);
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
      container.innerHTML = `
        ${thumb}
        <div class="recommend-body">
          <p class="recommend-title">${escapeHtml(g.name)}</p>
          <p class="recommend-meta">${g.player_count ? escapeHtml(g.player_count) + ' players' : ''}${g.player_count && g.playtime ? ' \u2022 ' : ''}${g.playtime ? g.playtime + ' min' : ''}</p>
          <p class="recommend-reason">${escapeHtml(rec.reason_detail)}</p>
        </div>
        <div class="recommend-actions">
          <button class="recommend-btn" data-recommend-play="${g.id}">Play</button>
          <button class="recommend-btn secondary" data-recommend-skip="${g.id}">Not Now</button>
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

  // ===== Error Classification =====

  // ===== Init =====
  function syncCollectionUI() {
    const sortByEl   = document.getElementById('sort-by');
    const sortDirBtn = document.getElementById('sort-dir');
    const gridBtn    = document.getElementById('view-grid');
    const listBtn    = document.getElementById('view-list');

    if (sortByEl) sortByEl.value = state.sortBy;

    if (sortDirBtn) {
      sortDirBtn.dataset.dir = state.sortDir;
      sortDirBtn.setAttribute('data-tooltip', state.sortDir === 'asc' ? 'Sort ascending' : 'Sort descending');
      const _svg = sortDirBtn.querySelector('svg');
      if (_svg) _svg.style.transform = state.sortDir === 'desc' ? 'scaleY(-1)' : '';
    }

    if (gridBtn) gridBtn.classList.toggle('active', state.viewMode === 'grid');
    if (listBtn) listBtn.classList.toggle('active', state.viewMode === 'list');

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
    wireTagInputs();
    bindModalBackdrop();
    bindKeyboardShortcuts();
    bindShortcutsOverlay();
    bindThemeToggle();
    bindGameNightModal();
    bindPlayersModal();
    bindExportModal();
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
      saveCollectionPrefs();
      syncUrlParams();
      renderCollection();
    });

    listBtn.addEventListener('click', () => {
      state.viewMode = 'list';
      listBtn.classList.add('active');
      gridBtn.classList.remove('active');
      saveCollectionPrefs();
      syncUrlParams();
      renderCollection();
    });

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

  function wireTagInputs() {
    TAG_FIELDS.forEach(field => {
      const input = document.getElementById(`m-${field}`);
      if (!input || input.dataset.tagWired) return;
      input.dataset.tagWired = '1';
      input.addEventListener('input', function () {
        const dl = document.getElementById(this.getAttribute('list'));
        if (!dl) return;
        const options = new Set([...dl.options].map(o => o.value));
        const val = this.value;
        if (options.has(val)) {
          // Datalist replaced the entire field — prepend stored prefix
          const pfx = this.dataset.tagPrefix || '';
          this.value = pfx ? pfx + val : val;
          return;
        }
        // Normal typing — refresh prefix (everything up to and including last comma)
        const commaIdx = val.lastIndexOf(',');
        this.dataset.tagPrefix = commaIdx !== -1 ? val.slice(0, commaIdx + 1) + ' ' : '';
      });
    });
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
      renderReminderBanner();
      loadRecommendCard();
      renderActionPlan();
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
          <h2>Log Session for ${ids.length} Games</h2>
          <button class="modal-close" id="bulk-session-close" aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="18" height="18"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="form-group">
              <label class="form-label" for="bs-date">Date</label>
              <input type="date" id="bs-date" class="form-input" value="${new Date().toLocaleDateString('en-CA')}">
            </div>
            <div class="form-group">
              <label class="form-label" for="bs-duration">Duration (min)</label>
              <input type="number" id="bs-duration" class="form-input" min="1" placeholder="Optional">
            </div>
          </div>
          <div class="form-group" style="margin-top:12px">
            <label class="form-label" for="bs-notes">Notes</label>
            <textarea id="bs-notes" class="form-textarea" rows="2" placeholder="Optional"></textarea>
          </div>
          <button class="btn btn-primary" id="bs-submit" style="margin-top:16px;width:100%">Log Session</button>
        </div>
      </div>`;
    openModal(inner);
    inner.querySelector('#bulk-session-close').addEventListener('click', closeModal);
    inner.querySelector('#bs-submit').addEventListener('click', async () => {
      const body = {
        game_ids: ids,
        played_at: document.getElementById('bs-date').value,
        duration_minutes: parseInt(document.getElementById('bs-duration').value, 10) || undefined,
        notes: document.getElementById('bs-notes').value.trim() || undefined,
      };
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
    const confirmed = await showConfirm(`Delete ${pluralize(n, 'Selected Game')}`, `Delete ${pluralize(n, 'selected game')}?`);
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
      return;
    }
    const parts = [];
    if (state.filterNeverPlayed) parts.push('Never Played');
    if (state.filterPlayers !== null) parts.push(`${state.filterPlayers} players`);
    if (state.filterTime !== null) parts.push(`≤ ${state.filterTime} min`);
    if (state.filterMechanics.length > 0) parts.push(pluralize(state.filterMechanics.length, 'mechanic'));
    if (state.filterCategories.length > 0) parts.push(pluralize(state.filterCategories.length, 'category', 'categories'));
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

      // Auto-navigate to Add view when searching for a game not in collection
      if (state.search && !filtersActive) {
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
        return;
      }

      // Build tab-specific empty message
      let emptyMessage = 'No games match your filters.';
      if (!filtersActive && !state.search) {
        // This is an empty status tab (wishlist, owned, sold)
        const tabLabels = { owned: 'owned', wishlist: 'wishlist', sold: 'sold' };
        const tabName = tabLabels[state.statusFilter] || state.statusFilter;
        emptyMessage = `No ${tabName} games yet.`;
      }

      const actionBtn = filtersActive
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
        <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center">${actionBtn}</div>
      </div>`;
      document.getElementById('no-results-clear-filters')?.addEventListener('click', () => {
        document.getElementById('filter-clear-all')?.click();
      });
      renderRecentlyPlayedShelf();
      return;
    }

    renderRecentlyPlayedShelf();

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
      // Separate persistent observer to pause/resume heat-pulse animation
      const heatIo = new IntersectionObserver(entries => {
        entries.forEach(e => e.target.classList.toggle('in-view', e.isIntersecting));
      }, { threshold: 0.01 });
      cards.forEach((c, i) => {
        c.dataset.observed = '1';
        c.style.transitionDelay = `${Math.min(i * 28, 250)}ms`;
        io.observe(c);
        if (c.dataset.heat === '3') heatIo.observe(c);
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
      let permanent = tokens.find(t => !t.expires_at);
      if (!permanent) {
        permanent = await API.createShareToken('My Collection', null);
      }
      return `${window.location.origin}/share.html?token=${permanent.token}&game=${game.id}`;
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

    const contentEl = buildModalContent(
      game, sessions,
      handleSaveGame, handleDeleteGame,
      handleAddSession, handleDeleteSession, handleUpdateSession,
      handleUploadInstructions, handleDeleteInstructions,
      handleUploadImage, handleDeleteImage,
      images,
      handleUploadGalleryImage, handleDeleteGalleryImage, handleReorderGalleryImages,
      handleAddGalleryImageFromUrl,
      handleUpdateGalleryImageCaption,
      effectiveMode, onSwitchToEdit, onSwitchToView,
      state.games,
      (targetGame) => openGameModal(targetGame, 'view', () => openGameModal(game, 'view', onBack)),
      onShareGame,
      () => { activeModal = null; closeModal(); },
      navInfo,
    );

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
    const popover = document.createElement('div');
    popover.className = 'ql-compact-popover';
    popover.innerHTML = `
      <div class="ql-compact-header">
        <span class="ql-compact-game">${escapeHtml(game.name)}</span>
      </div>
      <div class="ql-compact-fields">
        <div class="ql-compact-row">
          <label class="ql-compact-label">Date</label>
          <input type="date" class="ql-compact-input" id="qlc-date" value="${todayStr}" autocomplete="off">
        </div>
        <div class="ql-compact-row">
          <label class="ql-compact-label">Rating</label>
          <div class="star-picker ql-compact-stars" id="qlc-rating" data-value="0">
            ${[1,2,3,4,5].map(n => `<button type="button" class="star-btn star-btn-sm" data-val="${n}" title="${n} star${n>1?'s':''}"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><polygon points="8 1.5 10 5.5 14.5 6.1 11.2 9.2 12 13.7 8 11.6 4 13.7 4.8 9.2 1.5 6.1 6 5.5"/></svg></button>`).join('')}
          </div>
        </div>
        <div class="ql-compact-row">
          <label class="ql-compact-label">Duration</label>
          <input type="number" class="ql-compact-input" id="qlc-duration" min="1" placeholder="min" autocomplete="off">
        </div>
      </div>
      <div class="ql-compact-actions">
        <button class="btn btn-primary btn-sm" id="qlc-submit">Log it</button>
        <button class="btn btn-ghost btn-sm" id="qlc-more">More</button>
      </div>
      <button class="ql-compact-close" id="qlc-close" aria-label="Close">&times;</button>
    `;

    document.body.appendChild(popover);

    const ac = new AbortController();
    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      ac.abort();
      popover.classList.remove('open');
      setTimeout(() => popover.remove(), 180);
    }

    function onKeyDown(e) {
      if (e.key === 'Escape') close();
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
      if (top < 60) {
        top = anchorRect.bottom + gap;
      }
      popover.style.left = left + 'px';
      popover.style.top = top + 'px';
    } else {
      popover.classList.add('ql-compact-centered');
    }
    requestAnimationFrame(() => popover.classList.add('open'));

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
    const overlay = document.createElement('div');
    overlay.className = 'quick-log-overlay';
    overlay.innerHTML = `
      <div class="quick-log-backdrop"></div>
      <div class="quick-log-popup">
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
            <label>Session Rating</label>
            <div class="star-picker" id="ql-rating-picker" data-value="0">
              ${[1,2,3,4,5].map(n => `<button type="button" class="star-btn" data-val="${n}" title="${n} star${n>1?'s':''}">★</button>`).join('')}
            </div>
          </div>
          <div class="quick-log-field ql-full">
            <label class="inline-toggle" style="cursor:pointer">
              <input type="checkbox" id="ql-solo"> Solo game
            </label>
          </div>
          <div id="ql-multiplayer-fields">
            <div class="quick-log-field ql-full">
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
            <div id="ql-scores-section" style="display:none">
              <div class="quick-log-field ql-full">
                <label>Scores (optional)</label>
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
    overlay.querySelector('#ql-date').focus();

    function close() {
      document.removeEventListener('keydown', onKeyDown);
      overlay.classList.remove('open');
      setTimeout(() => { overlay.remove(); popModalOpen(); }, 200);
    }

    function onKeyDown(e) {
      if (e.key === 'Escape') { close(); }
    }

    overlay.querySelector('.quick-log-backdrop').addEventListener('click', close);
    overlay.querySelector('#ql-cancel').addEventListener('click', close);
    document.addEventListener('keydown', onKeyDown);

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

    // Solo mode toggle
    const soloCheckbox = overlay.querySelector('#ql-solo');
    const multiplayerFields = overlay.querySelector('#ql-multiplayer-fields');
    soloCheckbox.addEventListener('change', () => {
      multiplayerFields.style.display = soloCheckbox.checked ? 'none' : '';
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
      if (!allNames.length) { scoresSection.style.display = 'none'; return; }
      scoresSection.style.display = '';
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
        winner:           isSolo ? null : (overlay.querySelector('#ql-winner').value.trim() || null),
        solo:             isSolo,
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
      `Are you sure you want to remove "${gameName}" from your collection?`
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
    const confirmed = await showConfirm('Delete Session', 'Remove this session?');
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
    const confirmed = await showConfirm('Delete Photo', 'Remove this photo? This cannot be undone.');
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
        loadRecommendCard();
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

  function bindExportModal() {
    const btn = document.getElementById('export-btn');
    if (!btn) return;
    btn.addEventListener('click', openExportModal);
  }

  function openExportModal() {
    const inner = document.createElement('div');
    inner.innerHTML = `
      <div class="modal-content-panel">
        <div class="modal-panel-header">
          <h2>Export Data</h2>
          <button class="modal-close" id="export-modal-close" aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="18" height="18"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="modal-body">
          <p style="color:var(--text-2);font-size:0.85rem;margin-bottom:12px">Download your collection, sessions, and players in standard formats.</p>
          <div class="form-group" style="margin-bottom:10px">
            <button class="btn btn-secondary" id="export-json-btn" style="width:100%">Export as JSON</button>
          </div>
          <div class="form-group" style="margin-bottom:10px">
            <button class="btn btn-secondary" id="export-csv-btn" style="width:100%">Export as CSV</button>
          </div>
          <div class="form-group">
            <button class="btn btn-secondary" id="export-images-btn" style="width:100%">Export Images (ZIP)</button>
          </div>
        </div>
      </div>`;
    openModal(inner);
    inner.querySelector('#export-modal-close').addEventListener('click', closeModal);
    inner.querySelector('#export-json-btn').addEventListener('click', () => {
      window.open('/api/games/export/json', '_blank');
    });
    inner.querySelector('#export-csv-btn').addEventListener('click', () => {
      window.open('/api/games/export/csv', '_blank');
    });
    inner.querySelector('#export-images-btn').addEventListener('click', () => {
      window.open('/api/games/export/images', '_blank');
    });
  }

  async function openPlayersModal() {
    const modal    = document.getElementById('players-modal');
    const inner    = document.getElementById('players-modal-inner');
    const backdrop = document.getElementById('players-modal-backdrop');
    const prevFocus = document.activeElement;

    inner.innerHTML = '<p style="padding:1rem;opacity:0.6">Loading…</p>';
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
      setTimeout(() => { modal.style.display = 'none'; popModalOpen(); }, 200);
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
              <button class="players-sort-btn${playerSortKey==='name'?' active':''}" data-sort="name">Name</button>
              <button class="players-sort-btn${playerSortKey==='sessions'?' active':''}" data-sort="sessions">Sessions</button>
              <button class="players-sort-btn${playerSortKey==='wins'?' active':''}" data-sort="wins">Wins</button>
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
        inner.querySelectorAll('.players-sort-btn').forEach(b => b.classList.toggle('active', b.dataset.sort === playerSortKey));
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
        img.loading = 'lazy';
        img.addEventListener('click', () => _applyAvatarPreset(panel, player, p.id));
        picker.appendChild(img);
      });
      picker.style.cssText = `position:fixed;top:${rect.bottom + 8}px;left:${rect.left + rect.width / 2}px;transform:translateX(-50%);z-index:9999;`;
      document.body.appendChild(picker);
      panel._avatarPicker = picker;

      const onOutside = e => {
        if (!picker.contains(e.target) && !e.target.closest('.avatar-preset-trigger')) {
          _closeAvatarPicker(panel);
          document.removeEventListener('click', onOutside, true);
        }
      };
      setTimeout(() => document.addEventListener('click', onOutside, true), 0);
      picker._onOutside = onOutside;
    }

    function _closeAvatarPicker(panel) {
      if (panel._avatarPicker) {
        if (panel._avatarPicker._onOutside) {
          document.removeEventListener('click', panel._avatarPicker._onOutside, true);
        }
        panel._avatarPicker.remove();
        panel._avatarPicker = null;
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
          <div class="player-profile-loading">Loading stats…</div>
        </div>`;

      inner.querySelector('.modal-content-panel').appendChild(panel);
      requestAnimationFrame(() => panel.classList.add('open'));

      panel.querySelector('.player-profile-back').addEventListener('click', () => {
        _closeAvatarPicker(panel);
        panel.classList.remove('open');
        setTimeout(() => panel.remove(), 220);
      });

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
          <h2>Keyboard Shortcuts</h2>
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
            <button type="button" class="bgg-search-result" data-bgg-id="${item.bgg_id}">
              ${item.thumbnail ? `<span class="bgg-result-thumb"><img src="${escapeHtml(item.thumbnail)}" alt="" loading="lazy" width="40" height="40"></span>` : '<span class="bgg-result-thumb bgg-result-thumb-empty"></span>'}
              <span class="bgg-result-name">${escapeHtml(item.name)}</span>
              ${item.year_published ? `<span class="bgg-result-year">${item.year_published}</span>` : ''}
            </button>`).join('');
          results.querySelectorAll('.bgg-search-result').forEach(btn => {
            btn.addEventListener('click', async () => {
              results.style.display = 'none';
              input.value = '';
              const bggId = parseInt(btn.dataset.bggId, 10);
              showToast('Fetching from BGG…', 'info', 2000);
              try {
                const data = await API.bggFetch(bggId);
                _prefillAddGameForm(data);
                showToast(`Filled in: ${escapeHtml(data.name)}`, 'success');
              } catch (err) {
                showToast('BGG fetch failed: ' + classifyError(err), 'error');
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
  }

  function _prefillAddGameForm(data) {
    const f = id => document.getElementById(id);
    if (data.name)          f('m-name').value = data.name;
    if (data.year_published) f('m-year').value = data.year_published;
    if (data.min_players)   f('m-min-players').value = data.min_players;
    if (data.max_players)   f('m-max-players').value = data.max_players;
    if (data.min_playtime)  f('m-min-playtime').value = data.min_playtime;
    if (data.max_playtime)  f('m-max-playtime').value = data.max_playtime;
    if (data.difficulty)    f('m-difficulty').value = data.difficulty;
    if (data.description)   f('m-description').value = data.description;
    if (data.image_url)     { f('m-image-url').value = data.image_url; f('m-image-url').dispatchEvent(new Event('input')); }
    if (data.categories)    f('m-categories').value = (JSON.parse(data.categories || '[]')).join(', ');
    if (data.mechanics)     f('m-mechanics').value = (JSON.parse(data.mechanics || '[]')).join(', ');
    if (data.designers)     f('m-designers').value = (JSON.parse(data.designers || '[]')).join(', ');
    if (data.publishers)    f('m-publishers').value = (JSON.parse(data.publishers || '[]')).join(', ');
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
    f('m-difficulty').addEventListener('input', () => {
      const el = f('m-difficulty');
      const diff = parseFloat(el.value);
      if (el.value && (diff < 1 || diff > 5)) {
        setFieldError(e('difficulty'), el, 'Must be between 1 and 5');
        el.classList.remove('valid');
      } else {
        clearFieldError(e('difficulty'), el);
        if (el.value) el.classList.add('valid');
      }
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!validateAddForm()) return;
      const submitBtn = form.querySelector('[type="submit"]');
      const fd   = new FormData(form);
      const file = fileInput.files[0];

      function csvToJson(key) {
        const val = fd.get(key) || '';
        const items = val.split(',').map(s => s.trim()).filter(Boolean);
        return items.length ? JSON.stringify(items) : null;
      }

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
        categories:        csvToJson('categories_raw'),
        mechanics:         csvToJson('mechanics_raw'),
        designers:         csvToJson('designers_raw'),
        publishers:        csvToJson('publishers_raw'),
        labels:            csvToJson('labels_raw'),
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
          const proceed = await showConfirm(title, msg);
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
            `"${localDup.name}" is already in your collection. Add it again anyway?`
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

    function buildChips(container, items, stateKey) {
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

    buildChips(mechRow, topM, 'filterMechanics');
    buildChips(catRow,  topC, 'filterCategories');
    if (locRow) buildLocationChips(locRow);
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

    function openPanel()  { renderFilterChips(); panel.classList.add('open'); syncFilterActiveBar(); }
    function closePanel() { if (!hasActiveFilters()) panel.classList.remove('open'); syncFilterActiveBar(); }

    searchEl.addEventListener('click', openPanel);

    toggleBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (panel.classList.contains('open')) {
        panel.classList.remove('open');
      } else {
        openPanel();
      }
      syncFilterActiveBar();
    });

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
      state.filterLocation = null;
      saveCollectionPrefs();
      neverBtn.classList.remove('active');
      playersEl.value = '';
      timeEl.value = '';
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
    // Sync when panel opens/closes
    document.addEventListener('mousedown', () => setTimeout(syncFilterActiveBar, 50));
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
        <div class="modal-body">
          <div class="form-grid" style="margin-bottom:12px">
            <div class="form-group">
              <label class="form-label" for="gn-players">Player count</label>
              <input type="number" id="gn-players" class="form-input" min="1" max="20" placeholder="Any" value="${state.filterPlayers || ''}" autocomplete="off">
            </div>
            <div class="form-group">
              <label class="form-label" for="gn-time">Max time (min)</label>
              <input type="number" id="gn-time" class="form-input" min="1" placeholder="Any" value="${state.filterTime || ''}" autocomplete="off">
            </div>
          </div>
          ${playerOptions ? `<div class="gn-player-select" style="margin-bottom:12px"><div class="form-label" style="margin-bottom:6px">Or pick players</div><div class="gn-player-chips">${playerOptions}</div></div>` : ''}
          <button class="btn btn-primary" id="gn-suggest-btn" style="width:100%">Suggest Games</button>
          <div id="gn-results"></div>
        </div>
      </div>`;

    modal.style.display = 'flex';
    pushModalOpen();

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
      setTimeout(() => { modal.style.display = 'none'; popModalOpen(); }, 200);
      backdrop.removeEventListener('click', close);
    }

    backdrop.addEventListener('click', close);
    inner.querySelector('#game-night-close').addEventListener('click', (e) => { e.stopPropagation(); close(); });

    inner.querySelector('#gn-suggest-btn').addEventListener('click', async () => {
      const playerCount = parseInt(inner.querySelector('#gn-players').value, 10) || null;
      const maxMinutes  = parseInt(inner.querySelector('#gn-time').value, 10) || null;
      const selectedPlayerIds = [...inner.querySelectorAll('[data-gn-player]:checked')].map(cb => +cb.value);
      const resultsEl   = inner.querySelector('#gn-results');
      const btn         = inner.querySelector('#gn-suggest-btn');
      const dismissedIds = new Set();
      let allSuggestions = [];
      const useGroupRecommend = selectedPlayerIds.length > 0;

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
          el.addEventListener('click', e => {
            if (e.target.closest('.gn-dismiss-btn')) return;
            const game = state.games.find(g => g.id === +el.dataset.gameId);
            if (game) { close(); openGameModal(game); }
          });
        });
      }

      async function fetchAndRender() {
        try {
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
      resultsEl.innerHTML = `<div class="gn-thinking"><div class="gn-dice">🎲</div><p>Finding your game…</p></div>`;
      await withLoading(btn, fetchAndRender, 'Finding games…');
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
    colsBtn.addEventListener('click', e => {
      e.stopPropagation();
      colsDropdown.hidden = !colsDropdown.hidden;
      colsBtn.classList.toggle('open', !colsDropdown.hidden);
    });
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
          <div class="restore-preview" role="dialog" aria-modal="true" aria-label="Backup Preview">
            <div class="restore-preview-header">
              <h3>Backup Preview</h3>
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

        const cancelBtn = overlay.querySelector('#restore-preview-cancel');
        const confirmBtn = overlay.querySelector('#restore-preview-confirm');

        const close = () => {
          document.removeEventListener('keydown', onKey);
          overlay.remove();
          restoreInput.value = '';
        };

        const onKey = (e) => {
          if (e.key === 'Escape') { e.preventDefault(); close(); }
        };
        document.addEventListener('keydown', onKey);

        overlay.addEventListener('click', (e) => {
          if (e.target === overlay) close();
        });
        cancelBtn.addEventListener('click', close);
        confirmBtn.addEventListener('click', async () => {
          close();
          const confirmed = await showConfirm(
            'Restore from Backup',
            'This will replace all current data. This cannot be undone. Continue?'
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

        requestAnimationFrame(() => overlay.classList.add('open'));
        cancelBtn.focus();
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
      if (!row) return;
      const game = allGames.find(g => g.id === parseInt(row.dataset.gameId, 10)) ?? state.games.find(g => g.id === parseInt(row.dataset.gameId, 10));
      if (game) openGameModal(game);
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

  function wireGoalsSection(container) {
    const section = container.querySelector('#stats-goals');
    if (!section) return;

    const addGoalBtn = section.querySelector('#add-goal-btn');
    const addGoalForm = section.querySelector('#add-goal-form');
    const goalTypeSelect = section.querySelector('#goal-type');
    const goalGameGroup = section.querySelector('#goal-game-group');
    const goalYearGroup = section.querySelector('#goal-year-group');

    if (addGoalBtn) {
      addGoalBtn.addEventListener('click', () => {
        addGoalForm.style.display = addGoalForm.style.display === 'none' ? '' : 'none';
      });
    }

    if (goalTypeSelect) {
      goalTypeSelect.addEventListener('change', () => {
        const t = goalTypeSelect.value;
        goalGameGroup.style.display = t === 'game_sessions' ? '' : 'none';
        goalYearGroup.style.display = (t === 'sessions_year' || t === 'unique_games_year') ? '' : 'none';
      });
    }

    const cancelBtn = section.querySelector('#goal-cancel-btn');
    if (cancelBtn) cancelBtn.addEventListener('click', () => { addGoalForm.style.display = 'none'; });

    const saveBtn = section.querySelector('#goal-save-btn');
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        const title = section.querySelector('#goal-title').value.trim();
        const type = section.querySelector('#goal-type').value;
        const target = parseInt(section.querySelector('#goal-target').value, 10);
        const gameId = section.querySelector('#goal-game-select')?.value || null;
        const year = section.querySelector('#goal-year')?.value || null;
        if (!title) { showToast('Please enter a title', 'error'); return; }
        if (!target || target < 1) { showToast('Please enter a valid target', 'error'); return; }
        if (type === 'win_rate_target' && target > 100) { showToast('Win rate target must be 1–100', 'error'); return; }
        if (type === 'game_sessions' && !gameId) { showToast('Please select a game', 'error'); return; }
        try {
          await withLoading(saveBtn, async () => {
            await API.createGoal({
              title,
              type,
              target_value: target,
              game_id: gameId ? parseInt(gameId, 10) : null,
              year: year ? parseInt(year, 10) : null,
            });
            showToast('Goal created!', 'success');
            await loadStats();
          }, 'Saving…');
        } catch (err) {
          showToast(`Failed to create goal: ${classifyError(err)}`, 'error');
        }
      });
    }

    // Delete buttons
    section.querySelectorAll('.goal-delete-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const goalId = parseInt(btn.dataset.goalId, 10);
        const ok = await showConfirm('Delete Goal', 'Remove this goal?');
        if (!ok) return;
        try {
          await withLoading(btn, async () => {
            await API.deleteGoal(goalId);
            showToast('Goal removed.', 'success');
            await loadStats();
          }, '…');
        } catch (err) {
          showToast(`Failed to delete goal: ${classifyError(err)}`, 'error');
        }
      });
    });
  }

  async function _prefetchStats() {
    const statsContent = document.getElementById('stats-content');
    if (!statsContent || _statsLoading || _statsPrefetched || _statsPrefetchInFlight) return;
    if (statsContent.children.length > 0 && !statsContent.querySelector('.loading-spinner')) return;
    _statsPrefetchInFlight = true;
    try {
      const [stats, goals] = await Promise.all([
        API.getStats(),
        API.getGoals().catch(() => []),
      ]);
      const prefs = loadStatsPrefs();
      _statsPrefetched = { stats, goals, prefs };
    } catch (_) {
      _statsPrefetched = null;
    } finally {
      _statsPrefetchInFlight = false;
    }
  }

  async function loadStats() {
    _statsLoading = true;
    const el = document.getElementById('stats-content');

    // Use prefetched data if available
    if (_statsPrefetched) {
      const { stats, goals, prefs } = _statsPrefetched;
      _statsPrefetched = null;
      el.innerHTML = '';
      const statsView = buildStatsView(stats, [], prefs, saveStatsPrefs, goals);
      el.appendChild(statsView);
      wireStatsView(statsView, stats);
      wireGoalsSection(statsView);
      _injectMilestonesIntoGrid(statsView, prefs);
      _animateStatBars(el);
      _statsLoading = false;
      return;
    }

    el.innerHTML = '<div class="loading-spinner"><div class="spinner"></div><p>Loading statistics…</p></div>';
    try {
      const [stats, goals] = await Promise.all([
        API.getStats(),
        API.getGoals().catch(() => []),
      ]);
      const prefs = loadStatsPrefs();
      el.innerHTML = '';
      const statsView = buildStatsView(stats, [], prefs, saveStatsPrefs, goals);
      el.appendChild(statsView);
      wireStatsView(statsView, stats);
      wireGoalsSection(statsView);
      _injectMilestonesIntoGrid(statsView, prefs);
      _animateStatBars(el);
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
        API.getGoals().catch(() => []),
      ]);
      const prefs = loadStatsPrefs();
      const el = document.getElementById('stats-content');
      el.innerHTML = '';
      const statsView = buildStatsView(stats, [], prefs, saveStatsPrefs, goals);
      el.appendChild(statsView);
      wireStatsView(statsView, stats);
      wireGoalsSection(statsView);
      _injectMilestonesIntoGrid(statsView, prefs);
      _animateStatBars(el);
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
      container.innerHTML = list.map(t => `
        <div class="share-token-row${isExpired(t) ? ' expired' : ''}" data-token="${escapeHtml(t.token)}">
          <div class="share-token-info">
            <div class="share-token-header">
              <span class="share-token-label">${escapeHtml(t.label || 'Untitled')}</span>
              ${t.created_at ? `<span class="share-token-created">Created ${escapeHtml(formatDate(t.created_at))}</span>` : ''}
              ${formatExpiry(t)}
            </div>
            <input class="share-link-input" type="text" readonly value="${escapeHtml(origin + '/share.html?token=' + t.token)}" aria-label="Share link">
          </div>
          <div class="share-token-actions">
            <button class="btn btn-secondary btn-sm share-copy-btn"${isExpired(t) ? ' disabled' : ''}>Copy</button>
            <button class="btn btn-danger btn-sm share-revoke-btn">Revoke</button>
          </div>
        </div>`).join('');

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
          const ok = await showConfirm('Revoke Link', msg);
          if (!ok) return;
          try {
            await withLoading(btn, async () => {
              await API.deleteShareToken(token);
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
          <h2>Share Collection</h2>
          <p>Share your collection via live link or download a PDF.</p>
        </div>
        <button class="modal-close" id="share-modal-close" aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="18" height="18"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="share-modal-tabs">
        <button class="share-tab active" data-tab="links">Links</button>
        <button class="share-tab" data-tab="requests">Requests${unseenCount > 0 ? ` <span class="share-req-badge">${unseenCount}</span>` : ''}</button>
      </div>
      <div class="modal-body">
        <div id="share-tab-links">
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
        <div id="share-tab-requests" style="display:none">
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
    el.querySelectorAll('.share-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        el.querySelectorAll('.share-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const target = tab.dataset.tab;
        el.querySelector('#share-tab-links').style.display = target === 'links' ? '' : 'none';
        el.querySelector('#share-tab-requests').style.display = target === 'requests' ? '' : 'none';
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
          ${!r.seen ? `<button class="btn btn-ghost btn-sm share-seen-btn">Mark seen</button>` : '<span class="share-seen-label">Seen</span>'}
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
              if (badge) { remaining > 0 ? (badge.textContent = remaining) : badge.remove(); }
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
          tokens.push(newToken);
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
    requestAnimationFrame(() => toast.classList.add('show'));

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
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }

    undoBtn.addEventListener('click', () => {
      dismiss();
      onUndo();
    });
  }

  // ===== First-Visit Coach Mark Tour =====
  const TOUR_DONE_KEY = 'cardboard_tour_done';
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

  function startTour() {
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

  async function maybeStartTour() {
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

  // Wire retake tour button

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

  document.getElementById('retake-tour-btn')?.addEventListener('click', async () => {
    try { localStorage.removeItem(TOUR_DONE_KEY); } catch (_) { /* quota or unavailable */ }
    try { await API.setSetting(TOUR_DONE_KEY, ''); } catch (_) { /* non-fatal */ }
    _tourCheckDone = false;
    startTour();
  });

})();
