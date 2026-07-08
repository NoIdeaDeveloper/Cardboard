/**
 * Cardboard – UI helper functions
 *
 * Contains: animations, notifications, form helpers, display helpers,
 * media/thumbnail helpers. No dependency on app state.
 * Loaded before ui.js and app.js.
 */

// ===== Animation Helpers =====

function animateCountUp(el, target, duration) {
  duration = duration || 600;
  const from = parseInt(el.textContent) || 0;
  if (isNaN(target) || from === target) return;
  const start = performance.now();
  function frame(now) {
    const progress = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = Math.round(from + (target - from) * eased);
    if (progress < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function buildSparkline(sessions, widthPx, heightPx) {
  widthPx = widthPx || 160;
  heightPx = heightPx || 32;
  const now = new Date();
  const months = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (11 - i), 1);
    return { key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, count: 0 };
  });
  (sessions || []).forEach(s => {
    const key = (s.played_at || '').slice(0, 7);
    const m = months.find(m => m.key === key);
    if (m) m.count++;
  });
  const max = Math.max(...months.map(m => m.count), 1);
  const step = widthPx / (months.length - 1);
  const pts = months.map((m, i) =>
    `${(i * step).toFixed(1)},${(heightPx - (m.count / max) * (heightPx - 2) - 1).toFixed(1)}`
  ).join(' ');
  const firstPt = '0,' + heightPx;
  const lastPt = widthPx.toFixed(1) + ',' + heightPx;
  const areaPoints = firstPt + ' ' + pts + ' ' + lastPt;
  return `<svg class="sparkline" viewBox="0 0 ${widthPx} ${heightPx}" width="${widthPx}" height="${heightPx}" aria-hidden="true">
    <polygon class="sparkline-area" points="${areaPoints}"/>
    <polyline points="${pts}"/>
  </svg>`;
}

function floatPlusOne(cardEl) {
  if (!cardEl) return;
  const el = document.createElement('div');
  el.className = 'float-plus-one';
  el.textContent = '+1';
  cardEl.style.position = 'relative';
  cardEl.appendChild(el);
  setTimeout(function() { el.remove(); }, 850);
}

// ===== Notifications =====

function _hideToast(toast) {
  toast.classList.add('hide');
  setTimeout(() => toast.remove(), 400);
}

function showToast(message, type = 'info', duration = 3500) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  if (type === 'error') {
    toast.setAttribute('role', 'alert');
    toast.setAttribute('aria-live', 'assertive');
    duration = Math.max(duration, 5000);
  }
  container.appendChild(toast);
  setTimeout(() => _hideToast(toast), duration);
}

// Clickable milestone toast — clicking navigates to the game (callback injected by app.js)
function showMilestoneToast(message, gameId, onClickGame) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast toast-milestone';
  toast.textContent = message;
  if (onClickGame) {
    toast.style.cursor = 'pointer';
    toast.title = 'Click to open game';
    toast.addEventListener('click', () => { toast.remove(); onClickGame(gameId); });
  }
  container.appendChild(toast);
  setTimeout(() => _hideToast(toast), 5000);
}

function showConfirm(title, message) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-dialog">
        <h3 class="confirm-title">${escapeHtml(title)}</h3>
        <p class="confirm-message">${escapeHtml(message)}</p>
        <div class="confirm-actions">
          <button class="btn btn-secondary" id="confirm-cancel">Cancel</button>
          <button class="btn btn-danger" id="confirm-ok">Remove</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#confirm-cancel').addEventListener('click', () => { overlay.remove(); resolve(false); });
    overlay.querySelector('#confirm-ok').addEventListener('click', () => { overlay.remove(); resolve(true); });
  });
}

// ===== Async Helper =====

async function withLoading(btn, fn, loadingText) {
  const orig = btn.innerHTML;
  btn.disabled = true;
  if (loadingText) btn.innerHTML = loadingText;
  try {
    await fn();
  } finally {
    btn.disabled = false;
    btn.innerHTML = orig;
  }
}

// ===== Field Validation Helpers =====

function setFieldError(errEl, inputEl, msg) {
  if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
  if (inputEl) inputEl.classList.add('invalid');
}

function clearFieldError(errEl, inputEl) {
  if (errEl) { errEl.textContent = ''; errEl.style.display = 'none'; }
  if (inputEl) inputEl.classList.remove('invalid');
}

// ===== Display Helpers =====

function renderStars(rating) {
  const filled = Math.round(rating || 0);
  let html = '<div class="rating-stars">';
  for (let i = 1; i <= 10; i++) {
    html += `<svg class="star${i <= filled ? '' : ' empty'}" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>`;
  }
  return html + '</div>';
}

function renderDifficultyBar(difficulty) {
  if (!difficulty) return '';
  const filled = Math.round(difficulty);
  let bars = '';
  for (let i = 1; i <= 5; i++) {
    bars += `<div class="diff-segment${i <= filled ? ' filled' : ''}"></div>`;
  }
  const label = difficulty <= 2 ? 'Light' : difficulty <= 3.5 ? 'Medium' : 'Heavy';
  return `<div class="difficulty-bar">${bars}</div><span class="diff-label">${label}</span>`;
}

function formatDatetime(isoDatetime) {
  if (!isoDatetime) return null;
  const d = new Date(isoDatetime);
  if (isNaN(d)) return isoDatetime;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function loadJsonFromStorage(key, defaultValue) {
  try {
    const item = localStorage.getItem(key);
    return item !== null ? JSON.parse(item) : defaultValue;
  } catch { return defaultValue; }
}

function saveJsonToStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (_) { /* quota exceeded or private browsing — non-fatal */ }
}

function isSafeUrl(url) {
  if (!url) return false;
  return url.startsWith('/api/') || url.startsWith('https://');
}

function placeholderSvg() {
  return `<svg class="placeholder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true">
    <rect x="2" y="6" width="20" height="14" rx="2"/><rect x="6" y="2" width="12" height="4" rx="1"/>
    <circle cx="12" cy="13" r="3"/><circle cx="12" cy="13" r="1.2" fill="currentColor" stroke="none"/>
  </svg>`;
}

// ===== Card / List Media Helpers =====

function thumbImgHtml(src, name) {
  return `<img src="${escapeHtml(src)}" alt="${escapeHtml(name)}" loading="lazy" data-fallback="1">
          ${placeholderSvg().replace('class="placeholder-icon"', 'class="placeholder-icon" style="display:none"')}`;
}

function wireImgFallbacks(container) {
  container.querySelectorAll('img[data-fallback]').forEach(img => {
    if (img.dataset.wired) return;
    img.dataset.wired = '1';
    img.addEventListener('error', () => {
      img.style.display = 'none';
      const sib = img.nextElementSibling;
      if (sib) sib.style.display = 'flex';
    });
  });
}

function cardMediaHtml(game) {
  const thumbSrc = game.thumbnail_url || game.image_url;
  return isSafeUrl(thumbSrc) ? thumbImgHtml(thumbSrc, game.name) : placeholderSvg();
}

function listThumbHtml(game) {
  const thumbSrc = game.thumbnail_url || game.image_url;
  return isSafeUrl(thumbSrc) ? thumbImgHtml(thumbSrc, game.name) : placeholderSvg();
}

function buildSkeletonGrid(count) {
  count = count || 12;
  const cards = Array.from({ length: count }, () => `
    <div class="skeleton-card">
      <div class="skeleton-block skeleton-image"></div>
      <div class="skeleton-block skeleton-line"></div>
      <div class="skeleton-block skeleton-line-short"></div>
    </div>
  `).join('');
  return `<div class="skeleton-grid">${cards}</div>`;
}
