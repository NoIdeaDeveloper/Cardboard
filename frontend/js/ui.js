/**
 * Cardboard – UI component builders
 *
 * Utility/helper functions (animations, notifications, form helpers, media helpers)
 * have been extracted to ui-helpers.js. This file contains the complex component
 * builders (game cards, modal content, stats view).
 */

// ===== Location Datalist Helper =====
function _buildLocationDatalist(games, field) {
  const freq = {};
  for (const g of games) {
    const v = (g[field] || '').trim();
    if (v) freq[v] = (freq[v] || 0) + 1;
  }
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => `<option value="${escapeHtml(name)}">`)
    .join('');
}

// ===== Game Card (Grid) =====

function buildGameCard(game) {
  const el = document.createElement('div');
  el.className = 'game-card';
  el.dataset.gameId = game.id;
  el.setAttribute('role', 'button');
  el.setAttribute('aria-label', `View details for ${game.name}`);
  el.setAttribute('tabindex', '0');

  const playtime = formatPlaytime(game.min_playtime, game.max_playtime);
  const players  = formatPlayers(game.min_players, game.max_players);

  let metaHtml = '';
  if (players)  metaHtml += `<span class="chip">${escapeHtml(players)}</span>`;
  if (playtime) metaHtml += `<span class="chip">${escapeHtml(playtime)}</span>`;
  if (game.year_published) metaHtml += `<span class="chip">${game.year_published}</span>`;

  // --- Heat level based on recency (pre-computed by server) ---
  const _now = Date.now();
  const _daysSince = game.last_played
    ? Math.floor((_now - new Date(game.last_played + 'T00:00:00')) / 86400000)
    : Infinity;
  const _heatLevel = game.heat_level ?? 0;
  el.dataset.heat = _heatLevel;

  // --- Mini dashboard badge row ---
  const _ratingClass = !game.user_rating ? 'mini-badge-unrated'
    : game.user_rating >= 8 ? 'mini-badge-green'
    : game.user_rating >= 5 ? 'mini-badge-yellow'
    : 'mini-badge-red';
  const _sessionCount = game.session_count ?? game.total_sessions ?? '';
  const _sinceLabel = _daysSince === Infinity ? 'Never'
    : _daysSince === 0 ? 'Today'
    : _daysSince === 1 ? '1d ago'
    : _daysSince < 7 ? `${_daysSince}d ago`
    : _daysSince < 365 ? `${Math.floor(_daysSince / 7)}w ago`
    : `${Math.floor(_daysSince / 365)}y ago`;
  const miniDashHtml = `<div class="card-mini-dash">
    <span class="mini-badge ${_ratingClass}">${game.user_rating || '—'}</span>
    ${_sessionCount !== '' ? `<span class="mini-badge mini-badge-neutral">${_sessionCount} <span class="mini-badge-label">plays</span></span>` : ''}
    <span class="mini-badge mini-badge-since">${_sinceLabel}</span>
  </div>`;

  const wishlistPriorityHtml = (game.status === 'wishlist' && game.priority)
    ? `<span class="wishlist-priority">Priority ${'★'.repeat(game.priority)}${'☆'.repeat(5 - game.priority)}</span>`
    : '';
  const wishlistTargetHtml = (game.status === 'wishlist' && game.target_price != null)
    ? `<span class="wishlist-target-price">Target $${game.target_price.toFixed(2)}</span>`
    : '';
  const conditionHtml = game.condition
    ? `<span class="condition-badge condition-${game.condition.toLowerCase()}">${escapeHtml(game.condition)}</span>`
    : '';

  const cardStatusBadge = game.status === 'wishlist'
    ? `<span class="status-badge status-wishlist">Wishlist</span>`
    : game.status === 'sold'
    ? `<span class="status-badge status-sold">Sold</span>`
    : '';

  const cardLabels = parseList(game.labels);
  const cardLabelsHtml = cardLabels.length
    ? `<div class="label-chips">${cardLabels.slice(0, 3).map(l => `<span class="label-chip">${escapeHtml(l)}</span>`).join('')}</div>`
    : '';

  const cardLocationHtml = (game.show_location && game.location)
    ? `<span class="location-line">${escapeHtml(game.location)}</span>`
    : '';

  const expansionBadgeHtml = game._expansionCount > 0
    ? `<span class="card-expansion-badge">🧩 ${pluralize(game._expansionCount, 'expansion')}</span>`
    : '';
  const partOfTagHtml = game.parent_game_id
    ? `<span class="card-expansion-tag">↳ ${escapeHtml(game.parent_game_name || 'Expansion')}</span>`
    : '';

  el.innerHTML = `
    <div class="game-card-image">
      ${cardMediaHtml(game)}
      ${_heatLevel === 3 ? '<span class="heat-badge" title="Recently played">🔥</span>' : ''}
      <div class="card-hover-actions">
        <button class="card-hover-btn card-hover-view" type="button" title="View game">View</button>
        ${game.status === 'owned' ? `<button class="card-hover-btn card-hover-log quick-log-btn" type="button" title="Log a play">+ Log</button>` : ''}
        ${game.status === 'owned' && game.session_count > 0 ? `<button class="card-hover-btn card-hover-repeat quick-repeat-btn" type="button" title="Repeat last session">↻ Repeat</button>` : ''}
        ${game.status === 'wishlist' ? `<button class="card-hover-btn quick-owned-btn" type="button" title="Move to collection">✓ Own It</button>` : ''}
      </div>
    </div>
    <div class="game-card-body">
      <div class="game-card-title-row">
        <div class="game-card-title">${escapeHtml(game.name)}</div>
        ${cardStatusBadge}
      </div>
      ${partOfTagHtml}
      ${metaHtml ? `<div class="game-card-meta">${metaHtml}</div>` : ''}
      <div class="game-card-footer">
        ${miniDashHtml}
        ${conditionHtml}
        ${wishlistPriorityHtml}${wishlistTargetHtml}
        ${cardLabelsHtml}
        ${cardLocationHtml}
        ${expansionBadgeHtml}
        ${game.date_added ? `<span class="game-date-added">Added ${escapeHtml(formatDatetime(game.date_added))}</span>` : ''}
        ${game.share_hidden ? `<span class="share-hidden-badge">Hidden from share</span>` : ''}
      </div>
    </div>`;

  return el;
}

// ===== Game List Item =====

function buildGameListItem(game) {
  const el = document.createElement('div');
  el.className = 'game-list-item';
  el.dataset.gameId = game.id;
  el.setAttribute('role', 'button');
  el.setAttribute('aria-label', `View details for ${game.name}`);

  const playtime = formatPlaytime(game.min_playtime, game.max_playtime);
  const players  = formatPlayers(game.min_players, game.max_players);
  const metaParts = [players, playtime, game.difficulty ? `Difficulty ${+game.difficulty.toFixed(2)}` : null].filter(Boolean);

  const ratingHtml = game.user_rating
    ? `${renderStars(game.user_rating)}<span class="rating-num">${game.user_rating}</span>`
    : `<span class="unrated">Unrated</span>`;

  const listStatusBadge = game.status === 'wishlist'
    ? `<span class="status-badge status-wishlist">Wishlist</span>`
    : game.status === 'sold'
    ? `<span class="status-badge status-sold">Sold</span>`
    : '';

  const listLabels = parseList(game.labels);
  const listLabelsHtml = listLabels.length
    ? `<div class="label-chips">${listLabels.slice(0, 4).map(l => `<span class="label-chip">${escapeHtml(l)}</span>`).join('')}</div>`
    : '';

  const listTitlePrefix = game.parent_game_id
    ? `<span class="list-expansion-prefix">↳</span> `
    : '';
  const listExpBadge = (game._expansionCount > 0)
    ? `<span class="card-expansion-badge">🧩 ${pluralize(game._expansionCount, 'expansion')}</span>`
    : '';

  el.innerHTML = `
    <div class="list-thumb">
      ${listThumbHtml(game)}
    </div>
    <div class="list-info${game.parent_game_id ? ' list-info-expansion' : ''}">
      <div class="list-title-row">
        <div class="list-title">${listTitlePrefix}${escapeHtml(game.name)}</div>
        ${listStatusBadge}
      </div>
      ${metaParts.length ? `<div class="list-meta">${metaParts.map(escapeHtml).join(' · ')}</div>` : ''}
      ${listLabelsHtml}
      ${listExpBadge}
      ${game.last_played ? `<div class="last-played-line">Played ${escapeHtml(formatDate(game.last_played))}</div>` : ''}
      ${game.date_added ? `<div class="last-played-line">Added ${escapeHtml(formatDatetime(game.date_added))}</div>` : ''}
      ${(game.show_location && game.location) ? `<div class="location-line">${escapeHtml(game.location)}</div>` : ''}
      ${game.status === 'owned' ? `<button class="quick-log-btn" type="button">+ Log Play</button>` : ''}
      ${game.status === 'wishlist' ? `<button class="quick-owned-btn btn btn-ghost btn-sm" type="button" title="Move to collection">✓ Own It</button>` : ''}
    </div>
    <div class="list-rating">${ratingHtml}</div>`;

  return el;
}

// ===== Modal =====

