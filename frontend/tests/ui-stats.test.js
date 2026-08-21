import { describe, it, expect, vi, afterEach } from 'vitest';
import { loadScripts } from './helpers/load.js';

const { buildStatsView } = loadScripts(
  ['shared-utils.js', 'ui-helpers.js', 'ui.js'],
  ['buildStatsView'],
);

function minimalStats() {
  return {
    total_games: 1,
    total_expansions: 0,
    total_sessions: 3,
    total_hours: 2,
    avg_session_minutes: 40,
    avg_rating: 7.5,
    by_status: { owned: 1, wishlist: 0 },
    never_played_count: 0,
    sessions_by_month: [{ month: '2026-08', count: 3 }],
    added_by_month: [{ month: '2026-08', count: 1 }],
    added_by_month_owned_only: [{ month: '2026-08', count: 1 }],
    sessions_by_dow: [0, 0, 0, 0, 0, 0, 0],
    sessions_by_day: [],
    collection_value: 0,
    collection_health: {},
    shelf_warmers: [],
    dormant_games: [],
    recently_added: [],
    recently_played: [],
    recent_sessions: [],
    most_played: [],
    top_players: [],
    top_mechanics: [],
    rating_distribution: [],
    ratings_distribution: {},
    label_counts: {},
    labels: [],
    top_wishlist_game: null,
    rating_vs_bgg: [],
    neglected_favorite: null,
    health_notifications: [],
    trade_sell: { candidates: [], total_value: 0 },
    h_index: 0,
    dimes: 0,
    nickels: 0,
    quarters: 0,
  };
}

class FakeIntersectionObserver {
  static instances = [];
  constructor(cb, opts) { this.cb = cb; this.opts = opts; this.unobserve = vi.fn(); this.disconnect = vi.fn(); this.observe = vi.fn(); FakeIntersectionObserver.instances.push(this); }
}

describe('buildStatsView observer lifecycle', () => {
  afterEach(() => {
    FakeIntersectionObserver.instances = [];
    vi.restoreAllMocks();
  });

  it('disconnects the previous bar-animation observer on rebuild', () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);

    buildStatsView(minimalStats(), [], { show_goals: false });
    // instance 0 = bar animation, instance 1 = jump-nav highlight
    expect(FakeIntersectionObserver.instances.length).toBe(2);
    const firstBarIO = FakeIntersectionObserver.instances[0];

    buildStatsView(minimalStats(), [], { show_goals: false });
    expect(FakeIntersectionObserver.instances.length).toBe(4);
    // Rebuilding must disconnect the previous observers so they cannot hold
    // strong refs to detached stats sections.
    expect(firstBarIO.disconnect).toHaveBeenCalledTimes(1);
    expect(FakeIntersectionObserver.instances[1].disconnect).toHaveBeenCalledTimes(1);
  });

  it('observes stats sections on the next animation frame', () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0); // run the deferred observation immediately
      return 0;
    });

    const el = buildStatsView(minimalStats(), [], { show_goals: false });
    expect(FakeIntersectionObserver.instances[0].observe).toHaveBeenCalled();
    expect(rafSpy).toHaveBeenCalledTimes(1);
  });
});
