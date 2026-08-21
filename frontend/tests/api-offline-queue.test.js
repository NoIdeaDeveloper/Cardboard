import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadScripts } from './helpers/load.js';

// api.js references indexedDB for the offline session queue; jsdom has none,
// so install a minimal in-memory implementation that records queued payloads.
function makeFakeIndexedDB() {
  const store = [];
  const db = {
    createObjectStore: () => ({}),
    transaction: () => {
      const tx = {
        objectStore: () => ({
          add: (value) => {
            store.push(value);
            queueMicrotask(() => { if (tx.oncomplete) tx.oncomplete(); });
            return { onsuccess: null };
          },
        }),
        oncomplete: null,
        onerror: null,
      };
      return tx;
    },
  };
  const openRequest = {
    onupgradeneeded: null,
    onsuccess: null,
    onerror: null,
    result: null,
  };
  return {
    db,
    store,
    open: () => {
      // Simulate a successful open: onupgradeneeded runs first (creating the
      // object store), then onsuccess resolves with the connection.
      queueMicrotask(() => {
        if (openRequest.onupgradeneeded) openRequest.onupgradeneeded({ target: { result: db } });
        if (openRequest.onsuccess) openRequest.onsuccess({ target: { result: db } });
      });
      return openRequest;
    },
  };
}

const { API } = loadScripts(['api.js'], ['API']);

describe('API.addSession offline queue', () => {
  let fakeDb;

  beforeEach(() => {
    fakeDb = makeFakeIndexedDB();
    vi.stubGlobal('indexedDB', { open: fakeDb.open });
    vi.stubGlobal('navigator', { onLine: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('queues the session and throws a sentinel on 5xx while online', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      headers: { get: () => null },
      json: async () => ({ detail: 'Service unavailable' }),
    }));

    await expect(API.addSession(7, { played_at: '2026-08-21' })).rejects.toMatchObject({
      isOfflineQueued: true,
    });
    expect(fakeDb.store.length).toBe(1);
    expect(fakeDb.store[0]).toMatchObject({ gameId: 7 });
    expect(fakeDb.store[0].data).toMatchObject({ played_at: '2026-08-21' });
  });

  it('queues the session on a network TypeError regardless of navigator.onLine', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Network request failed')));

    await expect(API.addSession(7, { played_at: '2026-08-21' })).rejects.toMatchObject({
      isOfflineQueued: true,
    });
    expect(fakeDb.store.length).toBe(1);
  });

  it('rethrows non-5xx API errors without queueing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      headers: { get: () => null },
      json: async () => ({ detail: 'Invalid session' }),
    }));

    await expect(API.addSession(7, {})).rejects.toMatchObject({
      status: 400,
      message: 'Invalid session',
    });
    expect(fakeDb.store.length).toBe(0);
  });

  it('passes through success responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ game_session_count: 3 }),
    }));

    const result = await API.addSession(7, {});
    expect(result).toMatchObject({ game_session_count: 3 });
    expect(fakeDb.store.length).toBe(0);
  });
});