function buildModalContent(game, sessions, onSave, onDelete, onAddSession, onDeleteSession, onUpdateSession, onUploadInstructions, onDeleteInstructions, onUploadImage, onDeleteImage, images, onUploadGalleryImage, onDeleteGalleryImage, onReorderGalleryImages, onAddGalleryImageFromUrl, onUpdateGalleryImageCaption, mode = 'view', onSwitchToEdit, onSwitchToView, allGames = [], onOpenGame = null, onShareGame = null, onCloseModal = closeModal, navInfo = null) {
  const el = document.createElement('div');

  const categories = parseList(game.categories);
  const mechanics  = parseList(game.mechanics);
  const designers  = parseList(game.designers);
  const publishers = parseList(game.publishers);
  const modalLabels = parseList(game.labels);

  const isEdit = mode === 'edit';

  const modalStatusBadge = game.status && game.status !== 'owned'
    ? `<span class="status-badge status-${escapeHtml(game.status)}">${game.status === 'wishlist' ? 'Wishlist' : 'Sold'}</span>`
    : '';

  // Expansion relationship display blocks
  const parentGame = game.parent_game_id
    ? (allGames.find(g => g.id === game.parent_game_id) || { id: game.parent_game_id, name: game.parent_game_name || 'Unknown' })
    : null;

  const partOfHtml = parentGame && !isEdit
    ? `<div class="modal-part-of">
        Part of:
        <button class="expansion-link-btn" data-game-id="${parentGame.id}">${escapeHtml(parentGame.name)} ↗</button>
       </div>`
    : '';

  const ownedExpansions = !game.parent_game_id && !isEdit
    ? allGames.filter(g => g.parent_game_id === game.id)
    : [];

  const expansionChipsHtml = ownedExpansions.length && !isEdit
    ? `<div class="modal-tags-group modal-expansions-group">
        <span class="modal-tags-label">Expansions (${ownedExpansions.length})</span>
        <div class="modal-tags">${ownedExpansions.map(e =>
          `<button class="expansion-chip expansion-chip-${e.status || 'owned'}" data-game-id="${e.id}">${escapeHtml(e.name)} ↗</button>`
        ).join('')}</div>
       </div>`
    : '';

  // Edit-mode: base game picker
  const baseGameOptions = allGames
    .filter(g => g.id !== game.id && !g.parent_game_id)
    .sort((a, b) => a.name.localeCompare(b.name));

  const baseGameEditHtml = isEdit
    ? `<div class="form-group full-width">
        <label for="edit-base-game-search">Base Game <span class="hint">(leave blank if this is a base game)</span></label>
        <div class="base-game-picker">
          <input type="text" id="edit-base-game-search" class="form-input" autocomplete="off"
            placeholder="Search base games…"
            value="${parentGame ? escapeHtml(parentGame.name) : ''}">
          <input type="hidden" id="edit-base-game-id" value="${game.parent_game_id || ''}">
          <button class="btn btn-ghost btn-sm" id="edit-base-game-clear" style="${game.parent_game_id ? '' : 'display:none'}">Clear</button>
        </div>
        <div class="base-game-dropdown" id="base-game-dropdown" style="display:none"></div>
       </div>`
    : '';

  const labelsDisplayHtml = modalLabels.length
    ? `<div class="modal-tags-group">
        <span class="modal-tags-label">My Labels</span>
        <div class="modal-tags">${modalLabels.map(l => `<span class="label-chip">${escapeHtml(l)}</span>`).join('')}</div>
      </div>`
    : '';

  const locationDisplayHtml = game.location
    ? `<div class="modal-section">
        <div class="section-label">Storage Location</div>
        <div>${escapeHtml(game.location)}</div>
      </div>`
    : '';

  const hasPurchaseInfo = game.purchase_date || game.purchase_price != null || game.purchase_location || game.sale_price != null;
  // Sum recorded durations; for sessions without duration use min_playtime as
  // fallback (then avg of recorded sessions) so unlogged plays don't silently
  // inflate the cost/hr by understating total hours played.
  const sessionsWith    = sessions.filter(s => s.duration_minutes);
  const sessionsWithout = sessions.length - sessionsWith.length;
  const recordedMinutes = sessionsWith.reduce((sum, s) => sum + s.duration_minutes, 0);
  const fallbackMinutes = game.min_playtime
    || (sessionsWith.length > 0 ? Math.round(recordedMinutes / sessionsWith.length) : 0);
  const totalSessionMinutes = recordedMinutes + sessionsWithout * fallbackMinutes;
  const cph = (game.purchase_price > 0 && totalSessionMinutes > 0)
    ? (game.purchase_price / (totalSessionMinutes / 60)).toFixed(2)
    : null;
  const purchaseDisplayHtml = hasPurchaseInfo
    ? `<div class="modal-section">
        <div class="section-label">Purchase Info</div>
        <div class="purchase-info">
          ${game.purchase_date ? `<span class="purchase-field"><span class="purchase-label">Date</span> ${escapeHtml(formatDate(game.purchase_date))}</span>` : ''}
          ${game.purchase_price != null ? `<span class="purchase-field"><span class="purchase-label">Price</span> $${game.purchase_price.toFixed(2)}</span>` : ''}
          ${game.sale_price != null ? `<span class="purchase-field"><span class="purchase-label">Sold For</span> $${game.sale_price.toFixed(2)}</span>` : ''}
          ${game.purchase_location ? `<span class="purchase-field"><span class="purchase-label">From</span> ${escapeHtml(game.purchase_location)}</span>` : ''}
          ${cph ? `<span class="purchase-field purchase-cph"><span class="purchase-label">Cost/hr</span> $${cph}</span>` : ''}
        </div>
      </div>`
    : '';

  // Trophy shelf badges
  const _trophyBadges = [];
  const _sc = sessions.length;
  if (_sc >= 100) _trophyBadges.push({ icon: '🏆', label: '100 Club', title: '100+ sessions logged' });
  else if (_sc >= 50) _trophyBadges.push({ icon: '🥇', label: '50 Plays', title: '50+ sessions logged' });
  else if (_sc >= 10) _trophyBadges.push({ icon: '🎲', label: 'Regular', title: '10+ sessions logged' });
  if (game.user_rating >= 9) _trophyBadges.push({ icon: '⭐', label: 'Favorite', title: `You rated this ${game.user_rating}/10` });
  if (game.status === 'owned' && !game.last_played) _trophyBadges.push({ icon: '😴', label: 'Unplayed', title: 'Still waiting for table time' });
  if (game.bgg_rating && game.user_rating && game.user_rating - game.bgg_rating >= 1.5) _trophyBadges.push({ icon: '💎', label: 'Hidden Gem', title: 'You rate this higher than BGG' });
  if (totalSessionMinutes >= 600) _trophyBadges.push({ icon: '⏱️', label: '10h+', title: `${Math.floor(totalSessionMinutes/60)} hours played` });
  const trophyShelfHtml = _trophyBadges.length ? `<div class="trophy-shelf">
    ${_trophyBadges.map(b => `<div class="trophy-badge" title="${escapeHtml(b.title)}"><span class="trophy-icon">${b.icon}</span><span class="trophy-label">${escapeHtml(b.label)}</span></div>`).join('')}
  </div>` : '';

  // Play history sparkline (view mode only)
  const sparklineHtml = (!isEdit && sessions.length > 0)
    ? `<div class="sparkline-row">${buildSparkline(sessions, 180, 34)}<span class="sparkline-label">12-month activity</span></div>`
    : '';

  // Hero
  const _heroImgSrc = game.thumbnail_url || game.image_url;

  const _navBarHtml = navInfo && (navInfo.prevGame || navInfo.nextGame)
    ? `<div class="modal-nav-bar">
        ${navInfo.prevGame
          ? `<button class="modal-nav-btn modal-nav-prev" aria-label="Previous: ${escapeHtml(navInfo.prevGame.name)}" title="Previous: ${escapeHtml(navInfo.prevGame.name)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg><span class="modal-nav-label">${escapeHtml(navInfo.prevGame.name)}</span></button>`
          : `<span></span>`}
        ${navInfo.nextGame
          ? `<button class="modal-nav-btn modal-nav-next" aria-label="Next: ${escapeHtml(navInfo.nextGame.name)}" title="Next: ${escapeHtml(navInfo.nextGame.name)}"><span class="modal-nav-label">${escapeHtml(navInfo.nextGame.name)}</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg></button>`
          : `<span></span>`}
      </div>`
    : '';

  const heroHtml = isSafeUrl(_heroImgSrc)
    ? `<div class="modal-hero" data-bg-url="${escapeHtml(_heroImgSrc)}">
        <div class="modal-hero-overlay"></div>
        <button class="modal-close" aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>`
    : `<div class="modal-hero modal-hero-placeholder">
        ${placeholderSvg()}
        <button class="modal-close" aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>`;

  // Info chips
  const playtime = formatPlaytime(game.min_playtime, game.max_playtime);
  const players  = formatPlayers(game.min_players, game.max_players);
  let chipsHtml = '';
  if (players)  chipsHtml += `<span class="chip">${escapeHtml(players)}</span>`;
  if (playtime) chipsHtml += `<span class="chip">${escapeHtml(playtime)}</span>`;
  if (game.difficulty) chipsHtml += `<span class="chip chip-difficulty">${+game.difficulty.toFixed(2)} weight</span>`;
  if (game.year_published) chipsHtml += `<span class="chip">${game.year_published}</span>`;

  function tagsBlock(label, items) {
    if (!items.length) return '';
    return `<div class="modal-tags-group">
      <span class="modal-tags-label">${label}</span>
      <div class="modal-tags">${items.slice(0, 12).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>
    </div>`;
  }

  function buildSessionInfoHtml(s) {
    const scores = s.player_scores || {};
    const hasScores = Object.keys(scores).length > 0;
    const playersHtml = (s.players && s.players.length)
      ? s.players.map(p => hasScores && scores[p] != null
          ? `${escapeHtml(p)} <span class="session-score">${scores[p]}</span>`
          : escapeHtml(p)).join(', ')
      : '';
    return `<span class="session-date">${escapeHtml(formatDate(s.played_at))}</span>
          ${s.solo ? `<span class="session-meta session-solo">Solo</span>` : ''}
          ${s.player_count && !s.solo ? `<span class="session-meta">${pluralize(s.player_count, 'player')}</span>` : ''}
          ${s.duration_minutes ? `<span class="session-meta">${s.duration_minutes} min</span>` : ''}
          ${playersHtml ? `<span class="session-meta">${playersHtml}</span>` : ''}
          ${s.winner && !s.solo ? `<span class="session-meta">&#127942; ${escapeHtml(s.winner)}</span>` : ''}
          ${s.notes ? `<span class="session-notes">${escapeHtml(s.notes)}</span>` : ''}
          ${s.session_rating ? `<span class="session-rating">${'★'.repeat(s.session_rating)}${'☆'.repeat(5 - s.session_rating)}</span>` : ''}`;
  }

  function buildSessionsHtml(list) {
    if (!list.length) return `<div class="no-sessions">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
      <span class="no-sessions-text">No sessions logged yet.<br>Log your first play to start tracking.</span>
    </div>`;
    return list.map(s => `
      <div class="session-item" data-session-id="${s.id}">
        <div class="session-info">
          ${buildSessionInfoHtml(s)}
        </div>
        <button class="session-edit" data-session-id="${s.id}" title="Edit session">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="session-delete" data-session-id="${s.id}" title="Delete session">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>
        </button>
      </div>`).join('');
  }

  const hasInstructions = !!game.instructions_filename;

  let selectedRating = game.user_rating || null;

  // ===== Mode-specific HTML blocks =====

  const starButtonsHtml = Array.from({length: 10}, (_, i) => i + 1).map(n =>
    `<button class="star-btn${(game.user_rating || 0) >= n ? ' active' : ''}" data-value="${n}" aria-label="${n} stars"><svg viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg></button>`
  ).join('');

  const ratingWidgetHtml = isEdit
    ? `<div class="modal-section">
        <div class="section-label">My Rating</div>
        <div class="rating-widget">
          <div class="rating-stars-interactive" id="rating-stars">${starButtonsHtml}</div>
          <span class="rating-display" id="rating-display">${game.user_rating || '—'}</span>
          <button class="btn btn-ghost btn-sm" id="rating-clear">Clear</button>
        </div>
      </div>`
    : (game.user_rating || game.bgg_rating)
      ? `<div class="modal-section">
          <div class="section-label">Rating</div>
          <div class="rating-display-only">
            ${game.user_rating ? renderStars(game.user_rating) : ''}
            ${game.user_rating ? `<span class="rating-text">${game.user_rating}/10</span>` : ''}
            ${game.bgg_rating ? `<span class="bgg-rating-detail">BGG ${game.bgg_rating.toFixed(1)}</span>` : ''}
          </div>
        </div>`
      : '';

  const lastPlayedWidgetHtml = isEdit
    ? `<div class="modal-section">
        <div class="section-label">Last Played</div>
        <div class="last-played-row">
          <input type="date" id="last-played-input" class="date-input" value="${game.last_played || ''}" autocomplete="off" aria-label="Last played date">
          <button class="btn btn-ghost btn-sm" id="today-btn">Today</button>
        </div>
      </div>`
    : game.last_played
      ? `<div class="modal-section">
          <div class="section-label">Last Played</div>
          <span class="chip">${escapeHtml(formatDate(game.last_played))}</span>
        </div>`
      : '';

  const descriptionSectionHtml = isEdit
    ? `<div class="modal-section">
        <div class="section-label">Description</div>
        <textarea id="edit-description" class="form-input" rows="3" autocomplete="off" aria-label="Description">${escapeHtml(game.description || '')}</textarea>
      </div>`
    : game.description
      ? `<div class="modal-section">
          <div class="section-label">Description</div>
          <div class="description-text" id="desc-text">${escapeHtml(game.description)}</div>
          <button class="btn btn-ghost btn-sm" id="desc-toggle" style="margin-top:6px">Show more</button>
        </div>`
      : '';

  const notesSectionHtml = isEdit
    ? `<div class="modal-section">
        <div class="section-label">My Notes</div>
        <textarea id="user-notes" class="notes-input" rows="3" placeholder="Personal notes, house rules, favourite moments…" autocomplete="off" aria-label="My notes">${escapeHtml(game.user_notes || '')}</textarea>
      </div>`
    : game.user_notes
      ? `<div class="modal-section">
          <div class="section-label">My Notes</div>
          <p class="notes-display">${escapeHtml(game.user_notes)}</p>
        </div>`
      : '';

  const coverImageSectionHtml = isEdit
    ? `<div class="modal-section" id="cover-image-section">
        <div class="section-label">Cover Image</div>
        <div class="image-edit-area">
          <div class="image-edit-preview" id="edit-cover-preview">
            ${isSafeUrl(game.image_url)
              ? `<img src="${escapeHtml(game.image_url)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:var(--radius-sm)">`
              : '<span class="image-edit-empty">No image</span>'}
          </div>
          <div class="image-edit-controls">
            <input type="url" id="edit-cover-url" class="form-input" placeholder="Paste image URL…" value="${escapeHtml(game.image_url || '')}" autocomplete="off">
            ${game.image_cache_status === 'failed'
              ? `<div class="field-error active" style="margin-top:4px">Image could not be cached from the URL. Re-paste the URL or upload a file.</div>`
              : ''}
            <div class="image-edit-row">
              <label class="btn btn-secondary btn-sm image-upload-label">
                <input type="file" id="edit-cover-file" accept="image/jpeg,image/png,image/gif,image/webp" style="display:none">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;flex-shrink:0"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                Upload file
              </label>
              <button type="button" class="btn btn-ghost btn-sm" id="edit-cover-remove"${!game.image_url ? ' style="display:none"' : ''}>Remove</button>
            </div>
          </div>
        </div>
      </div>`
    : '';

  const gallerySectionHtml = isEdit
    ? `<div class="modal-section" id="gallery-section">
        <div class="section-label-row">
          <div class="section-label">Photo Gallery</div>
          <label class="btn btn-ghost btn-sm gallery-add-label" title="Add photo">
            <input type="file" id="gallery-file-input" accept="image/jpeg,image/png,image/gif,image/webp" multiple style="display:none">
            + Add Photo
          </label>
        </div>
        <div class="gallery-url-row">
          <input type="url" id="gallery-url-input" class="form-input form-input-sm" placeholder="Add image from URL…" autocomplete="off" aria-label="Add image from URL">
          <button class="btn btn-secondary btn-sm" id="gallery-url-add-btn">Add</button>
        </div>
        <div class="gallery-list" id="gallery-list"></div>
      </div>`
    : images.length > 0
      ? `<div class="modal-section">
          <div class="section-label">Photo Gallery</div>
          <div class="gallery-view-strip">${images.map((img, i) =>
            `<button class="gallery-view-thumb-btn" data-idx="${i}" aria-label="${img.caption ? escapeHtml(img.caption) : `Photo ${i + 1} of ${escapeHtml(game.name)}`}">
              <img class="gallery-view-thumb" src="/api/games/${game.id}/images/${img.id}/file" loading="lazy" alt="${img.caption ? escapeHtml(img.caption) : `Photo ${i + 1} of ${escapeHtml(game.name)}`}">
              ${img.caption ? `<span class="gallery-view-caption">${escapeHtml(img.caption)}</span>` : ''}
            </button>`
          ).join('')}</div>
        </div>`
      : '';

  const instructionsSectionHtml = isEdit
    ? `<div class="modal-section">
        <div class="section-label">Rulebook</div>
        <div class="instructions-existing" id="instructions-existing" style="${hasInstructions ? '' : 'display:none'}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          <a href="/api/games/${game.id}/instructions" target="_blank" class="instructions-link">${escapeHtml(game.instructions_filename || '')}</a>
          <button class="btn btn-ghost btn-sm" id="delete-instructions-btn">Remove</button>
        </div>
        <div class="instructions-upload" id="instructions-upload" style="${hasInstructions ? 'display:none' : ''}">
          <label class="upload-label">
            <input type="file" id="instructions-file-input" accept=".pdf,.txt" style="display:none">
            <span class="btn btn-secondary btn-sm upload-trigger">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              Upload PDF or TXT
            </span>
          </label>
        </div>
      </div>`
    : hasInstructions
      ? `<div class="modal-section">
          <div class="section-label">Rulebook</div>
          <a href="/api/games/${game.id}/instructions" target="_blank" class="btn btn-ghost btn-sm">View Rulebook</a>
        </div>`
      : '';

  const editFieldsSectionHtml = isEdit
    ? `<div class="modal-section">
        <div class="edit-form-grid">
          <div class="form-group full-width">
            <label for="edit-name">Name</label>
            <input type="text" id="edit-name" class="form-input" value="${escapeHtml(game.name)}" autocomplete="off">
            <span class="field-error" id="err-name"></span>
          </div>
          <div class="form-group">
            <label for="edit-status">Status</label>
            <select id="edit-status" class="form-input" autocomplete="off">
              <option value="owned"${game.status === 'owned' || !game.status ? ' selected' : ''}>Owned</option>
              <option value="wishlist"${game.status === 'wishlist' ? ' selected' : ''}>Wishlist</option>
              <option value="sold"${game.status === 'sold' ? ' selected' : ''}>Sold</option>
            </select>
          </div>
          <div class="form-group">
            <label for="edit-year">Year</label>
            <input type="number" id="edit-year" class="form-input" value="${game.year_published || ''}" autocomplete="off">
          </div>
          <div class="form-group">
            <label for="edit-min-players">Min Players</label>
            <input type="number" id="edit-min-players" class="form-input" value="${game.min_players || ''}" autocomplete="off">
            <span class="field-error" id="err-players"></span>
          </div>
          <div class="form-group">
            <label for="edit-max-players">Max Players</label>
            <input type="number" id="edit-max-players" class="form-input" value="${game.max_players || ''}" autocomplete="off">
          </div>
          <div class="form-group">
            <label for="edit-min-playtime">Min Playtime (min)</label>
            <input type="number" id="edit-min-playtime" class="form-input" value="${game.min_playtime || ''}" autocomplete="off">
            <span class="field-error" id="err-playtime"></span>
          </div>
          <div class="form-group">
            <label for="edit-max-playtime">Max Playtime (min)</label>
            <input type="number" id="edit-max-playtime" class="form-input" value="${game.max_playtime || ''}" autocomplete="off">
          </div>
          <div class="form-group">
            <label for="edit-difficulty">Difficulty (1–5)</label>
            <input type="number" id="edit-difficulty" class="form-input" min="1" max="5" step="0.01" value="${game.difficulty || ''}" autocomplete="off">
            <span class="field-error" id="err-difficulty"></span>
          </div>
          <div class="form-group full-width">
            <label for="edit-categories">Categories <span class="hint">(comma-separated)</span></label>
            <input type="text" id="edit-categories" class="form-input" value="${escapeHtml(categories.join(', '))}" autocomplete="off">
          </div>
          <div class="form-group full-width">
            <label for="edit-mechanics">Mechanics <span class="hint">(comma-separated)</span></label>
            <input type="text" id="edit-mechanics" class="form-input" value="${escapeHtml(mechanics.join(', '))}" autocomplete="off">
          </div>
          <div class="form-group full-width">
            <label for="edit-designers">Designers <span class="hint">(comma-separated)</span></label>
            <input type="text" id="edit-designers" class="form-input" value="${escapeHtml(designers.join(', '))}" autocomplete="off">
          </div>
          <div class="form-group full-width">
            <label for="edit-publishers">Publishers <span class="hint">(comma-separated)</span></label>
            <input type="text" id="edit-publishers" class="form-input" value="${escapeHtml(publishers.join(', '))}" autocomplete="off">
          </div>
          <div class="form-group full-width">
            <label for="edit-labels">Labels <span class="hint">(comma-separated)</span></label>
            <input type="text" id="edit-labels" class="form-input" value="${escapeHtml(modalLabels.join(', '))}" autocomplete="off">
          </div>
          ${baseGameEditHtml}
          <div class="form-group">
            <label for="edit-purchase-date">Purchase Date</label>
            <input type="date" id="edit-purchase-date" class="form-input date-input" value="${game.purchase_date || ''}" autocomplete="off">
          </div>
          <div class="form-group">
            <label for="edit-purchase-price">Purchase Price ($)</label>
            <input type="number" id="edit-purchase-price" class="form-input" step="0.01" min="0" value="${game.purchase_price != null ? game.purchase_price : ''}" autocomplete="off">
          </div>
          <div class="form-group">
            <label for="edit-sale-price">Sale Price ($)</label>
            <input type="number" id="edit-sale-price" class="form-input" step="0.01" min="0" value="${game.sale_price != null ? game.sale_price : ''}" autocomplete="off">
          </div>
          <div class="form-group full-width">
            <label for="edit-purchase-location">Purchase Location</label>
            <input type="text" id="edit-purchase-location" class="form-input" value="${escapeHtml(game.purchase_location || '')}" autocomplete="off" list="edit-purchase-location-list">
            <datalist id="edit-purchase-location-list">${_buildLocationDatalist(allGames, 'purchase_location')}</datalist>
          </div>
          <div class="form-group full-width">
            <label for="edit-location">Storage Location</label>
            <div class="input-with-toggle">
              <input type="text" id="edit-location" class="form-input" placeholder="Shelf 2, Box A…" value="${escapeHtml(game.location || '')}" autocomplete="off" list="edit-storage-location-list">
              <datalist id="edit-storage-location-list">${_buildLocationDatalist(allGames, 'location')}</datalist>
              <label class="inline-toggle">
                <input type="checkbox" id="edit-show-location"${game.show_location ? ' checked' : ''}>
                Show on card
              </label>
            </div>
          </div>
          <div class="form-group">
            <label for="edit-condition">Condition</label>
            <select id="edit-condition" class="form-input">
              <option value="">— None —</option>
              ${['New','Good','Fair','Poor'].map(c => `<option value="${c}"${game.condition === c ? ' selected' : ''}>${c}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label for="edit-edition">Edition / Version</label>
            <input type="text" id="edit-edition" class="form-input" placeholder="1st Edition, KS…" value="${escapeHtml(game.edition || '')}" autocomplete="off">
          </div>
          ${game.status === 'wishlist' ? `
          <div class="form-group">
            <label for="edit-priority">Wishlist Priority</label>
            <select id="edit-priority" class="form-input">
              <option value="">— None —</option>
              ${[1,2,3,4,5].map(n => `<option value="${n}"${game.priority === n ? ' selected' : ''}>${'★'.repeat(n)} (${n})</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label for="edit-target-price">Target Price ($)</label>
            <input type="number" id="edit-target-price" class="form-input" step="0.01" min="0" placeholder="25.00" value="${game.target_price != null ? game.target_price : ''}" autocomplete="off">
          </div>` : ''}
          <div class="form-group">
            <label for="edit-bgg-id">BGG ID <span class="hint">(for metadata refresh)</span></label>
            <input type="number" id="edit-bgg-id" class="form-input" placeholder="12345" value="${game.bgg_id || ''}" autocomplete="off">
          </div>
          <div class="form-group full-width">
            <label class="inline-toggle">
              <input type="checkbox" id="edit-share-hidden"${game.share_hidden ? ' checked' : ''}>
              Hide from shared links
            </label>
          </div>
        </div>
      </div>`
    : '';

  const actionsSectionHtml = isEdit
    ? `<div class="modal-actions">
        <button class="btn btn-danger" id="delete-game-btn">Remove from Collection</button>
        <div class="modal-actions-right">
          <button class="btn btn-secondary" id="cancel-btn">Cancel</button>
          <button class="btn btn-primary" id="save-btn">Save Changes</button>
        </div>
      </div>`
    : `<div class="modal-actions">
        <button class="btn btn-danger" id="delete-game-btn">Remove from Collection</button>
        <div class="modal-actions-right">
          ${game.bgg_id ? `<button class="btn btn-secondary" id="refresh-bgg-btn" title="Re-fetch metadata from BoardGameGeek">↻ Refresh BGG</button>` : ''}
          <button class="btn btn-secondary" id="share-game-btn" title="Share this game">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" style="margin-right:5px;vertical-align:middle"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>Share
          </button>
          <button class="btn btn-primary" id="edit-game-btn">Edit Game</button>
        </div>
      </div>`;

  el.innerHTML = `
    ${heroHtml}
    ${_navBarHtml}
    ${trophyShelfHtml}
    <div class="modal-body">
      <div class="modal-title-row">
        <h2 class="modal-title" id="modal-title">${escapeHtml(game.name)}</h2>
        ${game.year_published ? `<span class="modal-year">${game.year_published}</span>` : ''}
        ${modalStatusBadge}
      </div>

      ${partOfHtml}

      ${chipsHtml ? `<div class="modal-chips">${chipsHtml}</div>` : ''}
      ${game.difficulty ? `<div class="modal-difficulty">${renderDifficultyBar(game.difficulty)}</div>` : ''}

      ${tagsBlock('Categories', categories)}
      ${tagsBlock('Mechanics', mechanics)}
      ${tagsBlock('Designers', designers)}
      ${tagsBlock('Publishers', publishers)}
      ${expansionChipsHtml}
      ${labelsDisplayHtml}
      ${purchaseDisplayHtml}
      ${locationDisplayHtml}

      ${ratingWidgetHtml}
      ${lastPlayedWidgetHtml}
      ${descriptionSectionHtml}
      ${notesSectionHtml}
      ${coverImageSectionHtml}
      ${gallerySectionHtml}
      ${instructionsSectionHtml}

      <div class="modal-section">
        <div class="section-label-row">
          <div class="section-label">Play History</div>
          <button class="btn btn-secondary btn-sm" id="log-session-toggle">+ Log Session</button>
        </div>
        ${sparklineHtml}
        <div class="log-session-form" id="log-session-form" style="display:none">
          <div class="session-form-grid">
            <div class="form-group">
              <label for="session-date">Date</label>
              <input type="date" id="session-date" class="form-input" value="${new Date().toISOString().split('T')[0]}" autocomplete="off">
            </div>
            <div class="form-group">
              <label for="session-players">Players</label>
              <input type="number" id="session-players" class="form-input" placeholder="4" min="1" max="20" autocomplete="off">
            </div>
            <div class="form-group">
              <label for="session-duration">Duration (min)</label>
              <input type="number" id="session-duration" class="form-input" placeholder="90" min="1" autocomplete="off">
            </div>
            <div class="form-group full-width">
              <label for="session-player-names">Player Names</label>
              <input type="text" id="session-player-names" class="form-input" placeholder="Alice, Bob, Carol" autocomplete="off">
            </div>
            <div class="form-group full-width" id="session-scores-group" style="display:none">
              <label>Scores</label>
              <div class="session-scores-row" id="session-scores-container"></div>
            </div>
            <div class="form-group full-width">
              <label for="session-winner">Winner</label>
              <input type="text" id="session-winner" class="form-input" placeholder="optional" autocomplete="off">
            </div>
            <div class="form-group full-width">
              <label for="session-notes">Notes</label>
              <input type="text" id="session-notes" class="form-input" placeholder="Any highlights?" autocomplete="off">
            </div>
            <div class="form-group full-width">
              <label>Session Rating</label>
              <div class="star-picker" id="session-rating-picker" data-value="0">
                ${[1,2,3,4,5].map(n => `<button type="button" class="star-btn" data-val="${n}" title="${n} star${n>1?'s':''}">★</button>`).join('')}
              </div>
            </div>
          </div>
          <div class="session-form-actions">
            <button class="btn btn-primary btn-sm" id="session-submit">Save Session</button>
            <button class="btn btn-ghost btn-sm" id="session-cancel">Cancel</button>
          </div>
        </div>
        <div class="sessions-list" id="sessions-list">${buildSessionsHtml(sessions)}</div>
      </div>

      ${(() => {
        // Per-game player leaderboard computed from sessions
        const playerMap = {};
        let hasAnyScores = false;
        for (const s of sessions) {
          const scores = s.player_scores || {};
          if (Object.keys(scores).length) hasAnyScores = true;
          for (const p of (s.players || [])) {
            if (!playerMap[p]) playerMap[p] = { name: p, plays: 0, wins: 0, totalScore: 0, scoredPlays: 0 };
            playerMap[p].plays += 1;
            if (s.winner === p) playerMap[p].wins += 1;
            if (scores[p] != null) {
              playerMap[p].totalScore += scores[p];
              playerMap[p].scoredPlays += 1;
            }
          }
        }
        const players = Object.values(playerMap).map(p => ({
          ...p,
          avgScore: p.scoredPlays ? Math.round(p.totalScore / p.scoredPlays) : null,
          winRate: p.plays ? Math.round((p.wins / p.plays) * 100) : 0,
        }));
        if (!players.length) return '';
        // Sort by avgScore desc (if any scores exist), then wins, then plays
        players.sort((a, b) => {
          if (hasAnyScores) {
            const as = a.avgScore ?? -1;
            const bs = b.avgScore ?? -1;
            if (bs !== as) return bs - as;
          }
          if (b.wins !== a.wins) return b.wins - a.wins;
          return b.plays - a.plays;
        });
        const maxScore = hasAnyScores ? Math.max(...players.map(p => p.avgScore || 0)) : 0;
        const maxWins = Math.max(...players.map(p => p.wins));
        return `
          <div class="modal-section game-leaderboard-section">
            <div class="section-label">Game Leaderboard</div>
            <div class="most-played-list">
              ${players.map((p, i) => {
                const barMax = hasAnyScores ? maxScore : maxWins;
                const barVal = hasAnyScores ? (p.avgScore || 0) : p.wins;
                const pct = barMax ? Math.round((barVal / barMax) * 100) : 0;
                const statLabel = hasAnyScores
                  ? `Avg ${p.avgScore} · ${p.wins}W · ${p.plays}P`
                  : `${p.wins}W · ${p.plays}P · ${p.winRate}% WR`;
                return `
                  <div class="most-played-item player-leaderboard-item">
                    <div class="most-played-rank">${i + 1}</div>
                    <div class="most-played-info">
                      <div class="most-played-name">${escapeHtml(p.name)}</div>
                      <div class="stat-bar-track"><div class="stat-bar-fill" style="width:0%" data-target-width="${pct}%"></div></div>
                    </div>
                    <div class="most-played-count">
                      <span class="player-leaderboard-meta">${statLabel}</span>
                    </div>
                  </div>`;
              }).join('')}
            </div>
          </div>`;
      })()}

      ${editFieldsSectionHtml}

      ${mode === 'view' ? `<div class="modal-section similar-games-section" id="similar-games-section" style="display:none">
        <div class="section-label">Similar in Your Collection</div>
        <div class="similar-games-list" id="similar-games-list"></div>
      </div>` : ''}

      ${(game.date_added || game.date_modified) ? `
      <div class="game-dates-row">
        ${game.date_added   ? `<span><span class="game-dates-label">Added</span> ${escapeHtml(formatDatetime(game.date_added))}</span>` : ''}
        ${game.date_modified ? `<span><span class="game-dates-label">Modified</span> ${escapeHtml(formatDatetime(game.date_modified))}</span>` : ''}
      </div>` : ''}

      ${actionsSectionHtml}

      <div class="modal-close-bar">
        <button class="btn btn-ghost btn-sm modal-close-sticky-btn" aria-label="Close">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          Close
        </button>
      </div>
    </div>`;

  // Apply modal-hero background image via JS to avoid CSS injection via HTML entity decoding
  const _heroBg = el.querySelector('.modal-hero[data-bg-url]');
  if (_heroBg) _heroBg.style.backgroundImage = `url(${JSON.stringify(_heroBg.dataset.bgUrl)})`;

  // ===== Wire events =====

  el.querySelector('.modal-close')?.addEventListener('click', (e) => { e.stopPropagation(); onCloseModal(); });
  const stickyClose = el.querySelector('.modal-close-sticky-btn');
  if (stickyClose) stickyClose.addEventListener('click', (e) => { e.stopPropagation(); onCloseModal(); });
  if (navInfo) {
    const prevBtn = el.querySelector('.modal-nav-prev:not([disabled])');
    const nextBtn = el.querySelector('.modal-nav-next:not([disabled])');
    if (prevBtn && navInfo.onPrev) prevBtn.addEventListener('click', (e) => { e.stopPropagation(); navInfo.onPrev(); });
    if (nextBtn && navInfo.onNext) nextBtn.addEventListener('click', (e) => { e.stopPropagation(); navInfo.onNext(); });
  }
  const deleteGameBtn = el.querySelector('#delete-game-btn');
  deleteGameBtn.addEventListener('click', () => withLoading(deleteGameBtn, () => onDelete(game.id, game.name), 'Removing…'));

  // Sessions (always wired)
  const sessionToggle = el.querySelector('#log-session-toggle');
  const sessionForm   = el.querySelector('#log-session-form');
  sessionToggle.addEventListener('click', () => {
    const open = sessionForm.style.display !== 'none';
    sessionForm.style.display = open ? 'none' : 'block';
    sessionToggle.textContent = open ? '+ Log Session' : '− Cancel';
  });
  el.querySelector('#session-cancel').addEventListener('click', () => {
    sessionForm.style.display = 'none';
    sessionToggle.textContent = '+ Log Session';
    el.querySelector('#session-date').value = '';
    el.querySelector('#session-players').value = '';
    el.querySelector('#session-duration').value = '';
    el.querySelector('#session-player-names').value = '';
    el.querySelector('#session-winner').value = '';
    el.querySelector('#session-notes').value = '';
    const rp = el.querySelector('#session-rating-picker');
    if (rp) { rp.dataset.value = '0'; rp.querySelectorAll('.star-btn').forEach(b => b.classList.remove('active')); }
    const scGroup = el.querySelector('#session-scores-group');
    const scContainer = el.querySelector('#session-scores-container');
    if (scGroup) scGroup.style.display = 'none';
    if (scContainer) scContainer.innerHTML = '';
  });

  // Dynamic score inputs for log form
  function renderLogScoreInputs() {
    const namesRaw = el.querySelector('#session-player-names').value.trim();
    const names = namesRaw ? namesRaw.split(',').map(n => n.trim()).filter(Boolean) : [];
    const scGroup = el.querySelector('#session-scores-group');
    const scContainer = el.querySelector('#session-scores-container');
    if (!scGroup || !scContainer) return;
    if (names.length < 2) {
      scGroup.style.display = 'none';
      scContainer.innerHTML = '';
      return;
    }
    scGroup.style.display = '';
    scContainer.innerHTML = names.map(name => `
      <div class="session-score-field">
        <span class="session-score-label">${escapeHtml(name)}</span>
        <input type="number" class="form-input session-score-input" data-player="${escapeHtml(name)}" placeholder="0" min="0">
      </div>`).join('');
  }
  el.querySelector('#session-player-names').addEventListener('input', renderLogScoreInputs);

  // Star picker interaction (log form)
  const _ratingPicker = el.querySelector('#session-rating-picker');
  if (_ratingPicker) {
    _ratingPicker.addEventListener('click', e => {
      const btn = e.target.closest('.star-btn');
      if (!btn) return;
      const val = parseInt(btn.dataset.val, 10);
      _ratingPicker.dataset.value = val;
      _ratingPicker.querySelectorAll('.star-btn').forEach(b => b.classList.toggle('active', parseInt(b.dataset.val, 10) <= val));
    });
    _ratingPicker.addEventListener('mouseover', e => {
      const btn = e.target.closest('.star-btn');
      if (!btn) return;
      const val = parseInt(btn.dataset.val, 10);
      _ratingPicker.querySelectorAll('.star-btn').forEach(b => b.classList.toggle('active', parseInt(b.dataset.val, 10) <= val));
    });
    _ratingPicker.addEventListener('mouseleave', () => {
      const saved = parseInt(_ratingPicker.dataset.value, 10) || 0;
      _ratingPicker.querySelectorAll('.star-btn').forEach(b => b.classList.toggle('active', parseInt(b.dataset.val, 10) <= saved));
    });
  }

  const sessionSubmitBtn = el.querySelector('#session-submit');
  sessionSubmitBtn.addEventListener('click', () => {
    const dateVal = el.querySelector('#session-date').value;
    if (!dateVal) { showToast('Please enter a date.', 'error'); return; }

    const playerNamesRaw = el.querySelector('#session-player-names').value.trim();
    const playerNames = playerNamesRaw
      ? playerNamesRaw.split(',').map(n => n.trim()).filter(Boolean)
      : null;

    const _rp = el.querySelector('#session-rating-picker');
    const scores = {};
    el.querySelectorAll('#session-scores-container .session-score-input').forEach(inp => {
      const val = parseInt(inp.value, 10);
      if (!isNaN(val)) scores[inp.dataset.player] = val;
    });
    const sessionData = {
      played_at:        dateVal,
      player_count:     parseInt(el.querySelector('#session-players').value, 10) || null,
      duration_minutes: parseInt(el.querySelector('#session-duration').value, 10) || null,
      winner:           el.querySelector('#session-winner').value.trim() || null,
      notes:            el.querySelector('#session-notes').value.trim() || null,
      session_rating:   _rp ? (parseInt(_rp.dataset.value, 10) || null) : null,
      player_names:     playerNames,
      scores:           Object.keys(scores).length ? scores : null,
    };

    withLoading(sessionSubmitBtn, () => onAddSession(game.id, sessionData, (created) => {
      const list = el.querySelector('#sessions-list');
      const noSessions = list.querySelector('.no-sessions');
      if (noSessions) noSessions.remove();

      const item = document.createElement('div');
      item.className = 'session-item';
      item.dataset.sessionId = created.id;
      item.innerHTML = `
        <div class="session-info">${buildSessionInfoHtml(created)}</div>
        <button class="session-edit" data-session-id="${created.id}" title="Edit session">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="session-delete" data-session-id="${created.id}" title="Delete">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>
        </button>`;
      list.prepend(item);

      el.querySelector('#session-date').value = '';
      el.querySelector('#session-players').value = '';
      el.querySelector('#session-duration').value = '';
      el.querySelector('#session-player-names').value = '';
      el.querySelector('#session-winner').value = '';
      el.querySelector('#session-notes').value = '';
      const _rpr = el.querySelector('#session-rating-picker');
      if (_rpr) { _rpr.dataset.value = '0'; _rpr.querySelectorAll('.star-btn').forEach(b => b.classList.remove('active')); }
      const scGroup = el.querySelector('#session-scores-group');
      const scContainer = el.querySelector('#session-scores-container');
      if (scGroup) scGroup.style.display = 'none';
      if (scContainer) scContainer.innerHTML = '';
      sessionForm.style.display = 'none';
      sessionToggle.textContent = '+ Log Session';
    }), 'Logging…');
  });

  el.querySelector('#sessions-list').addEventListener('click', e => {
    const deleteBtn = e.target.closest('.session-delete');
    if (deleteBtn) {
      const sessionId = parseInt(deleteBtn.dataset.sessionId, 10);
      const capturedData = sessions.find(s => s.id === sessionId);
      onDeleteSession(sessionId, game.id, () => {
        const item = el.querySelector(`.session-item[data-session-id="${sessionId}"]`);
        if (item) item.remove();
        if (!el.querySelector('#sessions-list .session-item')) {
          el.querySelector('#sessions-list').innerHTML = `<div class="no-sessions">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
            <span class="no-sessions-text">No sessions logged yet.<br>Log your first play to start tracking.</span>
          </div>`;
        }
      }, capturedData);
      return;
    }

    const editBtn = e.target.closest('.session-edit');
    if (editBtn) {
      const sessionId = parseInt(editBtn.dataset.sessionId, 10);
      const item = el.querySelector(`.session-item[data-session-id="${sessionId}"]`);
      if (!item || item.querySelector('.session-edit-form')) return;

      const info = item.querySelector('.session-info');
      const s = sessions.find(x => x.id === sessionId);

      const form = document.createElement('div');
      form.className = 'session-edit-form';
      form.innerHTML = `
        <div class="session-form-grid">
          <div class="form-group">
            <label>Date</label>
            <input type="date" class="form-input se-date" autocomplete="off">
          </div>
          <div class="form-group">
            <label>Players</label>
            <input type="number" class="form-input se-players" min="1" max="20" placeholder="optional" autocomplete="off">
          </div>
          <div class="form-group">
            <label>Duration (min)</label>
            <input type="number" class="form-input se-duration" min="1" placeholder="optional" autocomplete="off">
          </div>
          <div class="form-group full-width">
            <label>Player Names</label>
            <input type="text" class="form-input se-player-names" placeholder="Alice, Bob, Carol" autocomplete="off">
          </div>
          <div class="form-group full-width se-scores-group" style="display:none">
            <label>Scores</label>
            <div class="session-scores-row se-scores-container"></div>
          </div>
          <div class="form-group full-width">
            <label>Winner</label>
            <input type="text" class="form-input se-winner" placeholder="optional" autocomplete="off">
          </div>
          <div class="form-group full-width">
            <label>Notes</label>
            <input type="text" class="form-input se-notes" placeholder="optional" autocomplete="off">
          </div>
          <div class="form-group full-width">
            <label>Session Rating</label>
            <div class="star-picker se-rating" data-value="0">
              ${[1,2,3,4,5].map(n => `<button type="button" class="star-btn" data-val="${n}" title="${n} star${n>1?'s':''}">★</button>`).join('')}
            </div>
          </div>
        </div>
        <div class="session-form-actions">
          <button class="btn btn-primary btn-sm se-save">Save</button>
          <button class="btn btn-ghost btn-sm se-cancel">Cancel</button>
        </div>`;

      function renderEditScoreInputs(prefillScores = {}) {
        const namesRaw = form.querySelector('.se-player-names').value.trim();
        const names = namesRaw ? namesRaw.split(',').map(n => n.trim()).filter(Boolean) : [];
        const scGroup = form.querySelector('.se-scores-group');
        const scContainer = form.querySelector('.se-scores-container');
        if (!scGroup || !scContainer) return;
        if (names.length < 2) {
          scGroup.style.display = 'none';
          scContainer.innerHTML = '';
          return;
        }
        scGroup.style.display = '';
        scContainer.innerHTML = names.map(name => {
          const val = prefillScores[name] != null ? prefillScores[name] : '';
          return `
            <div class="session-score-field">
              <span class="session-score-label">${escapeHtml(name)}</span>
              <input type="number" class="form-input session-score-input" data-player="${escapeHtml(name)}" placeholder="0" min="0" value="${val !== '' ? val : ''}">
            </div>`;
        }).join('');
      }

      if (s) {
        form.querySelector('.se-date').value = s.played_at || '';
        form.querySelector('.se-players').value = s.player_count || '';
        form.querySelector('.se-duration').value = s.duration_minutes || '';
        form.querySelector('.se-player-names').value = (s.players || []).join(', ');
        form.querySelector('.se-winner').value = s.winner || '';
        form.querySelector('.se-notes').value = s.notes || '';
        const seRp = form.querySelector('.se-rating');
        if (seRp && s.session_rating) {
          seRp.dataset.value = s.session_rating;
          seRp.querySelectorAll('.star-btn').forEach(b => b.classList.toggle('active', parseInt(b.dataset.val, 10) <= s.session_rating));
        }
        renderEditScoreInputs(s.player_scores || {});
      } else {
        renderEditScoreInputs();
      }
      form.querySelector('.se-player-names').addEventListener('input', () => renderEditScoreInputs());

      // Star picker interaction (edit form)
      const seRatingPicker = form.querySelector('.se-rating');
      if (seRatingPicker) {
        seRatingPicker.addEventListener('click', e => {
          const btn = e.target.closest('.star-btn');
          if (!btn) return;
          const val = parseInt(btn.dataset.val, 10);
          seRatingPicker.dataset.value = val;
          seRatingPicker.querySelectorAll('.star-btn').forEach(b => b.classList.toggle('active', parseInt(b.dataset.val, 10) <= val));
        });
        seRatingPicker.addEventListener('mouseover', e => {
          const btn = e.target.closest('.star-btn');
          if (!btn) return;
          const val = parseInt(btn.dataset.val, 10);
          seRatingPicker.querySelectorAll('.star-btn').forEach(b => b.classList.toggle('active', parseInt(b.dataset.val, 10) <= val));
        });
        seRatingPicker.addEventListener('mouseleave', () => {
          const saved = parseInt(seRatingPicker.dataset.value, 10) || 0;
          seRatingPicker.querySelectorAll('.star-btn').forEach(b => b.classList.toggle('active', parseInt(b.dataset.val, 10) <= saved));
        });
      }

      info.style.display = 'none';
      editBtn.style.display = 'none';
      item.querySelector('.session-delete').style.display = 'none';
      item.appendChild(form);

      form.querySelector('.se-cancel').addEventListener('click', () => {
        form.remove();
        info.style.display = '';
        editBtn.style.display = '';
        item.querySelector('.session-delete').style.display = '';
      });

      const saveBtn = form.querySelector('.se-save');
      saveBtn.addEventListener('click', () => {
        const dateVal = form.querySelector('.se-date').value;
        if (!dateVal) { showToast('Please enter a date.', 'error'); return; }
        const playerNamesRaw = form.querySelector('.se-player-names').value.trim();
        const playerNames = playerNamesRaw ? playerNamesRaw.split(',').map(n => n.trim()).filter(Boolean) : null;
        const seRp = form.querySelector('.se-rating');
        const scores = {};
        form.querySelectorAll('.se-scores-container .session-score-input').forEach(inp => {
          const val = parseInt(inp.value, 10);
          if (!isNaN(val)) scores[inp.dataset.player] = val;
        });
        const data = {
          played_at:        dateVal,
          player_count:     parseInt(form.querySelector('.se-players').value, 10) || null,
          duration_minutes: parseInt(form.querySelector('.se-duration').value, 10) || null,
          winner:           form.querySelector('.se-winner').value.trim() || null,
          notes:            form.querySelector('.se-notes').value.trim() || null,
          session_rating:   seRp ? (parseInt(seRp.dataset.value, 10) || null) : null,
          player_names:     playerNames,
          scores:           Object.keys(scores).length ? scores : null,
        };
        withLoading(saveBtn, () => onUpdateSession(sessionId, game.id, data, (updated) => {
          form.remove();
          info.innerHTML = buildSessionInfoHtml(updated);
          // Keep local sessions in sync for future edits
          const idx = sessions.findIndex(x => x.id === sessionId);
          if (idx !== -1) sessions[idx] = updated;
          info.style.display = '';
          editBtn.style.display = '';
          item.querySelector('.session-delete').style.display = '';
        }), 'Saving…');
      });
    }
  });

  if (!isEdit) {
    // ===== View mode wiring =====
    el.querySelector('#edit-game-btn').addEventListener('click', () => onSwitchToEdit());

    const shareGameBtn = el.querySelector('#share-game-btn');
    if (shareGameBtn) {
      shareGameBtn.addEventListener('click', () => shareGameCard(game));
    }

    const refreshBggBtn = el.querySelector('#refresh-bgg-btn');
    if (refreshBggBtn) {
      refreshBggBtn.addEventListener('click', async () => {
        await withLoading(refreshBggBtn, async () => {
          const updated = await API.refreshFromBGG(game.id);
          showToast('Metadata refreshed from BGG!', 'success');
          onSwitchToView && onSwitchToView(updated);
        }, 'Refreshing…');
      });
    }

    // Expansion: "Part of [Base]" link
    const partOfBtn = el.querySelector('.modal-part-of .expansion-link-btn');
    if (partOfBtn && onOpenGame) {
      partOfBtn.addEventListener('click', () => {
        const targetId = parseInt(partOfBtn.dataset.gameId, 10);
        const target = allGames.find(g => g.id === targetId);
        if (target) onOpenGame(target);
      });
    }

    // Expansion chips on base game modal
    el.querySelectorAll('.expansion-chip').forEach(chip => {
      if (!onOpenGame) return;
      chip.addEventListener('click', () => {
        const targetId = parseInt(chip.dataset.gameId, 10);
        const target = allGames.find(g => g.id === targetId);
        if (target) onOpenGame(target);
      });
    });

    // Gallery strip thumbnails → lightbox
    el.querySelectorAll('.gallery-view-thumb-btn').forEach(btn => {
      btn.addEventListener('click', () => openGalleryLightbox(images, parseInt(btn.dataset.idx, 10)));
    });

    // Hero image → lightbox
    const _heroClickSrc = game.thumbnail_url || game.image_url;
    if (isSafeUrl(_heroClickSrc)) {
      const hero = el.querySelector('.modal-hero');
      if (hero) {
        hero.style.cursor = 'zoom-in';
        if (images.length > 0 && game.image_url && game.image_url.includes('/images/')) {
          hero.addEventListener('click', () => openGalleryLightbox(images, 0));
        } else {
          hero.addEventListener('click', () => openSingleImageLightbox(_heroClickSrc, game.name));
        }
      }
    }

    // Similar games — lazy loaded
    const similarSection = el.querySelector('#similar-games-section');
    const similarList    = el.querySelector('#similar-games-list');
    if (similarSection && similarList && typeof API !== 'undefined') {
      API.getSimilarGames(game.id).then(similar => {
        if (!similar || !similar.length) return;
        similarSection.style.display = '';
        similarList.innerHTML = similar.map(g => `
          <button class="similar-game-chip" data-game-id="${g.id}" type="button">
            ${isSafeUrl(g.image_url || g.thumbnail_url)
              ? `<img class="similar-game-thumb" src="${escapeHtml(g.thumbnail_url || g.image_url)}" alt="" loading="lazy">`
              : '<div class="similar-game-thumb-empty"></div>'}
            <span class="similar-game-name">${escapeHtml(g.name)}</span>
          </button>`).join('');
        if (onOpenGame) {
          similarList.querySelectorAll('.similar-game-chip').forEach(btn => {
            btn.addEventListener('click', () => {
              const target = allGames.find(g => g.id === parseInt(btn.dataset.gameId, 10));
              if (target) onOpenGame(target);
            });
          });
        }
      }).catch(() => { /* non-fatal */ });
    }

    const descText   = el.querySelector('#desc-text');
    const descToggle = el.querySelector('#desc-toggle');
    if (descText && descToggle) {
      descText.style.webkitLineClamp = '4';
      descText.style.overflow = 'hidden';
      descText.style.display = '-webkit-box';
      descText.style.webkitBoxOrient = 'vertical';
      descToggle.addEventListener('click', () => {
        const expanded = descText.style.webkitLineClamp === 'unset';
        descText.style.webkitLineClamp = expanded ? '4' : 'unset';
        descToggle.textContent = expanded ? 'Show more' : 'Show less';
      });
    }
  } else {
    // ===== Edit mode wiring =====
    el.querySelector('#cancel-btn').addEventListener('click', () => onSwitchToView());

    // Rating
    const starsContainer = el.querySelector('#rating-stars');
    const ratingDisplay  = el.querySelector('#rating-display');

    function updateStarDisplay(value) {
      starsContainer.querySelectorAll('.star-btn').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.value, 10) <= (value || 0));
      });
      ratingDisplay.textContent = value || '—';
    }

    starsContainer.addEventListener('mouseover', e => {
      const btn = e.target.closest('.star-btn');
      if (btn) updateStarDisplay(parseInt(btn.dataset.value, 10));
    });
    starsContainer.addEventListener('mouseleave', () => updateStarDisplay(selectedRating));
    starsContainer.addEventListener('click', e => {
      const btn = e.target.closest('.star-btn');
      if (btn) { selectedRating = parseInt(btn.dataset.value, 10); updateStarDisplay(selectedRating); }
    });
    el.querySelector('#rating-clear').addEventListener('click', () => { selectedRating = null; updateStarDisplay(null); });

    // Today button
    el.querySelector('#today-btn').addEventListener('click', () => {
      el.querySelector('#last-played-input').value = new Date().toISOString().split('T')[0];
    });

    // Base game picker
    const baseSearch   = el.querySelector('#edit-base-game-search');
    const baseIdInput  = el.querySelector('#edit-base-game-id');
    const baseClear    = el.querySelector('#edit-base-game-clear');
    const baseDropdown = el.querySelector('#base-game-dropdown');

    if (baseSearch) {
      baseSearch.addEventListener('input', () => {
        const q = baseSearch.value.trim().toLowerCase();
        if (!q) { baseDropdown.style.display = 'none'; return; }
        const matches = baseGameOptions.filter(g => g.name.toLowerCase().includes(q)).slice(0, 8);
        if (!matches.length) { baseDropdown.style.display = 'none'; return; }
        baseDropdown.innerHTML = matches.map(g =>
          `<button class="base-game-option" data-id="${g.id}" data-name="${escapeHtml(g.name)}">${escapeHtml(g.name)}</button>`
        ).join('');
        baseDropdown.style.display = 'block';
      });

      baseDropdown.addEventListener('mousedown', e => {
        const opt = e.target.closest('.base-game-option');
        if (!opt) return;
        e.preventDefault();
        baseIdInput.value  = opt.dataset.id;
        baseSearch.value   = opt.dataset.name;
        baseDropdown.style.display = 'none';
        baseClear.style.display = '';
      });

      baseSearch.addEventListener('blur', () => {
        setTimeout(() => { baseDropdown.style.display = 'none'; }, 150);
      });

      baseClear.addEventListener('click', () => {
        baseIdInput.value  = '';
        baseSearch.value   = '';
        baseClear.style.display = 'none';
        baseDropdown.style.display = 'none';
      });
    }

    // Instructions upload
    const fileInput = el.querySelector('#instructions-file-input');
    if (fileInput) {
      fileInput.addEventListener('change', () => {
        const file = fileInput.files[0];
        if (!file) return;
        onUploadInstructions(game.id, file, (filename) => {
          const existing = el.querySelector('#instructions-existing');
          existing.style.display = 'flex';
          existing.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            <a href="/api/games/${game.id}/instructions" target="_blank" class="instructions-link">${escapeHtml(filename)}</a>
            <button class="btn btn-ghost btn-sm" id="delete-instructions-btn">Remove</button>`;
          el.querySelector('#instructions-upload').style.display = 'none';
          wireDeleteInstructions();
        });
      });
    }

    function wireDeleteInstructions() {
      const deleteBtn = el.querySelector('#delete-instructions-btn');
      if (deleteBtn) {
        deleteBtn.addEventListener('click', () => {
          onDeleteInstructions(game.id, () => {
            el.querySelector('#instructions-existing').style.display = 'none';
            el.querySelector('#instructions-upload').style.display = 'block';
          });
        });
      }
    }
    wireDeleteInstructions();

    // Image URL tracking
    let currentImageUrl = game.image_url || null;

    // Cover image section
    const coverUrlInput  = el.querySelector('#edit-cover-url');
    const coverFileInput = el.querySelector('#edit-cover-file');
    const coverRemoveBtn = el.querySelector('#edit-cover-remove');
    const coverPreview   = el.querySelector('#edit-cover-preview');

    function setCoverPreview(url) {
      if (!coverPreview) return;
      coverPreview.innerHTML = url
        ? `<img src="${escapeHtml(url)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:var(--radius-sm)">`
        : '<span class="image-edit-empty">No image</span>';
      if (coverRemoveBtn) coverRemoveBtn.style.display = url ? '' : 'none';
    }

    if (coverUrlInput) {
      coverUrlInput.addEventListener('input', () => {
        const url = coverUrlInput.value.trim();
        currentImageUrl = url || null;
        setCoverPreview(currentImageUrl);
      });
    }

    if (coverFileInput) {
      coverFileInput.addEventListener('change', () => {
        const file = coverFileInput.files[0];
        if (!file) return;
        if (coverUrlInput) coverUrlInput.value = '';
        onUploadImage(game.id, file, () => {
          const newUrl = `/api/games/${game.id}/image?t=${Date.now()}`;
          currentImageUrl = `/api/games/${game.id}/image`;
          setCoverPreview(newUrl);
        });
      });
    }

    if (coverRemoveBtn) {
      coverRemoveBtn.addEventListener('click', () => {
        onDeleteImage(game.id, () => {
          currentImageUrl = null;
          if (coverUrlInput) coverUrlInput.value = '';
          setCoverPreview(null);
        });
      });
    }

    // Gallery
    let galleryImages = Array.isArray(images) ? [...images] : [];

    let _dragSrcImgId = null;

    function buildGalleryItemEl(img, index) {
      const item = document.createElement('div');
      item.className = 'gallery-list-item';
      item.dataset.imgId = img.id;
      item.draggable = true;
      item.innerHTML = `
        <span class="gallery-drag-handle" aria-hidden="true">⠿</span>
        <img class="gallery-thumb" src="/api/games/${game.id}/images/${img.id}/file" loading="lazy" alt="${img.caption ? escapeHtml(img.caption) : `Photo ${index + 1} of ${escapeHtml(game.name)}`}">
        <div class="gallery-item-info">
          ${index === 0 ? '<span class="gallery-featured-badge">★ Featured</span>' : '<span class="gallery-item-num">#' + (index + 1) + '</span>'}
        </div>
        <div class="gallery-item-controls">
          <button class="btn btn-ghost btn-sm gallery-delete" title="Remove photo" aria-label="Remove photo">Remove</button>
        </div>
        <input type="text" class="gallery-caption-input form-input form-input-sm"
               placeholder="Add caption…" value="${escapeHtml(img.caption || '')}">`;

      item.addEventListener('dragstart', e => {
        _dragSrcImgId = img.id;
        item.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      item.addEventListener('dragend', () => {
        item.classList.remove('dragging');
        el.querySelectorAll('.gallery-list-item.drag-over').forEach(r => r.classList.remove('drag-over'));
      });
      item.addEventListener('dragover', e => {
        e.preventDefault();
        if (img.id !== _dragSrcImgId) item.classList.add('drag-over');
      });
      item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
      item.addEventListener('drop', e => {
        e.preventDefault();
        item.classList.remove('drag-over');
        if (!_dragSrcImgId || _dragSrcImgId === img.id) return;
        const srcIdx = galleryImages.findIndex(g => g.id === _dragSrcImgId);
        const dstIdx = galleryImages.findIndex(g => g.id === img.id);
        if (srcIdx === -1 || dstIdx === -1) return;
        const newOrder = [...galleryImages];
        const [moved] = newOrder.splice(srcIdx, 1);
        newOrder.splice(dstIdx, 0, moved);
        const newPrimaryUrl = `/api/games/${game.id}/images/${newOrder[0].id}/file`;
        onReorderGalleryImages(game.id, newOrder.map(g => g.id), newPrimaryUrl, () => {
          galleryImages.splice(0, galleryImages.length, ...newOrder);
          renderGallery();
          onGalleryPrimaryChanged(newPrimaryUrl);
        });
      });

      return item;
    }

    function renderGallery() {
      const list = el.querySelector('#gallery-list');
      list.innerHTML = '';
      if (galleryImages.length === 0) {
        list.innerHTML = '<p class="no-gallery">No photos yet. Use "+ Add Photo" to upload images.</p>';
        return;
      }
      galleryImages.forEach((img, i) => {
        const item = buildGalleryItemEl(img, i);
        list.appendChild(item);

        const captionInput = item.querySelector('.gallery-caption-input');
        captionInput.addEventListener('blur', () => {
          const newCaption = captionInput.value.trim() || null;
          if (newCaption === (img.caption || null)) return;
          onUpdateGalleryImageCaption(game.id, img.id, newCaption, (updated) => {
            img.caption = updated.caption;
          });
        });

        // Capture img.id (not index i) so concurrent deletes don't corrupt the reference
        const imgId = img.id;
        item.querySelector('.gallery-delete').addEventListener('click', () => {
          const afterDelete = galleryImages.filter(g => g.id !== imgId);
          const wasFirst = galleryImages.findIndex(g => g.id === imgId) === 0;
          const newPrimaryUrl = afterDelete.length > 0
            ? `/api/games/${game.id}/images/${afterDelete[0].id}/file`
            : null;
          onDeleteGalleryImage(game.id, imgId, newPrimaryUrl, () => {
            galleryImages.splice(0, galleryImages.length, ...afterDelete);
            renderGallery();
            if (wasFirst) onGalleryPrimaryChanged(newPrimaryUrl);
          });
        });
      });
    }

    function onGalleryPrimaryChanged(newUrl) {
      currentImageUrl = newUrl;
    }

    const galleryFileInput = el.querySelector('#gallery-file-input');
    if (galleryFileInput) {
      galleryFileInput.addEventListener('change', async () => {
        const files = Array.from(galleryFileInput.files);
        for (const file of files) {
          try {
            await onUploadGalleryImage(game.id, file, (newImg) => {
              galleryImages.push(newImg);
              renderGallery();
              if (galleryImages.length === 1) {
                onGalleryPrimaryChanged(`/api/games/${game.id}/images/${newImg.id}/file`);
              }
            });
          } catch (err) {
            showToast(`Failed to upload "${file.name}": ${err.message || 'Unknown error'}`, 'error');
          }
        }
        galleryFileInput.value = '';
      });
    }

    renderGallery();

    // Gallery URL add
    const galleryUrlInput = el.querySelector('#gallery-url-input');
    const galleryUrlAddBtn = el.querySelector('#gallery-url-add-btn');
    if (galleryUrlAddBtn) {
      galleryUrlAddBtn.addEventListener('click', () => {
        const url = galleryUrlInput.value.trim();
        if (!url) return;
        if (!isSafeUrl(url)) { showToast('Please enter a valid http/https URL', 'error'); return; }
        galleryUrlAddBtn.disabled = true;
        galleryUrlAddBtn.textContent = 'Adding…';
        const resetBtn = () => { galleryUrlAddBtn.disabled = false; galleryUrlAddBtn.textContent = 'Add'; };
        onAddGalleryImageFromUrl(game.id, url, (newImg) => {
          galleryUrlInput.value = '';
          resetBtn();
          galleryImages.push(newImg);
          renderGallery();
          if (galleryImages.length === 1) {
            onGalleryPrimaryChanged(`/api/games/${game.id}/images/${newImg.id}/file`);
          }
        }, resetBtn);
      });
    }

    // Save
    function csvToJson(val) {
      const items = (val || '').split(',').map(s => s.trim()).filter(Boolean);
      return items.length ? JSON.stringify(items) : null;
    }

    // Inline validation helpers
    function _fieldError(id, msg) {
      const span = el.querySelector(`#${id}`);
      if (!span) return;
      span.textContent = msg || '';
      span.classList.toggle('active', !!msg);
      // Also mark the associated input invalid
      const input = el.querySelector(`[aria-describedby="${id}"], #${id.replace('err-', 'edit-')}`);
      if (input) input.classList.toggle('invalid', !!msg);
    }
    function _clearErrors() {
      el.querySelectorAll('.field-error.active').forEach(s => { s.textContent = ''; s.classList.remove('active'); });
      el.querySelectorAll('.form-input.invalid').forEach(i => i.classList.remove('invalid'));
    }

    // Clear field error on input change
    [
      ['#edit-name',        'err-name'],
      ['#edit-min-players', 'err-players'],
      ['#edit-max-players', 'err-players'],
      ['#edit-min-playtime','err-playtime'],
      ['#edit-max-playtime','err-playtime'],
      ['#edit-difficulty',  'err-difficulty'],
    ].forEach(([sel, errId]) => {
      el.querySelector(sel)?.addEventListener('input', () => _fieldError(errId, ''));
    });

    const saveBtn = el.querySelector('#save-btn');
    saveBtn.addEventListener('click', () => {
      _clearErrors();
      let hasError = false;

      const name = el.querySelector('#edit-name').value.trim();
      if (!name) {
        _fieldError('err-name', 'Game name cannot be empty.');
        el.querySelector('#edit-name').classList.add('invalid');
        hasError = true;
      }

      const minP = parseInt(el.querySelector('#edit-min-players').value, 10);
      const maxP = parseInt(el.querySelector('#edit-max-players').value, 10);
      if (!isNaN(minP) && !isNaN(maxP) && minP > maxP) {
        _fieldError('err-players', 'Max players must be ≥ min players.');
        el.querySelector('#edit-min-players').classList.add('invalid');
        el.querySelector('#edit-max-players').classList.add('invalid');
        hasError = true;
      }

      const minT = parseInt(el.querySelector('#edit-min-playtime').value, 10);
      const maxT = parseInt(el.querySelector('#edit-max-playtime').value, 10);
      if (!isNaN(minT) && !isNaN(maxT) && minT > maxT) {
        _fieldError('err-playtime', 'Max playtime must be ≥ min playtime.');
        el.querySelector('#edit-min-playtime').classList.add('invalid');
        el.querySelector('#edit-max-playtime').classList.add('invalid');
        hasError = true;
      }

      const diffEl = el.querySelector('#edit-difficulty');
      const diff = parseFloat(diffEl.value);
      if (diffEl.value && (diff < 1 || diff > 5)) {
        _fieldError('err-difficulty', 'Difficulty must be between 1 and 5.');
        diffEl.classList.add('invalid');
        hasError = true;
      }

      if (hasError) {
        // Scroll first error into view
        el.querySelector('.field-error.active')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        return;
      }

      const payload = {
        user_rating:      selectedRating || null,
        user_notes:       el.querySelector('#user-notes').value.trim() || null,
        last_played:      el.querySelector('#last-played-input').value || null,
        name:             name,
        status:           el.querySelector('#edit-status').value || 'owned',
        year_published:   parseInt(el.querySelector('#edit-year').value, 10) || null,
        min_players:      parseInt(el.querySelector('#edit-min-players').value, 10) || null,
        max_players:      parseInt(el.querySelector('#edit-max-players').value, 10) || null,
        min_playtime:     parseInt(el.querySelector('#edit-min-playtime').value, 10) || null,
        max_playtime:     parseInt(el.querySelector('#edit-max-playtime').value, 10) || null,
        difficulty:       (() => { const _d = parseFloat(el.querySelector('#edit-difficulty').value); return isNaN(_d) ? null : _d; })(),
        image_url:        currentImageUrl,
        description:      el.querySelector('#edit-description').value.trim() || null,
        categories:       csvToJson(el.querySelector('#edit-categories').value),
        mechanics:        csvToJson(el.querySelector('#edit-mechanics').value),
        designers:        csvToJson(el.querySelector('#edit-designers').value),
        publishers:       csvToJson(el.querySelector('#edit-publishers').value),
        labels:           csvToJson(el.querySelector('#edit-labels').value),
        purchase_date:    el.querySelector('#edit-purchase-date').value || null,
        purchase_price:   el.querySelector('#edit-purchase-price').value !== '' ? parseFloat(el.querySelector('#edit-purchase-price').value) : null,
        sale_price:       el.querySelector('#edit-sale-price').value !== '' ? parseFloat(el.querySelector('#edit-sale-price').value) : null,
        purchase_location: el.querySelector('#edit-purchase-location').value.trim() || null,
        location:           el.querySelector('#edit-location').value.trim() || null,
        show_location:      el.querySelector('#edit-show-location').checked,
        parent_game_id:     parseInt(el.querySelector('#edit-base-game-id').value, 10) || null,
        condition:          el.querySelector('#edit-condition')?.value || null,
        edition:            el.querySelector('#edit-edition')?.value.trim() || null,
        priority:           el.querySelector('#edit-priority')?.value ? parseInt(el.querySelector('#edit-priority').value, 10) : null,
        target_price:       (() => { const _tp = parseFloat(el.querySelector('#edit-target-price')?.value); return isNaN(_tp) ? null : _tp; })(),
        bgg_id:             el.querySelector('#edit-bgg-id')?.value ? parseInt(el.querySelector('#edit-bgg-id').value, 10) || null : null,
        share_hidden:       el.querySelector('#edit-share-hidden')?.checked ?? false,
      };
      withLoading(saveBtn, () => onSave(game.id, payload), 'Saving…');
    });
  }

  return el;
}

