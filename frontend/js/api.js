/**
 * Cardboard API client
 * Communicates with the FastAPI backend.
 */

const API_BASE = '/api';

// Response cache: stores { etag, data, headers } per GET path so that a 304
// reply can be resolved from the body we saw the last time the ETag changed.
// Headers are snapshotted into a fresh Headers instance so later fetches can't
// mutate cached values out from under us.
const _cache = {};

// Call after any mutation that changes the collection so the next GET fetches fresh data
function invalidateCollectionEtag() {
  for (const key of Object.keys(_cache)) {
    if (key === '/games/' || key.startsWith('/games/?') || key === '/collection/stats'
        || key === '/players/' || key.startsWith('/players/?')
        || key === '/goals/' || key.startsWith('/goals/?')) {
      delete _cache[key];
    }
  }
}

async function request(method, path, body = null) {
  const opts = { method, headers: {} };
  if (body !== null) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  if (method === 'GET' && _cache[path]) {
    opts.headers['If-None-Match'] = _cache[path].etag;
  }

  const resp = await fetch(`${API_BASE}${path}`, opts);

  if (resp.status === 304) {
    const cached = _cache[path];
    return cached ? cached.data : null;
  }
  if (resp.status === 204) return null;

  const data = await resp.json().catch(() => ({ detail: resp.statusText }));

  if (!resp.ok) {
    const msg = data.detail || `HTTP ${resp.status}`;
    const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    err.status = resp.status;
    throw err;
  }

  const etag = resp.headers.get('ETag');
  if (etag && method === 'GET') {
    _cache[path] = { etag, data, headers: new Headers(resp.headers) };
  }

  return data;
}

// Like request() but also returns response headers for endpoints that expose metadata.
async function requestWithMeta(method, path, body = null) {
  const opts = { method, headers: {} };
  if (body !== null) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  if (method === 'GET' && _cache[path]) {
    opts.headers['If-None-Match'] = _cache[path].etag;
  }

  const resp = await fetch(`${API_BASE}${path}`, opts);

  if (resp.status === 304) {
    const cached = _cache[path];
    if (cached) return { data: cached.data, headers: cached.headers };
    return { data: null, headers: resp.headers };
  }
  if (resp.status === 204) return { data: null, headers: resp.headers };

  const data = await resp.json().catch(() => ({ detail: resp.statusText }));

  if (!resp.ok) {
    const msg = data.detail || `HTTP ${resp.status}`;
    const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    err.status = resp.status;
    throw err;
  }

  const etag = resp.headers.get('ETag');
  if (etag && method === 'GET') {
    _cache[path] = { etag, data, headers: new Headers(resp.headers) };
  }

  return { data, headers: resp.headers };
}

async function uploadFile(path, file) {
  const fd = new FormData();
  fd.append('file', file);
  const resp = await fetch(`${API_BASE}${path}`, { method: 'POST', body: fd });
  if (resp.status === 204) return null;
  const data = await resp.json().catch(() => ({ detail: resp.statusText }));
  if (!resp.ok) {
    const err = new Error(data.detail || `HTTP ${resp.status}`);
    err.status = resp.status;
    throw err;
  }
  return data;
}

