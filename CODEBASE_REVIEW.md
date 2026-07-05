# Cardboard — Codebase Review

Five parallel deep-dives (backend security, backend performance, frontend, privacy, features) were run, then the source was re-read to verify every headline claim before presenting. All citations below were confirmed against the actual files. Cross-cutting duplicates found by multiple agents are merged; one agent error is corrected.

The app is a self-hosted, single-Docker FastAPI + vanilla-JS SQLite board-game tracker. It is well-engineered in many respects (batched queries, virtualized collection, ETag caching, SSRF guards, defusedxml, non-root container). The findings below are the gaps.

---

## 0. Cross-cutting root causes (fix these first)

Three architectural issues spawn the majority of findings across security, privacy, and features. Fixing them collapses the long tail.

### RC1. No authentication or authorization on **any** endpoint — *Critical*
`backend/main.py:57-131`, every file under `backend/routers/`.

There is no `Depends` for auth anywhere. The README's "token-based read-only share links" is a UX layer on top of a fully open API — not a security boundary. Anyone who can reach the port can: create/delete games, download/restore the full DB, list and revoke every share token, read visitor submissions, change settings, upload files, and trigger Elo recalculation. The Docker default (`docker-compose.yml:9` maps `8000:8000`) and README quick-start push users toward exposing the port directly.

This single gap is the root cause of: backup leak (C2 below), social-graph leak, share-token enumeration, settings tampering, restore-overwrite, and most of the privacy findings. **Fix:** add a `CARDBOARD_ADMIN_TOKEN` env var + a FastAPI `Depends` doing `secrets.compare_digest` on an `Authorization: Bearer` header; apply globally except to `/health` and the share-token-GET sub-routes. Document prominently that the app **must** sit behind an auth-gating reverse proxy if reachable beyond localhost.

### RC2. Share-token responses leak the full `GameResponse` — *Critical*
`backend/routers/sharing.py:20-22,70-83`; `backend/schemas.py:18-132`; `backend/routers/games/backup.py:169-287` (static-HTML export).