// ===== Month Drill-Down List =====

function buildMonthGameList(title, games, onGameClick, onClose) {
  const el = document.createElement('div');
  el.className = 'month-drilldown';
  el.innerHTML = `
    <div class="month-drilldown-header">
      <h2 class="month-drilldown-title">${escapeHtml(title)}</h2>
      <button class="month-drilldown-close" aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>
    <div class="month-drilldown-list"></div>`;
  el.querySelector('.month-drilldown-close').addEventListener('click', onClose);
  const list = el.querySelector('.month-drilldown-list');
  if (!games.length) {
    list.innerHTML = `<div class="secondary-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
      <span class="secondary-empty-text">No sessions logged for this period.</span>
    </div>`;
  } else {
    for (const game of games) {
      const item = buildGameListItem(game);
      item.addEventListener('click', e => {
        if (e.target.closest('.quick-log-btn, .quick-owned-btn')) return;
        onGameClick(game);
      });
      list.appendChild(item);
    }
  }
  return el;
}

function buildPlayerSessionList(playerName, sessions, onGameClick, onClose) {
  const el = document.createElement('div');
  el.className = 'month-drilldown';
  el.innerHTML = `
    <div class="month-drilldown-header">
      <h2 class="month-drilldown-title">${escapeHtml(playerName)} · ${pluralize(sessions.length, 'session')}</h2>
      <button class="month-drilldown-close" aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>
    <div class="month-drilldown-list"></div>`;
  el.querySelector('.month-drilldown-close').addEventListener('click', onClose);
  const list = el.querySelector('.month-drilldown-list');
  if (!sessions.length) {
    list.innerHTML = `<div class="secondary-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
      <span class="secondary-empty-text">No sessions found for this player.</span>
    </div>`;
  } else {
    for (const s of sessions) {
      const item = document.createElement('div');
      item.className = 'player-session-row';
      item.dataset.gameId = s.game_id;
      const scores = s.player_scores || {};
      const playersHtml = s.players && s.players.length
        ? s.players.map(p => scores[p] != null
            ? `${escapeHtml(p)} <span class="session-score">${scores[p]}</span>`
            : escapeHtml(p)).join(', ')
        : '';
      item.innerHTML = `
        <div class="player-session-thumb">
          ${s.game_thumbnail
            ? `<img src="${escapeHtml(s.game_thumbnail)}" alt="" loading="lazy">`
            : `<div class="player-session-thumb-placeholder"></div>`}
        </div>
        <div class="player-session-info">
          <div class="player-session-game">${escapeHtml(s.game_name || 'Unknown Game')}</div>
          <div class="player-session-meta">
            <span class="session-date">${escapeHtml(formatDate(s.played_at))}</span>
            ${s.solo ? `<span class="session-meta session-solo">Solo</span>` : ''}
            ${s.player_count && !s.solo ? `<span class="session-meta">${pluralize(s.player_count, 'player')}</span>` : ''}
            ${s.duration_minutes ? `<span class="session-meta">${s.duration_minutes} min</span>` : ''}
            ${playersHtml ? `<span class="session-meta">${playersHtml}</span>` : ''}
            ${s.winner && !s.solo ? `<span class="session-meta">&#127942; ${escapeHtml(s.winner)}</span>` : ''}
            ${s.session_rating ? `<span class="session-rating">${'★'.repeat(s.session_rating)}${'☆'.repeat(5 - s.session_rating)}</span>` : ''}
          </div>
          ${s.notes ? `<div class="session-notes">${escapeHtml(s.notes)}</div>` : ''}
        </div>`;
      item.addEventListener('click', () => onGameClick(s.game_id));
      list.appendChild(item);
    }
  }
  return el;
}

// ===== Modal Management =====

const FOCUSABLE = 'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

let _modalPrevFocus = null;
let _modalTrapHandler = null;

function openModal(contentEl) {
  const inner = document.getElementById('modal-inner');
  inner.innerHTML = '';
  inner.appendChild(contentEl);
  const modal = document.getElementById('game-modal');
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
  _modalPrevFocus = document.activeElement;

  requestAnimationFrame(() => {
    modal.classList.add('open');

    // Focus first focusable element inside modal
    const focusables = [...modal.querySelectorAll(FOCUSABLE)]
      .filter(el => el.offsetParent !== null);
    if (focusables.length) focusables[0].focus();

    // Trap Tab key within modal
    _modalTrapHandler = (e) => {
      if (e.key !== 'Tab') return;
      const els = [...modal.querySelectorAll(FOCUSABLE)]
        .filter(el => el.offsetParent !== null);
      if (!els.length) return;
      const first = els[0], last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    modal.addEventListener('keydown', _modalTrapHandler);
  });
}

function closeModal() {
  const modal = document.getElementById('game-modal');
  modal.classList.remove('open');

  if (_modalTrapHandler) {
    modal.removeEventListener('keydown', _modalTrapHandler);
    _modalTrapHandler = null;
  }
  if (_modalPrevFocus) {
    _modalPrevFocus.focus();
    _modalPrevFocus = null;
  }

  setTimeout(() => {
    modal.style.display = 'none';
    document.getElementById('modal-inner').innerHTML = '';
    document.body.style.overflow = '';
  }, 200);
}

// ===== Gallery Lightbox =====

function openGalleryLightbox(images, startIndex = 0) {
  if (!images.length) return;
  let current = startIndex;
  const multi = images.length > 1;

  const overlay = document.createElement('div');
  overlay.className = 'gallery-lightbox-overlay';
  overlay.innerHTML = `
    <div class="gallery-lightbox-panel">
      <button class="gallery-lightbox-close" aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
      ${multi ? '<button class="gallery-lightbox-nav gallery-lightbox-prev" aria-label="Previous">&#8249;</button>' : ''}
      <div class="gallery-lightbox-img-wrap">
        <img class="gallery-lightbox-img" src="" alt="Gallery image">
      </div>
      ${multi ? '<button class="gallery-lightbox-nav gallery-lightbox-next" aria-label="Next">&#8250;</button>' : ''}
      <div class="gallery-lightbox-caption"></div>
      ${multi ? '<div class="gallery-lightbox-counter"></div>' : ''}
    </div>`;

  const img        = overlay.querySelector('.gallery-lightbox-img');
  const counter    = overlay.querySelector('.gallery-lightbox-counter');
  const captionEl  = overlay.querySelector('.gallery-lightbox-caption');

  function show(idx) {
    current = ((idx % images.length) + images.length) % images.length;
    const im = images[current];
    img.src = im._src || `/api/games/${im.game_id}/images/${im.id}/file`;
    img.alt = im.caption || `Photo ${current + 1} of ${images.length}`;
    if (counter) counter.textContent = `${current + 1} / ${images.length}`;
    if (captionEl) captionEl.textContent = im.caption || '';
  }

  if (multi) {
    overlay.querySelector('.gallery-lightbox-prev').addEventListener('click', () => show(current - 1));
    overlay.querySelector('.gallery-lightbox-next').addEventListener('click', () => show(current + 1));
  }
  overlay.querySelector('.gallery-lightbox-close').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  let touchStartX = 0;
  overlay.addEventListener('touchstart', e => { touchStartX = e.touches[0].clientX; }, { passive: true });
  overlay.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    if (multi && Math.abs(dx) > 50) show(current + (dx < 0 ? 1 : -1));
  });

  function onKey(e) {
    if (e.key === 'ArrowLeft'  && multi) show(current - 1);
    else if (e.key === 'ArrowRight' && multi) show(current + 1);
    else if (e.key === 'Escape') close();
  }
  document.addEventListener('keydown', onKey);

  const prevOverflow = document.body.style.overflow;
  function close() {
    document.removeEventListener('keydown', onKey);
    document.body.style.overflow = prevOverflow;
    overlay.remove();
  }

  show(startIndex);
  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
}

function openSingleImageLightbox(url, alt = '') {
  openGalleryLightbox([{ _src: url, caption: alt }], 0);
}

// ===== Stats View =====

function buildAddedByMonthFromEntries(entries) {
  if (!entries || !entries.length) return '';
  const max = Math.max(...entries.map(e => e.count), 1);
  return entries.map(e => `<div class="stat-bar-row" data-month="${escapeHtml(e.month)}" data-type="added" data-count="${e.count}">
          <span class="stat-bar-label">${escapeHtml(e.month)}</span>
          <div class="stat-bar-track"><div class="stat-bar-fill" style="width:0%" data-target-width="${e.count ? Math.round(e.count / max * 100) : 0}%"></div></div>
          <span class="stat-bar-count">${e.count}</span>
        </div>`).join('');
}


// ── Stats section info-popover helper ────────────────────────────────────────
// Returns the header row (title + ⓘ button) and the hidden popover as HTML.
// Used by every stats section that needs an expandable explanation panel.
const _INFO_BTN_SVG = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" width="15" height="15" aria-hidden="true"><circle cx="10" cy="10" r="8.5"/><path d="M9.5 9.5h.5a.5.5 0 0 1 .5.5v3" stroke-linecap="round"/><circle cx="10" cy="6.5" r=".6" fill="currentColor" stroke="none"/></svg>`;

function _sectionInfoHeader(titleHtml, ariaLabel, innerHtml) {
  return `<div class="health-header">
    <h3 class="stats-section-title" style="margin:0">${titleHtml}</h3>
    <button class="health-info-btn" aria-label="${ariaLabel}" aria-expanded="false">${_INFO_BTN_SVG}</button>
  </div>
  <div class="health-info-popover" hidden>
    <div class="health-info-popover-inner">${innerHtml}</div>
  </div>`;
}
// ─────────────────────────────────────────────────────────────────────────────

function buildMilestonesSection(milestones, onGameClick, onClear) {
  const el = document.createElement('div');
  el.className = 'stats-section milestones-section';

  const _mFrag = document.createRange().createContextualFragment(
    _sectionInfoHeader('Milestones', 'About Milestones',
      '<p class="health-info-intro">Milestones are earned automatically when a single game hits a play-count or playtime threshold (10, 25, or 50 plays; 10, 25, or 50 hours played). The 30 most-recent badges are shown here. Click any badge to open that game.</p>'
    )
  );
  el.appendChild(_mFrag);

  if (!Array.isArray(milestones) || !milestones.length) {
    const empty = document.createElement('p');
    empty.className = 'milestones-empty';
    empty.textContent = 'Log play sessions to earn milestones!';
    el.appendChild(empty);
    return el;
  }

  // Show most recent first, cap at 30
  const sorted = [...milestones].sort((a, b) => new Date(b.earnedAt) - new Date(a.earnedAt)).slice(0, 30);

  const grid = document.createElement('div');
  grid.className = 'milestone-grid';

  sorted.forEach(m => {
    const badge = document.createElement('button');
    badge.className = 'milestone-badge';
    badge.title = `Earned ${new Date(m.earnedAt).toLocaleDateString()}`;
    const icon = m.type === 'count' ? '🎉' : '⏱';
    const label = m.type === 'count' ? `${m.value} plays` : `${m.value} hrs`;
    badge.innerHTML = `<span class="milestone-icon">${icon}</span><span class="milestone-game">${escapeHtml(m.gameName)}</span><span class="milestone-value">${escapeHtml(label)}</span>`;
    badge.addEventListener('click', () => onGameClick(m.gameId));
    grid.appendChild(badge);
  });

  el.appendChild(grid);

  const clearBtn = document.createElement('button');
  clearBtn.className = 'filter-clear-all';
  clearBtn.style.marginTop = '12px';
  clearBtn.textContent = 'Clear milestone history';
  clearBtn.addEventListener('click', () => { onClear(); el.remove(); });
  el.appendChild(clearBtn);

  return el;
}

function _ownedFor(dateAdded) {
  const now = new Date();
  const added = new Date(dateAdded);
  let months = (now.getFullYear() - added.getFullYear()) * 12 + (now.getMonth() - added.getMonth());
  if (months < 1) return 'less than a month';
  const years = Math.floor(months / 12);
  months = months % 12;
  if (years && months) return `${years}y ${months}m`;
  if (years) return `${years}y`;
  return `${months}m`;
}

function buildCollectionValueSection(collectionValue, visible) {
  const el = document.createElement('div');
  el.className = 'stats-section';
  el.dataset.section = 'collection_value';
  if (!visible) el.style.display = 'none';

  const _cvFrag = document.createRange().createContextualFragment(
    _sectionInfoHeader('Collection Value', 'About Collection Value',
      '<p class="health-info-intro">Totals are calculated from purchase prices you\'ve entered on each game. <em>Best Value</em> ranks games by cost per play session; <em>Best Value by Time</em> ranks by cost per hour. Games without a purchase price are excluded from all totals.</p>'
    )
  );
  el.appendChild(_cvFrag);

  const hasData = collectionValue && collectionValue.owned_total != null;

  if (!hasData) {
    const empty = document.createElement('p');
    empty.className = 'no-sessions';
    empty.textContent = 'Add purchase prices to your games to see value insights.';
    el.appendChild(empty);
    return el;
  }

  // Value summary pills (server-computed totals covering all owned games)
  const pills = document.createElement('div');
  pills.className = 'value-summary';
  pills.innerHTML = [
    { label: 'Owned Value',    value: '$' + collectionValue.owned_total.toFixed(2) },
    { label: 'Avg Price',      value: '$' + collectionValue.avg_price.toFixed(2) },
    { label: 'Unplayed Value', value: '$' + (collectionValue.unplayed_total || 0).toFixed(2) },
  ].map(p => `<div class="value-pill"><div class="value-pill-value">${p.value}</div><div class="value-pill-label">${p.label}</div></div>`).join('');
  el.appendChild(pills);

  // Best Value — lowest $/session
  const bestValue = collectionValue.best_value_by_play || [];
  if (bestValue.length) {
    const maxSessions = Math.max(...bestValue.map(g => g.sessions));
    const bvTitle = document.createElement('h4');
    bvTitle.className = 'value-subtitle';
    bvTitle.textContent = 'Best Value';
    el.appendChild(bvTitle);
    const list = document.createElement('div');
    list.className = 'most-played-list';
    list.innerHTML = bestValue.map((g, i) => `
      <div class="most-played-item" data-game-id="${g.id}">
        <div class="most-played-rank">${i + 1}</div>
        <div class="most-played-info">
          <div class="most-played-name">${escapeHtml(g.name)}</div>
          <div class="stat-bar-track"><div class="stat-bar-fill" style="width:0%" data-target-width="${maxSessions ? (g.sessions / maxSessions * 100) : 0}%"></div></div>
        </div>
        <div class="most-played-count cost-per-play">$${g.cpp.toFixed(2)}/play</div>
      </div>`).join('');
    el.appendChild(list);
  }

  // Best Value by Time — lowest $/hr
  const bestByTime = collectionValue.best_value_by_time || [];
  if (bestByTime.length) {
    const maxMin = Math.max(...bestByTime.map(g => g.total_minutes));
    const bthTitle = document.createElement('h4');
    bthTitle.className = 'value-subtitle';
    bthTitle.textContent = 'Best Value by Time';
    el.appendChild(bthTitle);
    const bthList = document.createElement('div');
    bthList.className = 'most-played-list';
    bthList.innerHTML = bestByTime.map((g, i) => `
      <div class="most-played-item" data-game-id="${g.id}">
        <div class="most-played-rank">${i + 1}</div>
        <div class="most-played-info">
          <div class="most-played-name">${escapeHtml(g.name)}</div>
          <div class="stat-bar-track"><div class="stat-bar-fill" style="width:0%" data-target-width="${maxMin ? (g.total_minutes / maxMin * 100) : 0}%"></div></div>
        </div>
        <div class="most-played-count cost-per-play">$${g.cph.toFixed(2)}/hr</div>
      </div>`).join('');
    el.appendChild(bthList);
  }

  // Most Expensive Unplayed
  const expUnplayed = collectionValue.most_expensive_unplayed || [];
  if (expUnplayed.length) {
    const euTitle = document.createElement('h4');
    euTitle.className = 'value-subtitle';
    euTitle.textContent = 'Most Expensive Unplayed';
    el.appendChild(euTitle);
    const euList = document.createElement('div');
    euList.className = 'insight-game-list';
    euList.innerHTML = expUnplayed.map(g => `
      <div class="insight-game-row" data-game-id="${g.id}">
        <span class="insight-game-name">${escapeHtml(g.name)}</span>
        <span class="insight-game-meta"><span class="value-price">$${g.purchase_price.toFixed(2)}</span> · Owned for ${_ownedFor(g.date_added)}</span>
      </div>`).join('');
    el.appendChild(euList);
  }

  return el;
}

function buildCollectionSettingsModal(prefs, onPrefsChange) {
  const SECTION_TOGGLES = [
    ['show_status_pills',     'Status Filters',      'status_pills'],
    ['show_collection_stats', 'Collection Stats',    'collection_stats'],
    ['show_recently_played',  'Recently Played Shelf','recently_played'],
    ['show_recommend_card',   'Play This Next',      'recommend_card'],
    ['show_action_plan',      'Action Plan',         'action_plan'],
    ['show_reminder_banner',  'Dust-Off Reminders',  'reminder_banner'],
  ];
  const TOOLBAR_TOGGLES = [
    ['show_game_night_btn',   'Game Night Button'],
    ['show_bulk_select',      'Bulk Select'],
    ['show_expansions_btn',   'Show Expansions'],
  ];

  let currentPrefs = { ...prefs };

  const gripSvg = `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <circle cx="9"  cy="5"  r="1.5"/><circle cx="15" cy="5"  r="1.5"/>
    <circle cx="9"  cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/>
    <circle cx="9"  cy="19" r="1.5"/><circle cx="15" cy="19" r="1.5"/>
  </svg>`;

  const sectionTogglesHtml = currentPrefs.section_order
    .filter(key => SECTION_TOGGLES.some(([, , k]) => k === key))
    .map(sectionKey => {
      const entry = SECTION_TOGGLES.find(([, , k]) => k === sectionKey);
      if (!entry) return '';
      const [prefKey, label] = entry;
      return `<div class="settings-modal-row" draggable="true" data-key="${sectionKey}">
        <span class="drag-handle" aria-hidden="true">${gripSvg}</span>
        <label class="settings-modal-toggle">
          <input type="checkbox" data-pref="${prefKey}"${currentPrefs[prefKey] !== false ? ' checked' : ''}>
          ${escapeHtml(label)}
        </label>
      </div>`;
    }).join('');

  const toolbarTogglesHtml = TOOLBAR_TOGGLES.map(([prefKey, label]) => {
    return `<div class="settings-modal-row" data-key="${prefKey}">
      <label class="settings-modal-toggle">
        <input type="checkbox" data-pref="${prefKey}"${currentPrefs[prefKey] !== false ? ' checked' : ''}>
        ${escapeHtml(label)}
      </label>
    </div>`;
  }).join('');

  const el = document.createElement('div');
  el.className = 'collection-settings-modal-content';
  el.innerHTML = `
    <div class="modal-header">
      <h2 id="collection-settings-title">Customize Collection Page</h2>
      <button class="modal-close-btn" id="collection-settings-close" aria-label="Close settings">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
    <p class="settings-modal-desc">Toggle visibility and drag to reorder elements on your collection page.</p>
    <div class="settings-modal-list" id="collection-settings-list">
      ${sectionTogglesHtml}
    </div>
    <div class="settings-modal-divider"></div>
    <span class="settings-modal-group-label">Toolbar</span>
    <div class="settings-modal-list settings-modal-list-toolbar">
      ${toolbarTogglesHtml}
    </div>`;

  const settingsList = el.querySelector('#collection-settings-list');

  // Wire close button
  el.querySelector('#collection-settings-close').addEventListener('click', () => {
    closeCollectionSettingsModal();
  });

  // Wire all checkboxes (both section and toolbar toggles)
  el.querySelectorAll('.settings-modal-row input[type="checkbox"]').forEach(input => {
    input.addEventListener('change', () => {
      const prefKey = input.dataset.pref;
      currentPrefs = { ...currentPrefs, [prefKey]: input.checked };
      if (onPrefsChange) onPrefsChange(currentPrefs);
    });
  });

  // Drag-and-drop reordering (only on section toggles)
  let dragSrcKey = null;

  settingsList.querySelectorAll('.settings-modal-row').forEach(row => {
    row.addEventListener('dragstart', e => {
      dragSrcKey = row.dataset.key;
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      settingsList.querySelectorAll('.drag-over').forEach(r => r.classList.remove('drag-over'));
    });
    row.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (row.dataset.key !== dragSrcKey) row.classList.add('drag-over');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', e => {
      e.preventDefault();
      row.classList.remove('drag-over');
      if (!dragSrcKey || dragSrcKey === row.dataset.key) return;

      const srcRow = settingsList.querySelector(`[data-key="${dragSrcKey}"]`);
      const rows = [...settingsList.children];
      const srcIdx = rows.indexOf(srcRow);
      const dstIdx = rows.indexOf(row);
      settingsList.insertBefore(srcRow, srcIdx < dstIdx ? row.nextSibling : row);

      // Build new order: interleave reordered toggle keys at their new positions,
      // keeping non-toggle keys (toolbar, filters, games) at their original relative positions
      const newToggleKeys = [...settingsList.querySelectorAll('[data-key]')].map(r => r.dataset.key);
      const nonToggleKeys = currentPrefs.section_order.filter(k => !newToggleKeys.includes(k));
      const toggleIter = newToggleKeys[Symbol.iterator]();
      const newOrder = currentPrefs.section_order.map(k =>
        newToggleKeys.includes(k) ? toggleIter.next().value : k
      );

      currentPrefs = { ...currentPrefs, section_order: newOrder };
      if (onPrefsChange) onPrefsChange(currentPrefs);
    });
  });

  return el;
}

function openCollectionSettingsModal(prefs, onPrefsChange) {
  const modal = document.getElementById('collection-settings-modal');
  const inner = document.getElementById('collection-settings-inner');
  inner.innerHTML = '';
  inner.appendChild(buildCollectionSettingsModal(prefs, onPrefsChange));
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
  _collectionSettingsPrevFocus = document.activeElement;

  requestAnimationFrame(() => {
    modal.classList.add('open');
    const focusables = [...modal.querySelectorAll(FOCUSABLE)]
      .filter(el => el.offsetParent !== null);
    if (focusables.length) focusables[0].focus();

    // Trap Tab key within modal
    _collectionSettingsTrapHandler = (e) => {
      if (e.key !== 'Tab') return;
      const els = [...modal.querySelectorAll(FOCUSABLE)]
        .filter(el => el.offsetParent !== null);
      if (!els.length) return;
      const first = els[0], last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    modal.addEventListener('keydown', _collectionSettingsTrapHandler);
  });

  // Close on backdrop click
  const backdrop = document.getElementById('collection-settings-backdrop');
  backdrop.onclick = () => closeCollectionSettingsModal();

  // Close on Escape
  _collectionSettingsEscHandler = (e) => {
    if (e.key === 'Escape') closeCollectionSettingsModal();
  };
  document.addEventListener('keydown', _collectionSettingsEscHandler);
}

let _collectionSettingsPrevFocus = null;
let _collectionSettingsTrapHandler = null;
let _collectionSettingsEscHandler = null;

function closeCollectionSettingsModal() {
  const modal = document.getElementById('collection-settings-modal');
  modal.classList.remove('open');

  if (_collectionSettingsTrapHandler) {
    modal.removeEventListener('keydown', _collectionSettingsTrapHandler);
    _collectionSettingsTrapHandler = null;
  }
  if (_collectionSettingsEscHandler) {
    document.removeEventListener('keydown', _collectionSettingsEscHandler);
    _collectionSettingsEscHandler = null;
  }
  if (_collectionSettingsPrevFocus) {
    _collectionSettingsPrevFocus.focus();
    _collectionSettingsPrevFocus = null;
  }

  setTimeout(() => {
    modal.style.display = 'none';
    document.getElementById('collection-settings-inner').innerHTML = '';
    document.body.style.overflow = '';
  }, 200);
}

function buildStatsView(stats, games, prefs = {}, onPrefsChange = null, goals = []) {
  const SECTION_DEFAULTS = {
    show_summary: true, show_most_played: true, show_top_players: true,
    show_recently_played: true,
    show_recently_added: true,
    show_ratings: true, show_labels: true, show_added_by_month: true,
    show_sessions_by_month: true, show_play_heatmap: true,
    show_sessions_by_dow: true, show_never_played: true,
    show_dormant: true, show_top_mechanics: true, show_collection_value: true,
    show_milestones: true, show_goals: true, show_cooling_off: true, show_trade_sell: true,
    section_order: ['summary', 'most_played', 'top_players', 'recently_played', 'recently_added',
                    'ratings', 'labels', 'added_by_month', 'sessions_by_month', 'play_heatmap',
                    'sessions_by_dow',
                    'never_played', 'cooling_off', 'dormant', 'top_mechanics', 'collection_value',
                    'trade_sell', 'milestones', 'goals'],
  };
  let currentPrefs = { ...SECTION_DEFAULTS, ...prefs };

  // [prefKey, display label, section id (= data-section attribute value)]
  const SECTION_TOGGLES = [
    ['show_summary',           'Summary Cards',      'summary'],
    ['show_most_played',       'Most Played',        'most_played'],
    ['show_top_players',       'Player Leaderboard', 'top_players'],
    ['show_recently_played',   'Recently Played',    'recently_played'],
    ['show_recently_added',    'Recently Added',     'recently_added'],
    ['show_ratings',           'Ratings',            'ratings'],
    ['show_labels',            'Labels',             'labels'],
    ['show_added_by_month',    'Added by Month',     'added_by_month'],
    ['show_sessions_by_month', 'Sessions by Month',  'sessions_by_month'],
    ['show_play_heatmap',      'Play Activity',      'play_heatmap'],
    ['show_sessions_by_dow',   'Day of Week',        'sessions_by_dow'],
    ['show_never_played',      'Shelf of Shame',     'never_played'],
    ['show_cooling_off',        'Cooling Off',        'cooling_off'],
    ['show_dormant',           'Dormant Games',      'dormant'],
    ['show_top_mechanics',     'Top Mechanics',      'top_mechanics'],
    ['show_collection_value',  'Collection Value',   'collection_value'],
    ['show_trade_sell',        'Trade / Sell',       'trade_sell'],
    ['show_milestones',        'Milestones',         'milestones'],
    ['show_goals',             'Goals & Challenges', 'goals'],
  ];

  const gripSvg = `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <circle cx="9"  cy="5"  r="1.5"/><circle cx="15" cy="5"  r="1.5"/>
    <circle cx="9"  cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/>
    <circle cx="9"  cy="19" r="1.5"/><circle cx="15" cy="19" r="1.5"/>
  </svg>`;

  const settingsTogglesHtml = currentPrefs.section_order.map(sectionKey => {
    const entry = SECTION_TOGGLES.find(([,, k]) => k === sectionKey);
    if (!entry) return '';
    const [prefKey, label] = entry;
    return `<div class="stats-settings-row" draggable="true" data-key="${sectionKey}">
      <span class="drag-handle" aria-hidden="true">${gripSvg}</span>
      <label class="stats-settings-toggle">
        <input type="checkbox" data-pref="${prefKey}"${currentPrefs[prefKey] !== false ? ' checked' : ''}>
        ${escapeHtml(label)}
      </label>
    </div>`;
  }).join('');

  const el = document.createElement('div');
  el.className = 'stats-view';

  if (stats.total_sessions === 0 && stats.total_games > 0) {
    el.innerHTML = `
      <div class="stats-no-sessions">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" class="stats-no-sessions-icon" aria-hidden="true">
          <rect x="2" y="6" width="20" height="14" rx="2"/><rect x="6" y="2" width="12" height="4" rx="1"/>
          <circle cx="12" cy="13" r="3"/><circle cx="12" cy="13" r="1.2" fill="currentColor" stroke="none"/>
        </svg>
        <p class="stats-no-sessions-title">No play sessions yet</p>
        <p class="stats-no-sessions-sub">Start logging plays to unlock insights about your collection.</p>
        <button class="btn btn-primary" id="stats-log-first-play">Log your first play</button>
      </div>`;
    return el;
  }

  // Stat cards
  const totalExpansions = stats.total_expansions || 0;
  const baseGameCount   = stats.total_games - totalExpansions;
  const totalGamesLabel = totalExpansions > 0
    ? `${baseGameCount} <span class="stat-expansion-note">(+${totalExpansions} exp.)</span>`
    : stats.total_games;

  // Metrics from server-precomputed fields
  const mostActiveMonth = stats.sessions_by_month.length
    ? stats.sessions_by_month.reduce((a, b) => b.count > a.count ? b : a, stats.sessions_by_month[0])
    : null;
  const avgSessionLen = stats.avg_session_minutes ? Math.round(stats.avg_session_minutes) : null;
  const topMechanicName = stats.top_mechanic || null;
  const _dailyStreak = stats.daily_streak || 0;
  const _maxWeekStreak = stats.best_weekly_streak || 0;

  const statDefs = [
    { label: 'Total Games',   value: totalGamesLabel, raw: true },
    { label: 'Owned',         value: stats.by_status.owned    || 0, drilldown: 'owned' },
    { label: 'Wishlist',      value: stats.by_status.wishlist || 0, drilldown: 'wishlist' },
    { label: 'Play Sessions', value: stats.total_sessions },
    { label: 'Hours Played',  value: stats.total_hours },
    ...(stats.avg_rating    != null ? [{ label: 'Avg Rating',        value: stats.avg_rating + ' / 10' }] : []),
    { label: 'Never Played',  value: stats.never_played_count, drilldown: 'never_played' },
    ...(avgSessionLen != null ? [{ label: 'Avg Session',       value: avgSessionLen + ' min' }] : []),
    ...(mostActiveMonth && mostActiveMonth.count > 0 ? [{ label: 'Best Month',  value: mostActiveMonth.month }] : []),
    ...(topMechanicName ? [{ label: 'Top Mechanic', value: topMechanicName }] : []),
    ...(_dailyStreak > 1   ? [{ label: 'Daily Streak',  value: pluralize(_dailyStreak, 'day') }] : []),
    ...(_maxWeekStreak > 1 ? [{ label: 'Best Streak',   value: pluralize(_maxWeekStreak, 'week') }] : []),
  ];

  // Build insight nudges from server-precomputed data
  const insightNudges = [];
  const neglected = stats.neglected_favorite;
  if (neglected) {
    insightNudges.push({
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
      text: `<strong>${escapeHtml(neglected.name)}</strong> hasn't been played in ${pluralize(neglected.months_ago, 'month')} — give it another go!`,
      gameId: neglected.id,
      action: 'View game',
    });
  }
  const wishlistCount = stats.by_status.wishlist || 0;
  if (wishlistCount > 0) {
    const topWish = stats.top_wishlist_game;
    insightNudges.push({
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
      text: `You have <strong>${wishlistCount}</strong> ${wishlistCount !== 1 ? 'games' : 'game'} on your wishlist${topWish ? ` — top pick: <strong>${escapeHtml(topWish.name)}</strong>` : ''}.`,
      gameId: topWish ? topWish.id : null,
      action: topWish ? 'View game' : null,
    });
  }
  const unplayedWithMechanic = stats.unplayed_with_top_mechanic || 0;
  if (topMechanicName && unplayedWithMechanic > 0) {
    insightNudges.push({
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>',
      text: `You love <strong>${escapeHtml(topMechanicName)}</strong> — but <strong>${unplayedWithMechanic}</strong> ${unplayedWithMechanic !== 1 ? 'games' : 'game'} with that mechanic ${unplayedWithMechanic !== 1 ? 'are' : 'is'} still unplayed.`,
      gameId: null,
      action: null,
    });
  }

  const insightsHtml = insightNudges.length ? `
    <div class="insight-nudges">
      ${insightNudges.map(n => `
        <div class="insight-nudge"${n.gameId ? ` data-game-id="${n.gameId}" style="cursor:pointer"` : ''}>
          <div class="insight-nudge-icon">${n.icon}</div>
          <div class="insight-nudge-text">${n.text}</div>
          ${n.action && n.gameId ? `<button class="insight-nudge-action">${escapeHtml(n.action)}</button>` : ''}
        </div>`).join('')}
    </div>` : '';

  const cardsHtml = `<div class="stat-cards" data-section="summary"${!currentPrefs.show_summary ? ' style="display:none"' : ''}>
    ${statDefs.map(c => `
      <div class="stat-card"${c.drilldown ? ` data-drilldown="${c.drilldown}" title="View in collection"` : ''}>
        <div class="stat-card-value">${c.raw ? c.value : escapeHtml(String(c.value))}</div>
        <div class="stat-card-label">${escapeHtml(c.label)}</div>
      </div>`).join('')}
  </div>`;

  // ===== Collection Health Score (server-precomputed) =====
  const {
    score: _healthScore = 0,
    play_pct: _playBarPct = 0,
    rating_score: _ratingBarPct = 0,
    diversity_score: _diverseBarPct = 0,
    played_count: _playedCount = 0,
    owned_base_count: _ownedBaseLen = 0,
    avg_rating_raw: _avgRatingRaw = 0,
    unique_mechanics: _uniqueMechanics = 0,
  } = stats.collection_health ?? {};
  const _circ           = 251.2;
  const _targetOffset   = Math.round(_circ * (1 - _healthScore / 100));
  const _healthColor    = _healthScore >= 70 ? 'var(--success)' : _healthScore >= 40 ? 'var(--warning)' : 'var(--danger)';
  const _playedPctLabel = _playBarPct + '%';
  const _healthGrade    = _healthScore >= 90 ? 'Excellent' : _healthScore >= 70 ? 'Healthy' : _healthScore >= 40 ? 'Developing' : 'Just Starting';

  const healthScoreHtml = `
    <div class="stats-section" data-section="health">

      <div class="health-header">
        <h3 class="stats-section-title" style="margin:0">Collection Health</h3>
        <button class="health-info-btn" aria-label="How is this score calculated?" aria-expanded="false">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" width="15" height="15" aria-hidden="true">
            <circle cx="10" cy="10" r="8.5"/>
            <path d="M9.5 9.5h.5a.5.5 0 0 1 .5.5v3" stroke-linecap="round"/>
            <circle cx="10" cy="6.5" r=".6" fill="currentColor" stroke="none"/>
          </svg>
        </button>
      </div>

      <div class="health-info-popover" hidden>
        <div class="health-info-popover-inner">
          <p class="health-info-intro">Your <strong>Collection Health score</strong> (0–100) measures how actively engaged you are with your library across three factors.</p>

          <div class="health-info-factors">
            <div class="health-info-factor">
              <div class="health-info-factor-header">
                <span class="health-info-factor-name">Play Rate</span>
                <span class="hb-weight">40% of score</span>
              </div>
              <p class="health-info-factor-desc">The share of your owned base games you've played at least once. High play rate means you actually play what you own — the single biggest driver of score.</p>
              <p class="health-info-tip">Tip: Work through your unplayed shelf, even just a short session counts.</p>
            </div>
            <div class="health-info-factor">
              <div class="health-info-factor-header">
                <span class="health-info-factor-name">Avg Rating</span>
                <span class="hb-weight">40% of score</span>
              </div>
              <p class="health-info-factor-desc">Your average personal rating across all rated games, scaled to 0–100. It reflects how much you enjoy the games you own — a high average means a well-curated shelf.</p>
              <p class="health-info-tip">Tip: Rate the games you've played — your ratings feed directly into this factor.</p>
            </div>
            <div class="health-info-factor">
              <div class="health-info-factor-header">
                <span class="health-info-factor-name">Mechanic Diversity</span>
                <span class="hb-weight">20% of score</span>
              </div>
              <p class="health-info-factor-desc">The number of distinct mechanics across your collection, capped at 20 for full marks. A varied collection keeps game nights fresh and works for different groups and moods.</p>
              <p class="health-info-tip">Tip: Add games that play differently — a deck-builder, a co-op, a party game each bring new mechanics.</p>
            </div>
          </div>

          <div class="health-info-ranges">
            <div class="health-info-ranges-title">Score key</div>
            <div class="health-range-legend">
              <div class="hrl-item"><span class="hrl-dot" style="background:var(--success)"></span><strong>90–100</strong> Excellent</div>
              <div class="hrl-item"><span class="hrl-dot" style="background:var(--success)"></span><strong>70–89</strong> Healthy</div>
              <div class="hrl-item"><span class="hrl-dot" style="background:var(--warning)"></span><strong>40–69</strong> Developing</div>
              <div class="hrl-item"><span class="hrl-dot" style="background:var(--danger)"></span><strong>0–39</strong> Just Starting</div>
            </div>
          </div>
        </div>
      </div>

      <div class="stats-health-row">
        <div class="health-ring-widget">
          <svg class="health-ring" viewBox="0 0 100 100" width="120" height="120" aria-label="Collection health score ${_healthScore} out of 100">
            <circle class="health-ring-bg" cx="50" cy="50" r="40" fill="none" stroke-width="8"/>
            <circle class="health-ring-arc" cx="50" cy="50" r="40" fill="none" stroke-width="8"
              stroke="${_healthColor}"
              stroke-dasharray="${_circ}"
              stroke-dashoffset="${_circ}"
              data-target-offset="${_targetOffset}"
              transform="rotate(-90 50 50)"/>
            <text x="50" y="54" text-anchor="middle" class="health-ring-text">${_healthScore}</text>
          </svg>
          <div class="health-ring-grade" style="color:${_healthColor}">${_healthGrade}</div>
          <div class="health-ring-sub">out of 100</div>
        </div>

        <div class="health-breakdown" style="flex:1;min-width:180px">
          <div class="health-breakdown-title">Score breakdown</div>

          <div class="hb-factor">
            <div class="hb-factor-header">
              <span class="hb-label">Play Rate</span>
              <span class="hb-weight">40%</span>
              <span class="hb-value">${_playedPctLabel} <span class="hb-detail">(${_playedCount} of ${_ownedBaseLen})</span></span>
            </div>
            <div class="hb-bar-track"><div class="stat-bar-fill" style="width:0%;background:${_healthColor}" data-target-width="${_playBarPct}%"></div></div>
          </div>

          <div class="hb-factor">
            <div class="hb-factor-header">
              <span class="hb-label">Avg Rating</span>
              <span class="hb-weight">40%</span>
              <span class="hb-value">${_avgRatingRaw > 0 ? _avgRatingRaw.toFixed(1) + ' / 10' : '<span class="hb-detail">no ratings yet</span>'}</span>
            </div>
            <div class="hb-bar-track"><div class="stat-bar-fill" style="width:0%;background:${_healthColor}" data-target-width="${_ratingBarPct}%"></div></div>
          </div>

          <div class="hb-factor">
            <div class="hb-factor-header">
              <span class="hb-label">Mechanic Diversity</span>
              <span class="hb-weight">20%</span>
              <span class="hb-value">${_uniqueMechanics} <span class="hb-detail">/ 20 for full marks</span></span>
            </div>
            <div class="hb-bar-track"><div class="stat-bar-fill" style="width:0%;background:${_healthColor}" data-target-width="${_diverseBarPct}%"></div></div>
          </div>
        </div>
      </div>
    </div>`;

  // ===== Rating vs BGG Delta (server-precomputed) =====
  const _deltaGames = stats.rating_vs_bgg || [];
  const _maxDelta = Math.max(..._deltaGames.map(g => Math.abs(g.delta)), 1);
  const ratingDeltaHtml = _deltaGames.length >= 3 ? `
    <div class="stats-section" data-section="rating_delta">
      ${_sectionInfoHeader('Your Taste vs The Community', 'About Your Taste vs The Community', '<p class="health-info-intro">Compares your personal ratings against the BoardGameGeek community average. A positive bar means you enjoy a game more than the crowd; negative means less. Only games with both a personal rating and a BGG rating appear here.</p>')}
      <div class="rating-delta-chart">
        ${_deltaGames.map(g => {
          const barPct = Math.round(Math.abs(g.delta) / _maxDelta * 46);
          const isPos = g.delta >= 0;
          return `<div class="delta-row">
            <span class="delta-name" title="${escapeHtml(g.name)}">${escapeHtml(g.name)}</span>
            <div class="delta-bars">
              <div class="delta-zero"></div>
              <div class="delta-bar ${isPos ? 'positive' : 'negative'}" style="width:${barPct}%"></div>
            </div>
            <span class="delta-value ${isPos ? 'pos' : 'neg'}">${isPos ? '+' : ''}${g.delta}</span>
          </div>`;
        }).join('')}
      </div>
      <p style="font-size:0.72rem;color:var(--text-3);margin-top:8px">Positive = you rate higher than BGG community average.</p>
    </div>` : '';

  // Most played
  const mostPlayedHtml = stats.most_played.length ? `
    <div class="stats-section" data-section="most_played"${!currentPrefs.show_most_played ? ' style="display:none"' : ''}>
      ${_sectionInfoHeader('Most Played', 'About Most Played', '<p class="health-info-intro">Games ranked by total logged play sessions. Only sessions with a recorded date count toward the total.</p>')}
      <div class="most-played-list">
        ${stats.most_played.map((entry, i) => {
          const maxCount = stats.most_played[0].count;
          const pct = Math.round((entry.count / maxCount) * 100);
          return `<div class="most-played-item" data-game-id="${entry.id}">
            <div class="most-played-rank">${i + 1}</div>
            <div class="most-played-info">
              <div class="most-played-name">${escapeHtml(entry.name)}</div>
              <div class="stat-bar-track"><div class="stat-bar-fill" style="width:0%" data-target-width="${pct}%"></div></div>
            </div>
            <div class="most-played-count">${pluralize(entry.count, 'play')}</div>
          </div>`;
        }).join('')}
      </div>
    </div>` : '';

  // Rating distribution
  const ratingEntries = Object.entries(stats.ratings_distribution);
  const maxRating = Math.max(...ratingEntries.map(([, v]) => v), 1);
  const ratingsHtml = `
    <div class="stats-section" data-section="ratings"${!currentPrefs.show_ratings ? ' style="display:none"' : ''}>
      ${_sectionInfoHeader('Rating Distribution', 'About Rating Distribution', '<p class="health-info-intro">A breakdown of your personal ratings grouped into buckets. Unrated games are not included. A healthy collection tends to have ratings clustered in the 6–9 range.</p>')}
      <div class="stat-bar-chart">
        ${ratingEntries.map(([bucket, count]) => `<div class="stat-bar-row" data-bucket="${escapeHtml(bucket)}" data-count="${count}">
          <span class="stat-bar-label">${escapeHtml(bucket)}</span>
          <div class="stat-bar-track"><div class="stat-bar-fill" style="width:0%" data-target-width="${count ? Math.round(count / maxRating * 100) : 0}%"></div></div>
          <span class="stat-bar-count">${count}</span>
        </div>`).join('')}
      </div>
    </div>`;

  // Label breakdown
  const labelEntries = Object.entries(stats.label_counts).slice(0, 10);
  const maxLabel = Math.max(...labelEntries.map(([, v]) => v), 1);
  const labelsHtml = labelEntries.length ? `
    <div class="stats-section" data-section="labels"${!currentPrefs.show_labels ? ' style="display:none"' : ''}>
      ${_sectionInfoHeader('Labels', 'About Labels', '<p class="health-info-intro">How your games are distributed across your custom labels. Up to 10 most-used labels are shown.</p>')}
      <div class="stat-bar-chart">
        ${labelEntries.map(([label, count]) => `<div class="stat-bar-row">
          <span class="stat-bar-label" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
          <div class="stat-bar-track"><div class="stat-bar-fill" style="width:0%" data-target-width="${Math.round(count / maxLabel * 100)}%"></div></div>
          <span class="stat-bar-count">${count}</span>
        </div>`).join('')}
      </div>
    </div>` : '';

  // Added by month
  const addedIncludeWishlist = currentPrefs.added_by_month_include_wishlist ?? true;
  const addedHtml = `
    <div class="stats-section" data-section="added_by_month"${!currentPrefs.show_added_by_month ? ' style="display:none"' : ''}>
      <div class="stats-section-header">
        <h3 class="stats-section-title">Added by Month</h3>
        <button class="health-info-btn" aria-label="About Added by Month" aria-expanded="false">${_INFO_BTN_SVG}</button>
        <label class="stats-section-inline-toggle" style="margin-left:auto">
          <input type="checkbox" id="added-wishlist-toggle"${addedIncludeWishlist ? ' checked' : ''}>
          Include wishlist
        </label>
      </div>
      <div class="health-info-popover" hidden>
        <div class="health-info-popover-inner"><p class="health-info-intro">How many games you've added to your collection each calendar month. Toggle the checkbox to include or exclude wishlist games.</p></div>
      </div>
      <div class="stat-bar-chart" id="added-by-month-chart">
        ${buildAddedByMonthFromEntries(addedIncludeWishlist ? stats.added_by_month : stats.added_by_month_owned_only)}
      </div>
    </div>`;

  // Sessions by month
  const sessionsMax = Math.max(...stats.sessions_by_month.map(e => e.count), 1);
  const sessionsByMonthHtml = `
    <div class="stats-section" data-section="sessions_by_month"${!currentPrefs.show_sessions_by_month ? ' style="display:none"' : ''}>
      ${_sectionInfoHeader('Sessions by Month', 'About Sessions by Month', '<p class="health-info-intro">Play sessions logged per calendar month. Click any bar to see which games were played that month.</p>')}
      <div class="stat-bar-chart">
        ${stats.sessions_by_month.map(entry => `<div class="stat-bar-row" data-month="${escapeHtml(entry.month)}" data-type="sessions" data-count="${entry.count}" data-game-ids='${JSON.stringify(entry.game_ids || [])}' data-tooltip="${pluralize(entry.count, 'session')}">
          <span class="stat-bar-label">${escapeHtml(entry.month)}</span>
          <div class="stat-bar-track"><div class="stat-bar-fill stat-bar-fill-sessions" style="width:0%" data-target-width="${entry.count ? Math.round(entry.count / sessionsMax * 100) : 0}%"></div></div>
          <span class="stat-bar-count">${entry.count}</span>
        </div>`).join('')}
      </div>
    </div>`;

  // Recently played (last 10 sessions)
  const recentSessionsHtml = stats.recent_sessions.length ? `
    <div class="stats-section" data-section="recently_played"${!currentPrefs.show_recently_played ? ' style="display:none"' : ''}>
      ${_sectionInfoHeader('Recently Played', 'About Recently Played', '<p class="health-info-intro">Your 10 most recent logged play sessions.</p>')}
      <div class="recent-sessions-list">
        ${stats.recent_sessions.map(s => `
          <div class="recent-session-item" data-game-id="${s.game_id}">
            <div class="recent-session-name">${escapeHtml(s.game_name)}</div>
            <div class="recent-session-meta">
              <span class="recent-session-date">${escapeHtml(formatDate(s.played_at))}</span>
              ${s.player_count ? `<span class="recent-session-detail">${pluralize(s.player_count, 'player')}</span>` : ''}
              ${s.duration_minutes ? `<span class="recent-session-detail">${s.duration_minutes} min</span>` : ''}
            </div>
          </div>`).join('')}
      </div>
    </div>` : '';

  // Recently added — server-precomputed top 5 by date_added
  const recentlyAdded = stats.recently_added || [];
  const recentlyAddedHtml = recentlyAdded.length ? `
    <div class="stats-section" data-section="recently_added"${!currentPrefs.show_recently_added ? ' style="display:none"' : ''}>
      ${_sectionInfoHeader('Recently Added', 'About Recently Added', '<p class="health-info-intro">The 5 most recently added games, sorted by date added.</p>')}
      <div class="insight-game-list">
        ${recentlyAdded.map(g => `
          <div class="insight-game-row" data-game-id="${g.id}">
            <span class="insight-game-name">${escapeHtml(g.name)}</span>
            <span class="insight-game-meta">${escapeHtml(formatDate(g.date_added.slice(0, 10)))}</span>
          </div>`).join('')}
      </div>
    </div>` : '';

  // Shelf of Shame — server-precomputed list of owned games never played
  const neverPlayed = stats.never_played_list || [];
  const _npRow = g => `<div class="insight-game-row" data-game-id="${g.id}">
               <span class="insight-game-name">${escapeHtml(g.name)}</span>
               <span class="insight-game-meta">Owned for ${_ownedFor(g.date_added)}</span>
             </div>`;
  const neverPlayedHtml = `
    <div class="stats-section" data-section="never_played"${!currentPrefs.show_never_played ? ' style="display:none"' : ''}>
      ${_sectionInfoHeader(`Shelf of Shame (${neverPlayed.length})${neverPlayed.length > 0 ? ' <button class="drilldown-title-btn" data-drilldown="never_played" type="button">View all →</button>' : ''}`, 'About Shelf of Shame', '<p class="health-info-intro">Owned games you\'ve never played, sorted by how long you\'ve had them. Use it as a nudge to finally get them to the table.</p>')}
      <p class="insight-subtext">Owned but never played \u2014 longest owned first</p>
      ${neverPlayed.length
        ? `<div class="insight-game-list">
             ${neverPlayed.slice(0, 10).map(_npRow).join('')}
             ${neverPlayed.length > 10 ? `
             <div class="insight-overflow">
               ${neverPlayed.slice(10).map(_npRow).join('')}
             </div>
             <button type="button" class="insight-more-btn" data-count="${neverPlayed.length - 10}">+${neverPlayed.length - 10} more</button>` : ''}
           </div>`
        : `<p class="no-sessions">${(stats.by_status.owned || 0) === 0 ? 'No owned games yet.' : 'All your owned games have been played!'}</p>`}
    </div>`;

  // Cooling Off — owned base games not played in 90–365 days (server-computed,
  // unaffected by collection pagination/filters).
  const coolingOff = stats.shelf_warmers || [];
  const coolingOffHtml = coolingOff.length ? `
    <div class="stats-section" data-section="cooling_off"${!currentPrefs.show_cooling_off ? ' style="display:none"' : ''}>
      ${_sectionInfoHeader('Cooling Off', 'About Cooling Off', '<p class="health-info-intro">Owned games you haven\'t played in 3–12 months — a nudge to bring them back to the table before they go fully dormant.</p>')}
      <p class="insight-subtext">Haven't played in a while</p>
      <div class="insight-game-list">
        ${coolingOff.map(g => `
          <div class="insight-game-row" data-game-id="${g.id}">
            <span class="insight-game-name">${escapeHtml(g.name)}</span>
            <span class="insight-game-meta">${g.days_since} days · last played ${escapeHtml(formatDate(g.last_played))}</span>
          </div>`).join('')}
      </div>
    </div>` : '';

  // Dormant — server-precomputed: owned games not played in 12+ months
  const dormantGames = stats.dormant_games || [];
  const dormantHtml = dormantGames.length ? `
    <div class="stats-section" data-section="dormant"${!currentPrefs.show_dormant ? ' style="display:none"' : ''}>
      ${_sectionInfoHeader(`Dormant Games (${dormantGames.length})`, 'About Dormant Games', '<p class="health-info-intro">Owned games you haven\'t played in over a year. A good prompt to revisit old favourites — or decide it\'s time to pass them on.</p>')}
      <p class="insight-subtext">Owned but not played in over a year</p>
      <div class="insight-game-list">
        ${dormantGames.slice(0, 10).map(g => `
          <div class="insight-game-row" data-game-id="${g.id}">
            <span class="insight-game-name">${escapeHtml(g.name)}</span>
            <span class="insight-game-meta">Last played ${escapeHtml(formatDate(g.last_played))}</span>
          </div>`).join('')}
        ${dormantGames.length > 10 ? `
        <div class="insight-overflow">
          ${dormantGames.slice(10).map(g => `
            <div class="insight-game-row" data-game-id="${g.id}">
              <span class="insight-game-name">${escapeHtml(g.name)}</span>
              <span class="insight-game-meta">Last played ${escapeHtml(formatDate(g.last_played))}</span>
            </div>`).join('')}
        </div>
        <button type="button" class="insight-more-btn" data-count="${dormantGames.length - 10}">+${dormantGames.length - 10} more</button>` : ''}
      </div>
    </div>` : '';

  // Top Mechanics — server-precomputed from owned collection
  const topMechanics = stats.top_mechanics || [];
  const maxMechanic = topMechanics[0]?.count || 1;
  const topMechanicsHtml = topMechanics.length ? `
    <div class="stats-section" data-section="top_mechanics"${!currentPrefs.show_top_mechanics ? ' style="display:none"' : ''}>
      ${_sectionInfoHeader('Top Mechanics', 'About Top Mechanics', '<p class="health-info-intro">The game mechanics that appear most often across your owned games. Useful for spotting the styles of play you gravitate towards.</p>')}
      <div class="stat-bar-chart">
        ${topMechanics.map(({ name, count }) => `
          <div class="stat-bar-row" data-drilldown="mechanic" data-mechanic-name="${escapeHtml(name)}" title="Filter by ${escapeHtml(name)}">
            <span class="stat-bar-label">${escapeHtml(name)}</span>
            <div class="stat-bar-track"><div class="stat-bar-fill" style="width:0%" data-target-width="${Math.round(count / maxMechanic * 100)}%"></div></div>
            <span class="stat-bar-count">${count}</span>
          </div>`).join('')}
      </div>
    </div>` : '';

  // Collection Value
  const collectionValueHtml = buildCollectionValueSection(
    stats.collection_value || {}, currentPrefs.show_collection_value === false
  ).outerHTML;

  // Trade / Sell Curation
  const tradeSell = stats.trade_sell || [];
  const tradeSellHtml = tradeSell.length ? `
    <div class="stats-section" data-section="trade_sell"${!currentPrefs.show_trade_sell ? ' style="display:none"' : ''}>
      ${_sectionInfoHeader('Trade / Sell Candidates', 'About Trade / Sell', '<p class="health-info-intro">Games that might be good candidates to trade or sell based on low play count, low ratings, high cost-per-play, or long time since last played.</p>')}
      <p class="insight-subtext">Curated from your collection</p>
      <div class="insight-game-list">
        ${tradeSell.map(g => `
          <div class="insight-game-row" data-game-id="${g.id}">
            <span class="insight-game-name">${escapeHtml(g.name)}</span>
            <span class="insight-game-meta">${escapeHtml(g.reason)} · Score ${g.score}</span>
          </div>`).join('')}
      </div>
    </div>` : '';

  // Player Leaderboard (Elo-based)
  const topPlayers = stats.top_players || [];
  const topPlayersHtml = topPlayers.length ? `
    <div class="stats-section" data-section="top_players"${currentPrefs.show_top_players === false ? ' style="display:none"' : ''}>
      ${_sectionInfoHeader('Player Leaderboard', 'About Player Leaderboard', '<p class="health-info-intro">Players ranked by Elo skill rating. Ratings start at 1500 and adjust after every scored session based on who you beat and who beats you. Win counts and session totals are shown for context.</p>')}
      <div class="most-played-list">
        ${topPlayers.map((p, i) => {
          const maxElo = Math.max(topPlayers[0].elo_rating || 1500, 1500);
          const minElo = 1000;
          const pct = Math.round(((p.elo_rating - minElo) / (maxElo - minElo)) * 100);
          return `
            <div class="most-played-item player-leaderboard-item" data-player-id="${p.player_id}" data-player-name="${escapeHtml(p.player_name)}" style="cursor:pointer" title="View ${escapeHtml(p.player_name)}'s sessions">
              <div class="most-played-rank">${i + 1}</div>
              ${renderPlayerAvatar({ name: p.player_name, avatar_url: p.avatar_url || null }, 'player-avatar player-avatar-sm')}
              <div class="most-played-info">
                <div class="most-played-name">${escapeHtml(p.player_name)}</div>
                <div class="stat-bar-track"><div class="stat-bar-fill" style="width:0%" data-target-width="${pct}%"></div></div>
              </div>
              <div class="most-played-count">
                <span class="player-elo">${Math.round(p.elo_rating)}</span>
                <span class="player-leaderboard-meta">${pluralize(p.session_count, 'play')} · ${p.win_rate}% WR</span>
              </div>
            </div>`;
        }).join('')}
      </div>
    </div>` : '';

  // Sessions by Day of Week
  const dowData = stats.sessions_by_dow || [];
  const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dowSessionsByDay = Array(7).fill(0);
  const dowGameIdsByDay = Array(7).fill(null).map(() => []);
  dowData.forEach(d => {
    dowSessionsByDay[d.dow] = d.count;
    dowGameIdsByDay[d.dow] = d.game_ids || [];
  });
  const maxDow = Math.max(...dowSessionsByDay, 1);
  const peakDowIdx = dowSessionsByDay.indexOf(Math.max(...dowSessionsByDay));
  const sessionsByDowHtml = (stats.total_sessions > 0) ? `
    <div class="stats-section" data-section="sessions_by_dow"${currentPrefs.show_sessions_by_dow === false ? ' style="display:none"' : ''}>
      ${_sectionInfoHeader('When Do You Play?', 'About When Do You Play', '<p class="health-info-intro">Sessions broken down by day of the week. Click any bar to see which games were played that day. Your peak day is highlighted in accent colour.</p>')}
      ${maxDow > 0 ? `<p class="stats-dow-peak">You play most on <strong>${DOW_LABELS[peakDowIdx]}s</strong></p>` : ''}
      <div class="stats-dow-chart">
        ${DOW_LABELS.map((label, i) => {
          const count = dowSessionsByDay[i];
          const pct = Math.round((count / maxDow) * 100);
          const gameIds = JSON.stringify(dowGameIdsByDay[i]);
          return `<div class="stats-dow-col${count > 0 ? ' stats-dow-col-clickable' : ''}" data-dow="${i}" data-dow-label="${label}" data-game-ids="${escapeHtml(gameIds)}" data-count="${count}">
            <div class="stats-dow-bar-wrap">
              <div class="stat-bar-fill stats-dow-bar" style="height:0%" data-target-height="${pct}%"${i === peakDowIdx && count > 0 ? ' data-peak="true"' : ''}></div>
            </div>
            <div class="stats-dow-label">${label}</div>
            <div class="stats-dow-count">${count || ''}</div>
          </div>`;
        }).join('')}
      </div>
    </div>` : '';

  // Play Activity Heatmap (52-week calendar)
  let playHeatmapHtml = '';
  if (stats.total_sessions > 0) {
    const dayMap = {};
    (stats.sessions_by_day || []).forEach(e => { dayMap[e.date] = e.count; });

    // Find the Sunday <= 364 days ago
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const startDate = new Date(today);
    startDate.setDate(startDate.getDate() - 364);
    startDate.setDate(startDate.getDate() - startDate.getDay()); // back to Sunday

    const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const cells = [];
    const monthLabels = []; // { colIndex, label }
    let colIndex = 0;
    let lastMonth = -1;
    const cur = new Date(startDate);

    while (cur <= today) {
      const dow = cur.getDay(); // 0=Sun
      if (dow === 0) {
        // new week column — check if month changed
        const m = cur.getMonth();
        if (m !== lastMonth) {
          monthLabels.push({ colIndex, label: MONTH_NAMES[m] });
          lastMonth = m;
        }
      }
      const iso = cur.toISOString().slice(0, 10);
      const count = dayMap[iso] || 0;
      const level = count === 0 ? 0 : count === 1 ? 1 : count <= 3 ? 2 : count <= 5 ? 3 : 4;
      const tooltip = count > 0 ? `${iso}: ${pluralize(count, 'session')}` : iso;
      const dayEntry = (stats.sessions_by_day || []).find(d => d.date === iso);
      const gameIds = dayEntry && dayEntry.game_ids ? JSON.stringify(dayEntry.game_ids) : '[]';
      cells.push(`<div class="hm-cell${count > 0 ? ' hm-cell-clickable' : ''}" data-level="${level}" data-date="${iso}" data-count="${count}" data-game-ids="${escapeHtml(gameIds)}" data-tooltip="${tooltip}"></div>`);
      if (dow === 6) colIndex++;
      cur.setDate(cur.getDate() + 1);
    }

    // Total weeks = colIndex + 1 (last partial week)
    const totalCols = colIndex + 1;
    const totalDays = Object.values(dayMap).reduce((a, b) => a + b, 0);
    const activeDays = Object.keys(dayMap).length;

    // Month label row: one span per column, label only where a month starts
    const monthSpans = Array.from({ length: totalCols }, (_, i) => {
      const entry = monthLabels.find(ml => ml.colIndex === i);
      return `<span>${entry ? entry.label : ''}</span>`;
    }).join('');

    playHeatmapHtml = `
    <div class="stats-section" data-section="play_heatmap"${currentPrefs.show_play_heatmap === false ? ' style="display:none"' : ''}>
      ${_sectionInfoHeader('Play Activity', 'About Play Activity', '<p class="health-info-intro">A 52-week calendar heatmap of your play sessions. Darker cells mean more sessions that day. Click any active cell to see which games were played.</p>')}
      <p class="stats-heatmap-meta">${pluralize(totalDays, 'session')} across ${pluralize(activeDays, 'day')} in the past year</p>
      <div class="stats-heatmap-wrap">
        <div class="stats-heatmap-dow-labels">
          <span></span><span>M</span><span></span>
          <span>W</span><span></span><span>F</span><span></span>
        </div>
        <div class="stats-heatmap-scroll">
          <div class="stats-heatmap-months">${monthSpans}</div>
          <div class="stats-heatmap-grid">${cells.join('')}</div>
        </div>
      </div>
      <div class="stats-heatmap-legend">
        <span>Less</span>
        <div class="hm-cell" data-level="0"></div>
        <div class="hm-cell" data-level="1"></div>
        <div class="hm-cell" data-level="2"></div>
        <div class="hm-cell" data-level="3"></div>
        <div class="hm-cell" data-level="4"></div>
        <span>More</span>
      </div>
    </div>`;
  }

  // Goals section
  const goalsHtml = (() => {
    if (!currentPrefs.show_goals) return '';
    const GOAL_TYPE_LABELS = {
      sessions_total:    'Total Sessions',
      sessions_year:     'Sessions This Year',
      play_all_owned:    'Play All Owned Games',
      game_sessions:     'Game Sessions',
      unique_mechanics:  'Unique Mechanics',
      unique_games_year: 'Different Games This Year',
      total_hours:       'Total Hours Played',
      category_coverage: 'Categories Covered',
      win_rate_target:   'Win Rate Target',
    };
    const goalCards = goals.length
      ? goals.map(g => {
          const pct = Math.min(100, Math.round((g.current_value / g.target_value) * 100));
          const complete = g.is_complete;
          const completedDate = g.completed_at ? new Date(g.completed_at).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' }) : null;
          const subtitle = g.game_name ? `${GOAL_TYPE_LABELS[g.type] || g.type} — ${escapeHtml(g.game_name)}` : (GOAL_TYPE_LABELS[g.type] || g.type);
          return `
            <div class="goal-card${complete ? ' goal-complete' : ''}" data-goal-id="${g.id}">
              <div class="goal-card-header">
                <div class="goal-card-title">${escapeHtml(g.title)}</div>
                <button class="goal-delete-btn" title="Delete goal" data-goal-id="${g.id}">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>
              <div class="goal-card-type">${escapeHtml(subtitle)}</div>
              <div class="goal-progress-bar-wrap">
                <div class="goal-progress-bar" style="width:${pct}%"></div>
              </div>
              <div class="goal-card-footer">
                <span class="goal-progress-text">${g.current_value} / ${g.target_value}</span>
                ${complete
                  ? `<span class="goal-complete-badge">✓ Complete${completedDate ? ` · ${completedDate}` : ''}</span>`
                  : `<span class="goal-pct">${pct}%</span>`}
              </div>
            </div>`;
        }).join('')
      : '<p class="stats-empty-note">No goals yet. Add one to start tracking your progress.</p>';

    return `
      <div class="stats-section" data-section="goals" id="stats-goals">
        <div class="stats-section-header">
          <div class="stats-section-title">Goals &amp; Challenges</div>
          <button class="health-info-btn" aria-label="About Goals &amp; Challenges" aria-expanded="false">${_INFO_BTN_SVG}</button>
          <button class="btn btn-secondary btn-sm" id="add-goal-btn" style="margin-left:auto">+ Add Goal</button>
        </div>
        <div class="health-info-popover" hidden>
          <div class="health-info-popover-inner">
            <p class="health-info-intro">Set personal milestones and track your progress automatically. Goals update as you log plays, rate games, or grow your collection. Completed goals are kept for reference.</p>
            <div class="health-info-factors">
              <div class="health-info-factor">
                <div class="health-info-factor-header"><span class="hb-label">Sessions</span></div>
                <span class="hb-detail" style="font-size:0.8rem">Total Sessions · Sessions This Year · Total Hours Played · Different Games This Year · Sessions for One Game</span>
              </div>
              <div class="health-info-factor">
                <div class="health-info-factor-header"><span class="hb-label">Collection</span></div>
                <span class="hb-detail" style="font-size:0.8rem">Play All Owned Games · Unique Mechanics Played · Categories Covered</span>
              </div>
              <div class="health-info-factor">
                <div class="health-info-factor-header"><span class="hb-label">Performance</span></div>
                <span class="hb-detail" style="font-size:0.8rem">Win Rate Target — tracks your win percentage across all logged sessions where a winner was recorded</span>
              </div>
            </div>
          </div>
        </div>
        <div class="goal-cards" id="goal-cards-list">
          ${goalCards}
        </div>
        <div id="add-goal-form" class="add-goal-form" style="display:none">
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Title</label>
              <input type="text" id="goal-title" class="form-input" placeholder="e.g. Log 50 sessions" maxlength="255">
            </div>
            <div class="form-group">
              <label class="form-label">Type</label>
              <select id="goal-type" class="select">
                <optgroup label="Sessions">
                  <option value="sessions_total">Total Sessions</option>
                  <option value="sessions_year">Sessions This Year</option>
                  <option value="total_hours">Total Hours Played</option>
                  <option value="unique_games_year">Different Games This Year</option>
                  <option value="game_sessions">Sessions for One Game</option>
                </optgroup>
                <optgroup label="Collection">
                  <option value="play_all_owned">Play All Owned Games</option>
                  <option value="unique_mechanics">Unique Mechanics Played</option>
                  <option value="category_coverage">Categories Covered</option>
                </optgroup>
                <optgroup label="Performance">
                  <option value="win_rate_target">Win Rate Target (%)</option>
                </optgroup>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Target</label>
              <input type="number" id="goal-target" class="form-input" min="1" placeholder="e.g. 50">
            </div>
          </div>
          <div class="form-group" id="goal-game-group" style="display:none">
            <label class="form-label">Game</label>
            <select id="goal-game-select" class="select">
              <option value="">Select a game…</option>
              ${(typeof state !== 'undefined' ? state.games : []).filter(g => g.status === 'owned').sort((a,b) => a.name.localeCompare(b.name))
                .map(g => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group" id="goal-year-group" style="display:none">
            <label class="form-label">Year</label>
            <input type="number" id="goal-year" class="form-input" min="2000" max="2100" placeholder="${new Date().getFullYear()}">
          </div>
          <div class="form-actions">
            <button class="btn btn-primary" id="goal-save-btn">Save Goal</button>
            <button class="btn btn-ghost" id="goal-cancel-btn">Cancel</button>
          </div>
        </div>
      </div>`;
  })();

  // Build ordered sections HTML
  const sectionsMap = {
    summary:           cardsHtml + healthScoreHtml,
    most_played:       mostPlayedHtml,
    top_players:       topPlayersHtml,
    recently_played:   recentSessionsHtml,
    recently_added:    recentlyAddedHtml,
    ratings:           ratingsHtml + ratingDeltaHtml,
    labels:            labelsHtml,
    added_by_month:    addedHtml,
    sessions_by_month: sessionsByMonthHtml,
    play_heatmap:      playHeatmapHtml,
    sessions_by_dow:   sessionsByDowHtml,
    never_played:      neverPlayedHtml,
    cooling_off:       coolingOffHtml,
    dormant:           dormantHtml,
    top_mechanics:     topMechanicsHtml,
    collection_value:  collectionValueHtml,
    trade_sell:        tradeSellHtml,
    goals:             goalsHtml,
  };
  const orderedSectionsHtml = currentPrefs.section_order.map(k => sectionsMap[k] || '').join('');

  el.innerHTML = `
    ${insightsHtml}
    <div class="stats-header">
      <h1 class="stats-title">Collection Stats</h1>
      <button class="stats-settings-btn" id="stats-settings-btn" title="Configure sections" aria-label="Configure sections">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="3"/>
          <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
        </svg>
      </button>
    </div>
    <div class="stats-settings-panel" id="stats-settings-panel" style="display:none">
      <div class="stats-settings-list" id="stats-settings-list">
        ${settingsTogglesHtml}
      </div>
      <div class="stats-export-group">
        <span class="stats-export-label">Backup & Restore</span>
        <div class="stats-export-btns">
          <button class="btn btn-secondary btn-sm" id="stats-backup-download" title="Download a ZIP containing your database and all images. Use this to move your collection to another server.">Download Backup</button>
          <button class="btn btn-secondary btn-sm" id="stats-restore-btn" title="Restore from a ZIP backup. This replaces all current data.">Restore from Backup…</button>
          <input type="file" id="stats-restore-file" accept=".zip" style="display:none">
        </div>
      </div>
      <div class="stats-export-group">
        <span class="stats-export-label">Import</span>
        <div class="stats-export-btns">
          <button class="btn btn-secondary btn-sm" id="stats-import-bgg" title="Import your BGG collection. On BGG go to your profile → Collection → Export → Export Collection as XML.">BGG Collection</button>
          <input type="file" id="stats-import-bgg-file" accept=".xml" style="display:none" aria-hidden="true">
          <button class="btn btn-secondary btn-sm" id="stats-import-bgg-plays" title="Import play history from BGG. On BGG go to your profile → Plays → Export Plays as XML.">BGG Plays</button>
          <input type="file" id="stats-import-bgg-plays-file" accept=".xml" style="display:none" aria-hidden="true">
          <button class="btn btn-secondary btn-sm" id="stats-import-csv" title="Import games from a CSV file with a 'name' column.">From CSV</button>
          <input type="file" id="stats-import-csv-file" accept=".csv" style="display:none" aria-hidden="true">
        </div>
      </div>
      <div class="stats-export-group">
        <span class="stats-export-label">Export Data</span>
        <div class="stats-export-cols-wrapper" id="stats-export-cols-wrapper">
          <button type="button" class="stats-export-cols-btn" id="stats-export-cols-btn">Fields</button>
          <div class="stats-export-cols-dropdown" id="stats-export-cols-dropdown" hidden></div>
        </div>
        <div class="stats-export-btns">
          <button class="btn btn-secondary btn-sm" id="stats-export-json">JSON</button>
          <button class="btn btn-secondary btn-sm" id="stats-export-csv">CSV</button>
        </div>
      </div>
    </div>
    <div class="stats-grid" id="stats-sections">
      ${orderedSectionsHtml}
    </div>`;

  // Animate stat bars and health ring on viewport entry
  if ('IntersectionObserver' in window) {
    const _statsIO = new IntersectionObserver((entries, obs) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        // Animate bar fills
        entry.target.querySelectorAll('.stat-bar-fill[data-target-width]').forEach(bar => {
          bar.style.width = bar.dataset.targetWidth;
        });
        entry.target.querySelectorAll('.stat-bar-fill[data-target-height]').forEach(bar => {
          bar.style.height = bar.dataset.targetHeight;
        });
        // Animate health ring arc
        entry.target.querySelectorAll('.health-ring-arc[data-target-offset]').forEach(arc => {
          arc.style.strokeDashoffset = arc.dataset.targetOffset;
        });
        obs.unobserve(entry.target);
      });
    }, { threshold: 0.12 });
    // Defer observation to the next frame so the element is guaranteed to be in the DOM
    // (buildStatsView returns a detached element; the caller appends it after this call).
    // Observing detached elements fires isIntersecting:false immediately and may not re-fire.
    requestAnimationFrame(() => {
      el.querySelectorAll('.stats-section, .stat-cards').forEach(s => _statsIO.observe(s));
    });
  } else {
    // Fallback: set immediately
    el.querySelectorAll('.stat-bar-fill[data-target-width]').forEach(bar => { bar.style.width = bar.dataset.targetWidth; });
    el.querySelectorAll('.stat-bar-fill[data-target-height]').forEach(bar => { bar.style.height = bar.dataset.targetHeight; });
    el.querySelectorAll('.health-ring-arc[data-target-offset]').forEach(arc => { arc.style.strokeDashoffset = arc.dataset.targetOffset; });
  }

  const settingsBtn   = el.querySelector('#stats-settings-btn');
  const settingsPanel = el.querySelector('#stats-settings-panel');
  const settingsList  = el.querySelector('#stats-settings-list');
  const sectionsEl    = el.querySelector('#stats-sections');

  settingsBtn.addEventListener('click', () => {
    const open = settingsPanel.style.display !== 'none';
    settingsPanel.style.display = open ? 'none' : 'block';
    settingsBtn.classList.toggle('active', !open);
  });

  let dragSrcKey = null;

  settingsList.querySelectorAll('.stats-settings-row').forEach(row => {
    // Checkbox visibility toggle
    row.querySelector('input').addEventListener('change', () => {
      const prefKey = row.querySelector('input').dataset.pref;
      const checked = row.querySelector('input').checked;
      currentPrefs = { ...currentPrefs, [prefKey]: checked };
      const section = sectionsEl.querySelector(`[data-section="${row.dataset.key}"]`);
      if (section) section.style.display = checked ? '' : 'none';
      // rating_delta lives inside the ratings slot — keep it in sync
      if (row.dataset.key === 'ratings') {
        const deltaSection = sectionsEl.querySelector('[data-section="rating_delta"]');
        if (deltaSection) deltaSection.style.display = checked ? '' : 'none';
      }
      if (onPrefsChange) onPrefsChange(currentPrefs);
    });

    // Drag-and-drop reordering
    row.addEventListener('dragstart', e => {
      dragSrcKey = row.dataset.key;
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      settingsList.querySelectorAll('.drag-over').forEach(r => r.classList.remove('drag-over'));
    });
    row.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (row.dataset.key !== dragSrcKey) row.classList.add('drag-over');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', e => {
      e.preventDefault();
      row.classList.remove('drag-over');
      if (!dragSrcKey || dragSrcKey === row.dataset.key) return;

      // Reorder settings rows in the panel
      const srcRow = settingsList.querySelector(`[data-key="${dragSrcKey}"]`);
      const rows = [...settingsList.children];
      const srcIdx = rows.indexOf(srcRow);
      const dstIdx = rows.indexOf(row);
      settingsList.insertBefore(srcRow, srcIdx < dstIdx ? row.nextSibling : row);

      // Reorder stat sections in the page (appendChild moves existing nodes)
      const newOrder = [...settingsList.querySelectorAll('[data-key]')].map(r => r.dataset.key);
      newOrder.forEach(key => {
        const sec = sectionsEl.querySelector(`[data-section="${key}"]`);
        if (sec) sectionsEl.appendChild(sec);
      });

      // Persist new order
      currentPrefs = { ...currentPrefs, section_order: newOrder };
      if (onPrefsChange) onPrefsChange(currentPrefs);
    });
  });

  return el;
}

// ===== Game Share =====

async function shareGameCard(game) {
  const players = (game.min_players || game.max_players) ? formatPlayers(game.min_players, game.max_players) : null;
  const playtime = (game.min_playtime || game.max_playtime) ? formatPlaytime(game.min_playtime, game.max_playtime) : null;
  const stats = [players, playtime].filter(Boolean).join(' · ');

  const descSnippet = game.description
    ? (game.description.length > 280 ? game.description.slice(0, 277).trimEnd() + '…' : game.description)
    : null;

  const lines = [game.name];
  if (stats) lines.push(stats);
  if (descSnippet) lines.push('', descSnippet);
  if (game.image_url) lines.push('', game.image_url);
  const text = lines.join('\n');

  try {
    if (navigator.share) {
      await navigator.share({ title: game.name, text });
    } else {
      await navigator.clipboard.writeText(text);
      showToast('Game info copied to clipboard.', 'success');
    }
  } catch (e) {
    if (e.name !== 'AbortError') showToast('Could not share game.', 'error');
  }
}