function _triggerDownload(url) {
  const a = document.createElement('a');
  a.href = url; a.download = '';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

const API = {
  // Games
  // Returns { data: GameResponse[], total: number } where total is the full matched count
  getGames: async (params = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== ''));
    const path = `/games/${qs.toString() ? '?' + qs : ''}`;
    const { data, headers } = await requestWithMeta('GET', path);
    const total = parseInt(headers.get('X-Total-Count') || '0', 10);
    return { data, total };
  },
  getGame:    (id)       => request('GET',    `/games/${id}`),
  getSimilarGames: (id) => request('GET',    `/games/${id}/similar`),
  createGame: (data, allowDuplicate = false) => request('POST', '/games/' + (allowDuplicate ? '?allow_duplicate=true' : ''), data),
  updateGame: (id, data) => request('PATCH',  `/games/${id}`, data),
  deleteGame: (id)       => request('DELETE', `/games/${id}`),

  // Play sessions
  getSessionSummary: (gameId)   => request('GET',    `/games/${gameId}/session-summary`),
  getSessions:   (gameId)       => request('GET',    `/games/${gameId}/sessions`),
  addSession:    (gameId, data) => request('POST',   `/games/${gameId}/sessions`, data),
  updateSession: (id, data)     => request('PATCH',  `/sessions/${id}`, data),
  deleteSession: (id)           => request('DELETE', `/sessions/${id}`),

  // Images
  uploadImage:        (gameId, file) => uploadFile(`/games/${gameId}/image`, file),
  deleteImage:        (gameId)       => request('DELETE', `/games/${gameId}/image`),

  // Instructions
  uploadInstructions: (gameId, file) => uploadFile(`/games/${gameId}/instructions`, file),
  deleteInstructions: (gameId)       => request('DELETE', `/games/${gameId}/instructions`),

  // Photo gallery (multi-image)
  getImages:          (gameId)           => request('GET', `/games/${gameId}/images`),
  uploadGalleryImage: (gameId, file)     => uploadFile(`/games/${gameId}/images`, file),
  deleteGalleryImage: (gameId, imgId)    => request('DELETE', `/games/${gameId}/images/${imgId}`),
  reorderGalleryImages: (gameId, order)  => request('PATCH', `/games/${gameId}/images/reorder`, { order }),
  addGalleryImageFromUrl: (gameId, url)  => request('POST',  `/games/${gameId}/images/from-url`, { url }),
  updateGalleryImage:     (gameId, imgId, data) => request('PATCH', `/games/${gameId}/images/${imgId}`, data),

  // Stats
  getStats: () => request('GET', '/stats'),
  getCollectionStats: () => request('GET', '/collection/stats'),

  // ETag cache management
  invalidateCollectionEtag,

  // BGG search / fetch (for Add Game autocomplete)
  bggSearch:  (q)       => request('GET', `/games/bgg-search?q=${encodeURIComponent(q)}`),
  bggFetch:   (bggId)   => request('GET', `/games/bgg-fetch/${bggId}`),

  // BGG import
  importBGG: (file) => uploadFile('/games/import/bgg', file),

  // BGG refresh
  refreshFromBGG: (gameId) => request('POST', `/games/${gameId}/refresh-bgg`),

  // BGG play history import
  importBGGPlays: (file) => uploadFile('/games/import/bgg-plays', file),

  // CSV import
  importCSV: (file) => uploadFile('/games/import/csv', file),

  // Duplicate / expansion guard
  checkDuplicate: (name, bggId) => request('GET', `/games/check-duplicate?name=${encodeURIComponent(name)}${bggId ? `&bgg_id=${bggId}` : ''}`),

  // Game night suggestions
  suggestGames: (playerCount, maxMinutes) => request('POST', '/games/suggest', { player_count: playerCount, max_minutes: maxMinutes }),

  // Group recommendation (player matchmaking)
  groupRecommend: (playerIds, maxMinutes, mechanic) => request('POST', '/games/group-recommend', { player_ids: playerIds, max_minutes: maxMinutes, mechanic }),

  // "Play This Next" single-game recommendation
  recommend: (params) => request('GET', `/recommend?${params}`),

  // Bulk session logging
  bulkSession: (data) => request('POST', '/sessions/bulk', data),

  // Players
  getPlayers:         ()           => request('GET',    '/players/'),
  createPlayer:       (name)       => request('POST',   '/players/', { name }),
  renamePlayer:       (id, name)   => request('PATCH',  `/players/${id}`, { name }),
  deletePlayer:       (id)         => request('DELETE', `/players/${id}`),
  getPlayerStats:     (id)         => request('GET',    `/players/${id}/stats`),
  getPlayerSessions:  (id)         => request('GET',    `/players/${id}/sessions`),
  uploadPlayerAvatar:    (id, file)   => uploadFile(`/players/${id}/avatar`, file),
  setPlayerAvatarPreset: (id, preset) => request('POST', `/players/${id}/avatar/preset`, { preset }),
  deletePlayerAvatar:    (id)         => request('DELETE', `/players/${id}/avatar`),

  // Collection sharing
  getShareTokens:    ()              => request('GET',    '/share/tokens'),
  createShareToken:  (label, expiresIn) => {
    const params = new URLSearchParams();
    if (label) params.set('label', label);
    if (expiresIn) params.set('expires_in', expiresIn);
    const qs = params.toString();
    return request('POST', `/share/tokens${qs ? '?' + qs : ''}`);
  },
  deleteShareToken:  (token)         => request('DELETE', `/share/tokens/${token}`),
  getSharedGames:    (token)         => request('GET',    `/share/${token}/games`),
  getSharedGame:     (token, gameId) => request('GET',    `/share/${token}/games/${gameId}`),
  submitWantToPlay:  (token, gameId, data) => request('POST', `/share/${token}/games/${gameId}/want-to-play`, data),
  getWantToPlayRequests: ()          => request('GET',    '/share/requests'),
  markRequestSeen:   (id)            => request('PATCH',  `/share/requests/${id}/seen`),

  // Goals
  checkGoals:  ()          => request('POST',   '/goals/check'),
  getGoals:    ()          => request('GET',    '/goals/'),
  createGoal:  (data)      => request('POST',   '/goals/', data),
  deleteGoal:  (id)        => request('DELETE', `/goals/${id}`),

  // Backup
  downloadBackup:     () => _triggerDownload(`${API_BASE}/games/backup`),
  downloadJsonBackup: () => _triggerDownload(`${API_BASE}/games/backup/json`),
  previewRestore:     (file) => uploadFile('/games/restore/preview', file),
  restoreBackup:      (file) => uploadFile('/games/restore', file),

  // Persistent user settings
  getSetting: (key)        => request('GET', `/settings/${encodeURIComponent(key)}`),
  setSetting: (key, value) => request('PUT', `/settings/${encodeURIComponent(key)}`, { value }),
};