`_build_game_list` calls `build_game_responses(...)` which returns `GameResponse`, which **extends `GameBase`** (schemas.py:120). `GameBase` includes `purchase_price`, `purchase_location`, `sale_price`, `location` (storage), `user_notes`, `loaned_to` (a friend's name), `loaned_at`, `target_price`, `condition`, `edition` (schemas.py:42-60). Verified. So a share-link visitor — or anyone, given RC1 — receives what you paid for every game, where you store it, your private notes, and who you lent it to. The static-HTML export (marketed as "share without exposing your server") embeds the same fields in page JSON.

**Fix:** define a `GameShareResponse` schema whitelisting only share-safe fields (name, image, players, playtime, difficulty, description, tags, user_rating, bgg_id). Use it in both `routers/sharing.py` and `backup.py:export_static_html`. Show the user a preview of included fields before generating an export.

### RC3. Share tokens travel in the URL path/query — logged everywhere — *High*
`backend/main.py:107-121` (logs `request.url.path`); `Dockerfile:54` (`--access-log`); `frontend/js/share.js:11` (`?token=` query); `frontend/js/app.js:1775,5057` (renders `?token=` into shareable input).

The token is in the URL for `/api/share/{token}/games` and `/share.html?token=...`. It lands in: the app log, uvicorn access log, any log aggregator, browser history, proxy logs, and same-origin `Referer`. `Referrer-Policy: strict-origin-when-cross-origin` only protects cross-origin leakage. Tokens default to never-expiring (`ALLOWED_EXPIRY_MINUTES=(10,30,60)` or omit for never — `sharing.py:30`). **Fix:** move the token to the URL fragment (`#token=`) for the share page, and/or accept it via an `X-Share-Token` header on API calls; redact the token segment in `log_requests` before logging.

---

## 1. Security

### Critical
- **S-C1. Unauthenticated full-DB restore** — `backend/routers/games/backup.py:682-748`. `POST /api/games/restore` accepts a ZIP, runs only `PRAGMA integrity_check` (valid SQLite, not trusted schema), then `os.replace()` swaps the live DB. Combined with RC1 an attacker can download, tamper, and restore. **Fix:** admin auth + validate restored schema against `models.Base` before swap.
- **S-C2. Unauthenticated backup + all exports** — `backup.py:42-104` (ZIP with DB + `avatars/` face photos + gallery), `:106-167` (JSON), `:169-287` (static HTML), `:289-506` (PDF), `:508-547` (export JSON), `:549-584` (export CSV — field list deliberately includes `purchase_price`, `purchase_location`, `location`, `user_notes`), `:586-618` (export images). All unauthenticated GETs. **Fix:** admin auth on all; drop private fields from CSV defaults.

### High
- **S-H1. Share-token management unauthenticated** — `sharing.py:25-56`. `GET /api/share/tokens` returns every token string; `POST` creates unlimited tokens; `DELETE` revokes any. `label` query param has no `max_length`. **Fix:** admin auth + `Query(max_length=255)`.
- **S-H2. Want-to-play & settings unauthenticated** — `sharing.py:122-152` (`GET /api/share/requests` returns visitor names + messages; `PATCH .../seen` mutable); `settings.py:18-33` (`GET/PUT /api/settings/{key}` arbitrary keys, values up to 10KB, logged verbatim at `:32`). **Fix:** admin auth; stop logging values.
- **S-H3. `ShareToken.token` stored plaintext, never deleted when expired** — `models.py:124` (PK is the raw token, no hash); `sharing.py:59-67` (`_validate_token` only 404s on expiry, never deletes). **Fix:** store `sha256(token)`; return plaintext only once at creation; delete expired rows inline or via a startup sweep.

### Medium
- **S-M1. No rate limiting** except BGG proxy (`bgg.py:46-60`, 10/min per IP) and a bypassable want-to-play row-count cap (see S-M5). No limit on token creation, uploads, backups, imports. **Fix:** global per-IP limiter (e.g. `slowapi`) for mutating verbs.
- **S-M2. EXIF (incl. GPS) never stripped** — `game_images.py:97-130`, `crud.py:476-505`, `players.py:144-186` write raw uploaded bytes; `_generate_thumbnail` re-encodes to WebP (drops EXIF) but the **original** is served. Phone photos preserve GPS of your home/friends' homes. **Fix:** re-encode through Pillow with `exif=b""` on every upload path.
- **S-M3. Pillow decompression-bomb ceiling not set** — no `Image.MAX_IMAGE_PIXELS` anywhere; a 10MB PNG can decode to ~89MP / ~268MB RAM. Gallery/cover uploads have no concurrency cap (only the cache semaphore is bounded to 2). **Fix:** set `Image.MAX_IMAGE_PIXELS = 8_000_000` at import; `img.verify()` before persisting.
- **S-M4. `/api/docs` + `/openapi.json` enabled unconditionally** — `main.py:57`. Discloses every endpoint + schema (incl. private fields) to anyone. **Fix:** `docs_url=None` controlled by env, or gate behind auth.
- **S-M5. CSP weaknesses + nonce decorative** — `main.py:93-103`: `style-src 'unsafe-inline'`; `script-src 'self' 'nonce-XXX'` but the frontend uses only external scripts (no inline), so the nonce adds nothing and `X-CSP-Nonce` exposes it to any script. `img-src ... https:` is broad. **Fix:** drop the nonce; tighten `img-src` to BGG CDNs.
- **S-M6. BGG `<description>` HTML stored unsanitized** — `bgg.py:115-116` stores verbatim. Frontend escapes it (defense-in-depth ok), but sanitize server-side for fields meant as text (`user_notes`, `notes`, `winner`, `visitor_name`, `message`) and use `bleach` for `description`.
- **S-M7. Unpinned `Pillow>=10.0.0` and unpinned `certifi`** — `requirements.txt`. The 10.0.0 floor is vulnerable to multiple CVEs (CVE-2023-44271, CVE-2023-50447, CVE-2024-28219, CVE-2024-42004). **Fix:** pin `Pillow>=10.4.0` (or `==11.x`); pin `certifi`; use a lockfile.

### Low
- **S-L1. DNS-rebinding TOCTOU in SSRF** — `utils.py:103-110` re-validates IP then returns `None`, letting `HTTPHandler` re-resolve and connect — a flip window. BGG host is fixed so exposure is `from-url` image caching. **Fix:** resolve once, connect to literal IP with manual `Host` header.
- **S-L2. BGG rate limiter per-`request.client.host`** — `bgg.py:47`. Behind a reverse proxy this is the proxy's IP, so one bucket for everyone. **Fix:** `uvicorn --proxy-headers --forwarded-allow-ips` + document.
- **S-L3. README says CORS default `*`; code defaults to localhost** — `README.md:111` vs `main.py:65-71`. A user following the README could set `*` and expose the API to every website they visit. **Fix:** fix the README; refuse to start on `*` unless an override is set.
- **S-L4. No HSTS header** — `main.py:87-104`. **Fix:** add `Strict-Transport-Security` (at least when over HTTPS).
- **S-L5. Settings values logged verbatim** — `settings.py:32`. **Fix:** log key + length only.

**Adequately handled (no action):** defusedxml for all BGG XML; parameterized SQL (the f-string `text()` in migrations interpolates only hardcoded constants); path-traversal guards (`realpath`+`commonpath`/`startswith` everywhere); `secrets.token_urlsafe(32)`; upload size caps before persist + magic-byte validation; SSRF IP-range checks (Python 3.12 flags IPv4-mapped IPv6); outbound HTTP size/timeout caps; no `pickle`/`eval`/`subprocess`; generic error handler (no stack trace in body); non-root Docker; `allow_credentials=False`; SQLite WAL + `busy_timeout`.

---

## 2. Privacy

### Critical
- **P-C1. = RC1** (no auth).
- **P-C2. = S-C2** (backup ZIP leaks DB + friend face photos in `avatars/` + gallery).
- **P-C3. = RC2** (share link leaks purchase prices, storage location, notes, loan recipient names).
- **P-C4. = RC2** (static-HTML export embeds the same).
- **P-C5. Unauthenticated social-graph exposure** — `players.py:351-543` (`/api/players/{id}/stats` returns `most_played_with` with co-player names, head-to-head records, and avatar URLs) and `:546-589` (`/api/players/{id}/sessions` returns each session's co-players). Plus `/api/players/` returns every player's name + avatar URL. Anyone can map your friend group, who hosts, who beats whom, and fetch their face photos. **Fix:** admin auth on all `/api/players/*`; never include `most_played_with`/co-player data in share-token views.

### High
- **P-H1. = S-M2** (EXIF GPS not stripped).
- **P-H2. = RC3** (tokens logged).
- **P-H3. = S-H1 + S-H3** (`GET /api/share/tokens` lists every plaintext, never-deleted token).
- **P-H4. = S-L3** (CORS README wrong).
- **P-H5. Want-to-play submissions: no IP limit, no CAPTCHA, no DELETE, retained forever, throttle bypassable** — `sharing.py:86-119`. The cap is keyed on `(token, game_id, visitor_name)`; varying `visitor_name` (or leaving blank → bucket `None`) bypasses it. No `DELETE` endpoint exists. Visitor IP is not logged. **Fix:** per-IP rate limit; `DELETE /api/share/requests/{id}`; retention sweep; log IP for abuse.
- **P-H6. = S-C2** (export JSON/CSV/images unauthenticated; CSV includes private fields by default).

### Medium
- **P-M1. = S-H3** (expired tokens never deleted).
- **P-M2. No `robots.txt`, no `X-Robots-Tag`, no `noindex`** — search engines can index `/share.html?token=...` (exposing tokens to their logs/caches) and `/api/docs`. **Fix:** ship `frontend/robots.txt` with `Disallow: /`; add `X-Robots-Tag: noindex, nofollow`; add `<meta name="robots" content="noindex">` to both HTML files.
- **P-M3. = S-H2** (settings unauthenticated + values logged).
- **P-M4. = S-M4** (docs enabled).
- **P-M5. `delete_player` leaves the friend's name in `PlaySession.winner`** — `players.py:592-600`; `winner` is a free-text `String(255)`, not a FK (`models.py:79`); the rename handler propagates renames to it, confirming it's canonical. A "right to be forgotten" deletion leaves the name in session history. **Fix:** null out `winner` where it matches the deleted name; document what deletion removes.
- **P-M6. No factory-reset/wipe endpoint** — a user who abandons the app must manually delete `data/`. **Fix:** authenticated `DELETE /api/everything` (or a CLI script) + README "Uninstall" section.

### Low
- **P-L1.** No cookies (no HttpOnly/Secure/SameSite concerns) — but a consequence of no auth. Once auth is added, prefer an `HttpOnly; Secure; SameSite=Strict` session cookie.
- **P-L2.** Dead `fonts/fonts.css` references `fonts.gstatic.com` — CSP `font-src 'self'` would block it, but the `<link>` request would still leak visitor IPs. **Fix:** delete the file.
- **P-L3.** No retention for sessions/submissions/tokens — data accumulates indefinitely and ships in every backup.
- **P-L4.** BGG integration is well-behaved (HTTPS, rate-limited, no credentials stored) — but search terms are sent to BGG; consider a one-time UI notice.
- **P-L5.** `/health` is minimal — no leak.
- **P-L6. = frontend H1** (SW caches `/api/players/` friend data on shared devices with no eviction).

---

## 3. Performance

### High
- **PERF-H1. Stats dashboard runs ~30+ queries per request, cache invalidates on every play log** — `stats/dashboard.py:31-809`. The only cache is an ETag from `COUNT(games) + MAX(date_modified)` (`utils.py:144-148`); `_sync_last_played` (`sessions.py:19-41`) bumps `date_modified` on every session insert/update/delete, so the next dashboard hit re-runs all 30+ queries. `Cache-Control: no-cache` discourages proxy caching. **Fix:** TTL in-memory cache (e.g. `TTLCache(ttl=60)`) keyed on the ETag, invalidated from session-write paths; or materialize a `stats_snapshot` table.
- **PERF-H2. Missing index on `play_sessions.played_at`** — `models.py:74` (no `index=True`); only the composite `ix_play_sessions_game_played (game_id, played_at)` at `:87` exists, unusable for `played_at`-only predicates. Affects monthly/recent/DOW/52-week-heatmap/projection queries. **Fix:** `CREATE INDEX ix_play_sessions_played_at ON play_sessions(played_at)` in a migration.
- **PERF-H3. Missing indexes on non-leading FK of all 5 tag junction tables** — `models.py:164-211`. Every aggregation (`JOIN pivot ON pivot.*_id = tag.id`) scans the pivot. **Fix:** one migration adding 5 indexes (`category_id`, `mechanic_id`, `designer_id`, `publisher_id`, `label_id`).
- **PERF-H4. Missing index on `session_players.player_id`** — `models.py:103-108` (composite PK only). Every "given a player, find sessions" query scans the table. **Fix:** `CREATE INDEX ix_session_players_player_id ON session_players(player_id)`.
- **PERF-H5. N+1 in `GET /api/players/{id}/rankings`** — `players.py:281-346`: 2 queries per game inside a loop → 60 queries for 30 games. **Fix:** one `GROUP BY game_id, player_id` aggregation, group in Python.
- **PERF-H6. N+1 in BGG/CSV import loops** — `imports.py:57-61,71-73,209-210,241-248,308-310`: per-row `ilike`/`bgg_id` lookups (each a full scan). 1000-row import = 1000-2000 queries. **Fix:** pre-load `name`/`bgg_id` into Python `set`s once; `add_all` + single commit.
- **PERF-H7. Search uses `LIKE '%token%'` — no FTS5** — `crud.py:141-150`: up to 8 tokens × 4 `ilike('%...%')` subqueries = 32 full scans (leading `%` defeats B-tree). **Fix:** SQLite FTS5 virtual table over game names + tag names with triggers; or at minimum prefix matching (`name.ilike(token + '%')`) so `ix_games_name` is usable.
- **PERF-H8. `GET /api/players/{id}/sessions` unpaginated** — `players.py:546-589` loads every session ever. **Fix:** `limit`/`offset` + `X-Total-Count`; keyset on `(played_at DESC, id DESC)`.
- **PERF-H9. `GET /api/games` allows `limit=10000`** — `crud.py:120`. A 10k-row JSON response is multi-MB. **Fix:** cap at `le=500`; route bulk needs through `/export/json`.

### Medium
- **PERF-M1.** `get_player_stats` loads entire decided-session history into Python to compute a streak (`players.py:447-456`). **Fix:** compute streak in SQL via `ROW_NUMBER()`.
- **PERF-M2.** Full Elo replay on every session PATCH/DELETE (`sessions.py:204-241` → `elo_db.py:130-238`): deletes all `elo_history`, refetches every session, re-inserts per-session-per-player. **Fix:** skip recalc when only `notes`/`duration` change; move score-change recalc to `BackgroundTasks`.
- **PERF-M3.** `_get_historical_ratings` is O(S×P×H) — `elo_db.py:95-127` triple-nested loop. **Fix:** merge-style pass O(S+H) per player, or a `prev_session_id → rating` lookup.
- **PERF-M4.** `check_duplicate` loads ALL games then Python fuzzy-matches (`crud.py:270-305`) — called on every keystroke in add-game. **Fix:** SQL-filter candidates first (`lower(name) LIKE`/`bgg_id=`), fuzzy-match only those.
- **PERF-M5.** Dashboard runs duplicate DISTINCT game-id queries (DOW `:349-356`, 52-week `:378-386`). **Fix:** one `GROUP BY dow, game_id` query, aggregate both ways in Python (the monthly query at `:151-165` already does this correctly).
- **PERF-M6.** Goals N+1: 1-2 queries per goal (`goals.py:174-188`). **Fix:** batch by goal type (one `GROUP BY` per type).
- **PERF-M7.** `_attach_parent_name` = 3 queries per single-game GET (`_common.py:252-269`); hit by every share-link visitor. **Fix:** collapse into one query with scalar subqueries.
- **PERF-M8.** `recommend_game` loads all owned games into Python (`stats/recommend.py:33-58`); `suggest_games` similar (`games/recommend.py:134-257`). **Fix:** push basic scoring into SQL, `LIMIT 20`, refine in Python.
- **PERF-M9.** Missing PRAGMAs: `temp_store=MEMORY`, `mmap_size=268435456`, `optimize` (`database.py:12-21`). **Fix:** add to the pragma listener.
- **PERF-M10.** DB never VACUUMed; `elo_history` is delete-heavy (every recalc). **Fix:** weekly `VACUUM` + `wal_checkpoint(TRUNCATE)` via a script.
- **PERF-M11.** `add_bulk_session` = ~150 extra round-trips for 50 games (`sessions.py:247-281`). **Fix:** batched `SELECT ... WHERE game_id IN (...) GROUP BY` + one `UPDATE ... CASE`.
- **PERF-M12.** Player rename/avatar = 2 extra `COUNT` queries per write (`players.py:114-126,174-186,205-217`). **Fix:** use the already-maintained `player.games_played`, or one combined-subquery count.
- **PERF-M13.** Dashboard Python-sorts top-N lists (rating-vs-bgg `:511-524`, bvp/bvt/meu) instead of `ORDER BY ... LIMIT`. **Fix:** push sort+limit into SQL.
- **PERF-M14.** `collection_churn` wraps `coalesce(purchase_date, date_added)` in `strftime` — non-sargable (`dashboard.py:715-724`). **Fix:** pre-compute year bounds in Python, filter with range predicates.

### Low
- PERF-L1. `import_bgg_plays` calls `_sync_last_played` per game (`imports.py:267-269`) — batchable.
- PERF-L2. `want_to_play_requests.seen` unindexed but used in `ORDER BY` — fine while small.
- PERF-L3. `goals.game_id` FK unindexed (`models.py:137`) — cheap to add.
- PERF-L4. `GZipMiddleware` runs on every response — fine (`minimum_size=1000`).
- PERF-L5. `alembic upgrade head` on every start — milliseconds for 12 migrations; `render_as_batch=True` could slow a future large-table migration.
- PERF-L6. `QueuePool(size=5)` — fine for SQLite (WAL serializes writes); the image-cache `BoundedSemaphore(2)` prevents pool exhaustion.
- PERF-L7. `add_bulk_session` calls `apply_elo_for_new_session` even when no scores — it early-returns; readability nit.

**Well-optimized (no action):** `_load_tags`/`build_game_responses` batched (N+1-free list endpoints); `get_sessions` batched; `get_players` single-query counts; `winner_player` `lazy="joined"`; composite indexes `ix_games_status_*`; `_save_tags` bulk via `add_all`; `FileResponse` image serving with `Cache-Control`; pre-generated WebP thumbnails; image-cache semaphore; ETag MD5 `usedforsecurity=False`; `export_json` pre-loads session-players in one JOIN.

**Highest-leverage performance fix:** PERF-H2 + PERF-H3 + PERF-H4 (one migration, three index additions) fixes every aggregation query; then PERF-H1 (TTL cache) for perceived speed.

---

## 4. Frontend

### Critical
- **FE-C1. CSP-banned inline `onerror=` handlers break image fallbacks** — `ui-helpers.js:199-202` (`onerror="this.style.display='none'..."`) and `share.js:93` (`onerror="imgFallback(this)"`). Backend CSP is `script-src 'self' 'nonce-XXX'` with **no `'unsafe-inline'`** (`main.py:94`), so these are silently blocked. Under the configured CSP, every broken image shows a broken-image icon instead of the SVG placeholder; `imgFallback` is never called. Verified the build does not strip them. **Fix:** replace with `addEventListener('error', ...)` wired after `innerHTML` is set (in `buildGameCard`/`buildGameListItem` and share `buildCard`).

### High
- **FE-H1. SW API cache name never bumps on deploy + caches friend data with no eviction** — `sw.js:2` (`API_CACHE_NAME='cardboard-api-v1'`, static); `build.js:80` only rewrites the shell `'cardboard-v2'` → hashed, leaving `API_CACHE_NAME` untouched. `CACHEABLE_API_PREFIXES` includes `/api/players/` (`sw.js:18-23`). So: (a) the API cache survives every deploy (stale post-deploy); (b) on a shared device the SW caches the entire collection + player names + avatar URLs with no logout/eviction story (`caches.delete` is never called). **Fix:** hash `API_CACHE_NAME` too; add a logout/clear hook; at minimum drop `/api/players/` from cacheable prefixes.
- **FE-H2. = RC3** (share token in URL query → history/proxies).

### Medium
- **FE-M1. `isSafeUrl`/`safeImgUrl` allow `http://` but CSP `img-src` is `https:` only** — `ui-helpers.js:185-188`, `share.js:27-30` vs `main.py:98`. An `http://` image URL is accepted by the form but blocked by CSP, and combined with FE-C1 there's no fallback. **Fix:** drop `http://` from both helpers (update the test at `tests/ui-helpers.test.js:64`).
- **FE-M2. `heatIo` IntersectionObserver never disconnects** — `app.js:1648-1668`: local var, never `disconnect()`ed; the virtual-page recycler (`app.js:1699-1709`) removes cards without `unobserve`, so detached cards stay alive. ~17 observers for a 1000-game collection. **Fix:** hoist to module scope, `disconnect()` in `renderCollection`.
- **FE-M3. Stats `sectionObserver` never disconnects** — `ui.js:3412-3423`: same pattern; each stats re-render leaks an observer + its sections. **Fix:** hoist + `disconnect()` at the start of `buildStatsView`.
- **FE-M4. Global `mousedown` listener schedules `setTimeout(syncFilterActiveBar, 50)` on every click anywhere** — `app.js:3929`. Allocates a task on every mousedown even when the filter bar is hidden. **Fix:** scope to the filter panel, or guard with a visibility check.

### Low
- **FE-L1.** Dead `fonts/fonts.css` references `fonts.gstatic.com` (CSP would block the fetch but the `<link>` request still leaks IPs). Delete it.
- **FE-L2.** PWA manifest: single icon source for two sizes, no `purpose: "maskable"`, no `id`, no `screenshots`. **Fix:** add a maskable 512×512, `id: "/"`, screenshots.
- **FE-L3.** Rulebook `<a target="_blank">` lacks `rel="noopener noreferrer"` (`ui.js:622,638`). Same-origin so low risk, but match the footer's external links.
- **FE-L4.** Share-page modal has no focus trap / restore-focus (`share.js:281-294`) unlike the main app's `openModal`. **Fix:** reuse the `FOCUSABLE` trap from `ui.js:1905-1955`.
- **FE-L5.** Gallery lightbox `close()` can double-fire `popModalOpen()` (`ui.js:2039-2052`) — no `closed` guard. **Fix:** add `let closed = false` (as `openCompactQuickLog` does).

**Confirmed-safe:** `escapeHtml` used consistently (no XSS — traced the want-to-play flow end-to-end); `isSafeUrl` rejects `javascript:`; no `document.write`/`eval`/`new Function` in shipped code; no `postMessage`; no DOM clobbering; no CSRF (no auth); localStorage holds no secrets (only prefs + `wtp_<token>_<gameId>` flags); `theme-init.js` blocking `<script src>` (no FOUC, CSP-compliant); build hashes JS/CSS and patches `sw.js` shell cache + `SHELL_ASSETS` (verified `dist/sw.js`); debounced inputs (300ms search, 150ms autocomplete); collection virtualized via IntersectionObserver 60-card pages with DOM recycling.

> **Correction to a sub-claim:** the features agent reported `theme-init.js` missing from `SHELL_ASSETS`. That is true in *source* `sw.js:5-15`, but `build.js:83` patches it into `dist/sw.js`'s `SHELL_ASSETS` at build time. So the **shipped** service worker does precache `theme-init.js`. The manifest-bare points (no maskable/id/screenshots) stand.

---

## 5. Features & UX (gaps, not bugs)

### High-value gaps (12)
1. **Multi-user/household** — no `User` entity; two collectors can't separate collections/ratings/play-logs. Large change; gate behind a `MULTI_USER` flag or use a light "household members" model.
2. **Loan tracking is a stub** — `loaned_to`/`loaned_at` exist (`models.py:47-48`) but no due date, no reminder, no history, no `?loaned=true` filter, no overdue badge. Promote `Loan` to a table; add filter + notifications.
3. **Wishlist `target_price` is never compared to anything** — no price-fetching job, no OLGD integration, no drop alerts. Add a `PriceSnapshot` table + daily scheduler; reuse the notifications system.
4. **No notification/reminder system** beyond static `health_notifications` strings (`schemas.py:620`). Add a `Notification` model + Web Push + daily materialization job (overdue loans, goal progress, dormant favorites, price drops, streak risk). Highest-leverage trio with #2 and #3.
5. **Filters incomplete** — backend `GET /api/games` lacks `labels`, `designers`, `publishers`, `condition`, `loaned`, `priority`, `price_min/max`, `acquired_before/after`. The counts are already returned by `/api/collection/stats` but not wired to chips. Add chip rows + query params.
6. **No cooperative/team game support** — no `cooperative`/`outcome`/`scenario`/team fields. Co-op plays can't record "beat Scenario 3 on Hard"; team games have no structure.
7. **No custom fields** — fixed schema; adding a field needs a migration. Add `CustomField` + `GameCustomValue` tables.
8. **No i18n** — hardcoded `en`, `$`, `toLocaleDateString('en-CA')`. Adopt a tiny `t(key, vars)` + locale catalogs; add `UserSetting.locale`/`currency`.
9. **No API auth / personal access tokens / webhooks** — scripting requires living inside the trusted network. Add an `ApiKey` table + `Depends` + per-key rate limit; pairs with webhooks.
10. **No print/insurance PDF with values** — the existing PDF (`backup.py:289`) omits prices entirely. Add `?include_values=true` + a `@media print` stylesheet + per-game print sheet.
11. **Game-night planner is single-pick** — no sequence (opener+main+closer), no teach mode, no tight time-budget packing. Add `POST /api/games/plan-evening` returning an ordered timeline.
12. **No maintenance / missing-piece tracker** — no component inventory, no "needs sleeves" flag, no maintenance log. Add a `MaintenanceLog` table.

### Medium (13)
13. Search doesn't cover publishers/labels/edition/`user_notes`; no typo tolerance / "did you mean" (related to PERF-H7).
14. Stats miss `top_designer`/`top_publisher`; no `10x10_challenge` or `play_all_owned_year` goal types.
15. Expansions aren't grouped in the collection view; expansion plays don't roll up to base. Add `?group_by=base` + `rolled_up_session_count`.
16. Bulk ops lack export-selected, tag categories/mechanics, mark-played-today, bulk-merge.
17. Settings panel is thin vs. env vars (no BGG username/auto-sync, no currency/date-format/week-start selectors, no default share-link expiry).
18. PWA manifest bare (maskable icon, `id`, `screenshots`, `shortcuts`) — see FE-L2. *(theme-init.js sub-claim corrected above.)*
19. `condition` has no history (no timestamp). Add `ConditionHistory`.
20. No OLGD/Kickstarter/rulebook integrations beyond BGG (BoardGameAtlas has a clean JSON API + prices).
21. Onboarding lacks sample data + guided BGG-search walkthrough. Add `POST /api/demo/seed`.
22. No BGG XML re-export (round-trip) — Cardboard is a one-way sink. Add `export/bgg-xml` + `sessions/export/bgg-plays-xml`.
23. No `GameNight`/`Event` entity grouping parallel sessions at a meetup.
24. Market value / depreciation not tracked (would come from the `PriceSnapshot` table in #3).
25. Empty/error-state polish: stats has no Retry button (collection does); unknown routes return `index.html` 200 (wrong for SEO/link-sharing); no offline banner.

### Low (7)
26. No manual drag-sort. 27. No per-player mood/weight prefs for game night. 28. No `aria-live` announcements for filter/count changes. 29. Demo data (see #21). 30. Per-game print view (see #10). 31. Webhooks for scripted integrations (see #9). 32. Sleeves flag (covered by #12 maintenance `kind: "sleeve"`).

---

## Suggested remediation order

1. **RC1 (auth)** — one `Depends` collapses S-C1, S-C2, S-H1, S-H2, P-C1, P-C2, P-C5, P-H3, P-H6, P-M3, P-M4, and most of RC2/RC3's blast radius.
2. **RC2 (`GameShareResponse` whitelist)** — closes P-C3/P-C4.
3. **RC3 (token out of URL/logs)** + **P-M2 (robots/noindex)** + **S-M4 (docs off)** — quick privacy hardening.
4. **PERF-H2/H3/H4 (one migration, three indexes)** — biggest single DB win.
5. **PERF-H1 (TTL stats cache)** — biggest perceived-speed win.
6. **FE-C1 (inline `onerror`)** — user-visible bug, small fix.
7. **S-M2 (EXIF strip)** + **S-M7 (pin Pillow/certifi)** — one helper + requirements change.
8. **Features #4 → #2 → #3** — the notifications + loan-due-date + price-snapshot trio converts the app from a passive catalog into an active assistant and shares infrastructure.

The single most personally damaging exposure for a board-game app is **P-C5 (social graph + friend face photos)**; the single highest-leverage engineering fix is **RC1 (auth)**.
