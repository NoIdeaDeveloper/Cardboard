/**
 * Shared utility functions used by both index.html (main app) and share.html (shared view).
 * Load this before ui.js and app.js.
 */

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseList(json) {
  try { const v = JSON.parse(json || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

function pluralize(count, singular, plural) {
  return `${count} ${count === 1 ? singular : (plural || singular + 's')}`;
}

function formatDate(isoDate) {
  if (!isoDate) return '';
  const d = new Date(isoDate + 'T00:00:00Z');
  if (isNaN(d)) return isoDate;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function formatPlaytime(min, max) {
  if (!min && !max) return '';
  if (min === max || !max) return `${min} min`;
  return `${min}–${max} min`;
}

function formatPlayers(min, max) {
  if (!min && !max) return '';
  if (min === max || !max) return pluralize(min, 'player');
  return `${min}–${max} players`;
}

// Renders a player avatar: <img> for a custom photo or SVG preset, initials <div> otherwise.
// Works in both app.js and ui.js.
function renderPlayerAvatar(player, cssClass) {
  const cls = cssClass || 'player-avatar';
  const name = player.name || player.player_name || '';
  const url = player.avatar_url || (player.avatar_preset ? `/avatars/${player.avatar_preset}.svg` : null);
  if (url) {
    return `<img class="${cls} player-avatar-img" src="${escapeHtml(url)}" alt="${escapeHtml(name)}" loading="lazy">`;
  }
  const color = typeof playerAvatarColor === 'function' ? playerAvatarColor(name) : '#888';
  const initials = typeof playerInitials === 'function' ? playerInitials(name) : (name.slice(0, 2) || '?').toUpperCase();
  return `<div class="${cls}" style="background:${color}" aria-hidden="true">${escapeHtml(initials)}</div>`;
}