// ── Offline session queue ────────────────────────────────────────────────────
// When addSession fails due to no connectivity, the payload is saved to
// IndexedDB. On the next 'online' event (or page load while connected) all
// queued sessions are replayed in order.

const _OQ_DB    = 'cardboard-offline';
const _OQ_STORE = 'pendingSessions';

function _oqOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(_OQ_DB, 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore(_OQ_STORE, { autoIncrement: true });
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

function _oqAdd(gameId, data) {
  return _oqOpen().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(_OQ_STORE, 'readwrite');
    tx.objectStore(_OQ_STORE).add({ gameId, data, ts: Date.now() });
    tx.oncomplete = resolve;
    tx.onerror    = e => reject(e.target.error);
  }));
}

function _oqGetAll() {
  return _oqOpen().then(db => new Promise((resolve, reject) => {
    const tx    = db.transaction(_OQ_STORE, 'readonly');
    const items = [];
    const req   = tx.objectStore(_OQ_STORE).openCursor();
    req.onsuccess = e => {
      const c = e.target.result;
      if (c) { items.push({ key: c.key, ...c.value }); c.continue(); }
      else resolve(items);
    };
    req.onerror = e => reject(e.target.error);
  }));
}

function _oqDelete(key) {
  return _oqOpen().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(_OQ_STORE, 'readwrite');
    tx.objectStore(_OQ_STORE).delete(key);
    tx.oncomplete = resolve;
    tx.onerror    = e => reject(e.target.error);
  }));
}

async function flushOfflineSessionQueue() {
  let pending;
  try { pending = await _oqGetAll(); } catch { return 0; }
  if (!pending.length) return 0;
  let flushed = 0;
  for (const { key, gameId, data } of pending) {
    if (!navigator.onLine) break;
    try {
      await request('POST', `/games/${gameId}/sessions`, data);
      await _oqDelete(key);
      flushed++;
    } catch { /* still failing — leave in queue, retry next time */ }
  }
  return flushed;
}

// Wrap addSession: on network failure while offline, queue and throw a
// sentinel error so callers can keep the optimistic UI update.
const _realAddSession = API.addSession;
API.addSession = async function(gameId, data) {
  try {
    return await _realAddSession(gameId, data);
  } catch (err) {
    if (err instanceof TypeError && !navigator.onLine) {
      await _oqAdd(gameId, data);
      const queued = new Error('Session queued — will sync when back online.');
      queued.isOfflineQueued = true;
      throw queued;
    }
    throw err;
  }
};

window.addEventListener('online', async () => {
  const n = await flushOfflineSessionQueue();
  if (n > 0) {
    window.dispatchEvent(new CustomEvent('offlineSessionsFlushed', { detail: { count: n } }));
  }
});
