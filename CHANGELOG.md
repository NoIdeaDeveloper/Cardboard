# Changelog

All notable changes to this project will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Cardboard uses [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

### Added

- **Offline session logging** — sessions logged while the device has no connectivity are queued in IndexedDB rather than silently failing. On the next `online` event (or page load while connected) the queue is replayed in order and the collection is refreshed. A toast confirms how many sessions were synced. The optimistic UI update is preserved while offline so the card play count reflects the queued session immediately.
- **Production asset pipeline** — `build.js` (esbuild) concatenates all seven JS files into a single content-hashed bundle (`bundle.[hash].js`) and minifies the CSS into a hashed file (`style.[hash].css`). The Dockerfile is now a two-stage build: a Node 20 Alpine stage runs the build and a Python Slim stage copies only the built `frontend/dist/` directory. Load times and transfer sizes are reduced by ~60–65%.

### Changed

- **Service worker cache name is now content-addressed** — the built `sw.js` derives its `CACHE_NAME` from the JS bundle hash (`cardboard-{hash}`), so every deploy creates a new cache name. Old service worker installs cannot serve stale JS or CSS because the asset filenames themselves change, eliminating the class of stale-cache bugs that required manual cache clearing.
- **Virtual scroll DOM recycling** — when the rendered card count exceeds 3× the page size (180 cards), the oldest page of 60 cards is removed from the DOM. The removed height is measured before deletion and applied as `padding-top` so the scroll position does not jump. Browsers with scroll-anchoring handle this transparently; the padding is a fallback for those that do not. This caps DOM size at roughly 120–180 nodes regardless of collection size.
- **`weekly_streak` renamed to `best_weekly_streak`** — the stats field held the best 52-week streak, not the current streak, so the name was misleading. Updated in `StatsResponse` schema, stats router, and frontend stats view.

### Fixed

- **Unhandled server exceptions leaked raw error details** — any exception not explicitly caught by a route handler fell through to FastAPI's default handler. A new `@app.exception_handler(Exception)` middleware catches these, logs the full traceback server-side, and returns `{"detail": "Internal server error"}` with a 500 status code, ensuring no internal state is exposed to the client.
- **`check-duplicate` endpoint unreachable (HTTP 422)** — `GET /api/games/check-duplicate` was registered after `GET /api/games/{game_id}`, so Starlette matched `check-duplicate` as a `game_id` parameter and failed int coercion with HTTP 422. The route is now defined before the catch-all so the server-side fuzzy / expansion / same-BGG-ID detection runs correctly.
- **"Add it again anyway?" prompt was a dead end** — when the duplicate-check modal was confirmed, `create_game` unconditionally rejected the request with HTTP 409. The endpoint now accepts an `allow_duplicate` query parameter (sent by the frontend after user confirmation) that bypasses the duplicate check.
- **`win_count` inconsistent between players list and detail** — the list endpoint counted any session whose `winner` string matched the player's name, while the detail stats counted only sessions the player was linked to as a participant. The list query now joins through `SessionPlayer` so both endpoints use the same definition.
- **Single-game GET always reported `session_count: 0`** — `_attach_parent_name` (used by `get_game` and `get_shared_game`) never populated `session_count`, while the list path did. The field is now populated consistently for all game response paths.
- **LIKE-wildcard collision in create dedupe check** — `Game.name.ilike(name)` treated `%` and `_` in titles as SQL wildcards. The check now uses `func.lower(Game.name) == name.lower()` for an exact case-insensitive match.
- **`Subquery` passed to `.in_()` emitted SAWarning** — `target_sessions` (a subquery) was passed directly to `SessionPlayer.session_id.in_()`. It is now passed as `.in_(target_sessions.select())`.
- **Theme flash (FOUC) on light-OS users with no saved choice** — the inline bootstrap script in `index.html` only applied light mode when `cardboard_theme === 'light'`, but `theme.js` follows OS preference when no manual choice exists. The bootstrap script now mirrors the OS-preference logic.
- **README advertised a non-existent 3D-scan feature** — removed the "3D scan upload (USDZ/GLB)" claim from the features list and replaced the `scans/` directory with the real `avatars/` directory in the documented data tree.
- **`DATABASE_URL` default mismatch in README** — the README listed `sqlite:////app/data/cardboard.db` (the Docker absolute path) as the default, but the code default is `sqlite:///./data/cardboard.db`. The README now matches the code.

---

## [0.4.0] — 2026-05-16

### Added

- **Best at X Players** — the stats endpoint now returns the optimal player count for each owned base game, ranked by average session rating. Only player counts with at least 2 logged sessions are considered, preventing one-off outliers from dominating the result.
- **Play projection** — the stats endpoint estimates when all currently unplayed games will be cleared at the current play rate, returning projected clear date, weeks to clear, and weekly average.
- **Collection churn dashboard** — the stats endpoint now tracks total games ever acquired (owned + sold + wishlist), total sold, churn rate (sold ÷ ever acquired), and games acquired or sold in the current calendar year.
- **Collection health notifications** — the stats endpoint returns up to four contextual nudges based on play percentage, collection diversity, neglected favorites, mechanic gaps, and streak status.
- **`GET /api/games/recently-played`** — new endpoint returning the most recently played owned base games (up to 50, default 8), ordered by `last_played` descending.
- **`GET /api/games/export/json`** — direct JSON download of the full collection (all statuses, all fields). Previously only available bundled inside the ZIP backup.
- **`GET /api/games/export/csv`** — direct CSV download of the full collection with all standard fields. Previously only available via the Settings panel's CSV export action.
- **Rating and date filters for `GET /api/games/`** — three new query parameters: `rating_min` and `rating_max` filter by user rating (1–10), and `added_month` (format `YYYY-MM`) restricts results to games added in a specific month.
- **Label, designer, and publisher frequency counts on collection stats** — `GET /api/collection/stats` now returns `label_counts`, `designer_counts`, and `publisher_counts` dicts (name → owned-game count, sorted by frequency), eliminating the need for client-side iteration over the full game list to build filter chips.
- **Service worker API cache size limit** — a `trimCache` helper caps the API response cache at 50 entries (oldest evicted first) to prevent unbounded growth on long-running installs.

### Fixed

- **Player rename corrupted win counts** — renaming a player updated the `Player` row but left all `PlaySession.winner` strings pointing to the old name. Every subsequent win-count query returned 0, silently erasing the player's entire win history. The rename endpoint now bulk-updates `PlaySession.winner` before committing.
- **BGG plays import created duplicates on reimport** — uploading the same BGG plays XML file twice doubled every session with no deduplication. The importer now counts existing sessions at the same `(game_id, played_at)` and skips that many entries, preserving correct behaviour for multi-play-on-same-day records.
- **Gallery file upload silently stopped after first error** — a failed upload inside the multi-file loop propagated uncaught, aborting all remaining files with no user feedback. Each file is now wrapped in a try/catch; a per-file error toast is shown and remaining uploads continue.
- **Image cache exhausted SQLite connection pool** — concurrent background image downloads could open more database connections than the pool allowed. Downloads are now limited to 2 concurrent tasks via a `BoundedSemaphore`.
- **Backup temp files leaked on server crash** — `FileResponse` background tasks that clean up temp ZIP files never ran if the server was killed mid-request. An `atexit` handler now cleans up any tracked temp files on shutdown.
- **CSV import row failure rolled back entire batch** — a single bad row would call `db.rollback()`, discarding all previously imported games in the same request. Each row is now wrapped in a savepoint so failures are isolated and the rest of the batch commits.
- **CSV import `NameError` in error reporting** — the `name` variable was assigned inside the `try` block, so if a row failed before that assignment the `except` clause itself raised `NameError`. `name` is now initialised to `""` before the block.
- **Tour retake button didn't restart the tour** — clicking "Retake Tour" cleared the done flags but didn't reset `_tourCheckDone`, so `startTour` immediately returned. The flag is now cleared before calling `startTour`.
- **`localStorage` access threw in private-browsing mode** — several `localStorage.getItem/setItem/removeItem` calls in the tour flow were not guarded, causing a `SecurityError` in browsers that block storage in private mode. All calls are now wrapped in try/catch.
- **Tour completion flag lost when tab closed immediately** — `endTour` fired-and-forgot the `API.setSetting` call, so closing the tab before the request completed left the server flag unset and the tour reappeared on the next visit from a different browser. `endTour` is now async and awaits the server call.
- **"Load more" applied stale page to a newer collection load** — if the user triggered a fresh collection load while a "load more" request was in flight, the stale page was appended to the new collection. The request ID is now captured before the fetch and checked before merging results.
- **`animateCountUp` crashed when target was `NaN`** — passing a non-numeric value (e.g. from a missing stat field) caused the animation frame loop to calculate `NaN` positions and corrupt the displayed number. An `isNaN` guard now exits early.
- **BGG rate-limiter IP dict pruned too infrequently** — stale IP entries were only removed when the dict exceeded 1 000 keys, allowing memory to grow unboundedly on public-facing servers. The threshold is now 50 keys.

---

## [0.3.0] — 2026-05-06

### Added

- **Backup restore preview** — selecting a backup ZIP now shows a preview dialog before committing: game count, session count, player count, media file count, status breakdown (owned / wishlist / sold), and the first 15 game names. A second confirmation is required before any data is replaced.
- **BGG search thumbnails** — game thumbnails from BoardGameGeek are now shown inline in the BGG search results list, making it easier to confirm the right game before importing.
- **Compact quick-log popover** — clicking "+ Log" on a game card now opens a small popover with date, rating, and duration fields rather than the full overlay form. A "More" button still opens the full form if needed.
- **Repeat last session button** — owned games with at least one prior session show a "↻ Repeat" button on the card hover actions. It logs a new session today, copying player list, duration, and rating from the most recent session.
- **Modal game navigation bar** — prev/next game navigation is now a dedicated bar between the cover image and the game content, showing the adjacent game's name as a label on each button. Previously the arrow buttons were overlaid on the cover image with no context. Keyboard ← / → navigation is unchanged.
- **Bulk shift-click selection** — holding Shift while clicking a game card in bulk-select mode now selects or deselects the entire range between the last clicked card and the current one.
- **Select All in bulk toolbar** — a "Select All / Deselect All" toggle button appears in the bulk action toolbar.
- **Undo for bulk delete** — a toast with an undo action appears after a bulk delete, allowing the removed games to be recreated.
- **Undo for quick status change** — moving a game to "Owned" via the card's quick-action button now shows an undo toast.
- **Undo for session delete** — deleting a session from the game modal now shows an undo toast that restores the session via the API.
- **Undo for player delete** — removing a player from the players modal now shows an undo toast that re-creates the player.
- **Optimistic UI for status changes and session logging** — quick status changes and session logs are reflected in the collection immediately rather than waiting for the server round-trip; changes are rolled back if the request fails.
- **Stats sections drag-to-reorder** — stats sections can be dragged into a custom order; the new order is persisted to `localStorage`.
- **Stats prefetch on nav hover** — hovering over the Stats nav button begins fetching stats in the background so the view renders faster when navigated to.
- **Pause mode** — a "Pause" button in the footer freezes streak and heat tracking for vacations or breaks. A banner is shown while paused with a one-click Resume button. State is persisted to `localStorage` and synced to server settings.
- **Filter toggle button** — a funnel icon button next to the search bar opens and closes the filter panel. A badge shows the count of active filters when the panel is closed.
- **Filter summary bar** — the filter panel now shows a summary line with owned / wishlist / sold counts while open.
- **Search autocomplete** — typing in the collection search box shows a dropdown of matching game names from the local collection; keyboard navigation (↑ ↓ Enter Esc) is supported.
- **Tooltip system for toolbar buttons** — icon buttons in the collection toolbar use CSS `::after` tooltips via `data-tooltip`, replacing `title` attributes.
- **Keyboard shortcut `/` to focus search** — pressing `/` anywhere on the collection view focuses the search input.
- **Sticky close button in modals (mobile)** — a floating Close button sticks to the bottom of the game detail modal and players modal on mobile, so users don't need to scroll back to the top to dismiss.
- **Mobile form wizard for Add Game** — on screens ≤ 768 px the add-game form is split into four numbered steps (Basic Info → Players & Time → Tags & Labels → Ownership) with Back / Next buttons and step indicators. The full form remains visible on desktop.
- **Game night dismiss button** — individual game suggestions in the Game Night modal can now be dismissed with an × button; dismissed games animate out and a "Reset & re-roll" option appears when all suggestions are dismissed.
- **Server-side stats aggregations** — the stats endpoint now precomputes and returns top mechanics (top 10 by count across owned games), dormant games (owned base games not played in 12+ months), recently added (top 5 owned/sold base games by date added), never-played list (owned base games with no sessions), neglected favorite (most-played owned game inactive for 6+ months), rating-vs-BGG delta (top 8 by absolute difference), collection health score, added-by-month for owned games only, daily and weekly play streaks, top wishlist game, and unplayed count matching the top mechanic. These replace equivalent client-side passes over the full game list.
- **Mechanic and category frequency counts on collection stats** — `GET /api/collection/stats` now returns `mechanic_counts` and `category_counts` dicts (name → game count, sorted by frequency) so the collection filter chips no longer need to iterate all loaded games client-side.
- **Zero-filled player stats month series** — `GET /api/players/{id}/stats` now returns `sessions_by_month` and `win_rate_by_month` pre-filled for the trailing 12 calendar months, inserting zero-count entries for months with no activity. Bar charts render a full 12-column grid without client-side alignment.
- **Game session summary endpoint** — new `GET /api/games/{id}/session-summary` returns `{ session_count, total_minutes }` for a game. Used internally for milestone checks; avoids fetching every session object just to count them.
- **Player sessions drill-down** — leaderboard entries in the player profile are now clickable, opening a modal list of all sessions for that player with cover thumbnail, game name, date, duration, players, scores, and notes. Backed by a new `GET /api/players/{id}/sessions` endpoint; returns an empty list when no sessions are found.
- **Skip-to-content link** — a visually hidden `<a href="#main-content">` link appears on focus, letting keyboard users jump past the header without tabbing through every nav element.
- **Screen reader heading for collection view** — a visually hidden `<h1>My Board Game Collection</h1>` gives screen reader users a clear landmark when landing on the collection tab.
- **Focus trap in all modals** — Tab and Shift+Tab are now contained within open modals; focus returns to the trigger element on close. Previously only the game detail modal had this behaviour; it now applies to the players modal and game night modal as well.
- **ARIA semantics on interactive game elements** — game grid cards and list items both receive `role="button"` and `aria-label="View details for {name}"`. Bulk-select checkboxes receive `role="checkbox"`, `aria-checked`, and `aria-label`.
- **Escape key on game night modal** — pressing Escape now closes the game night modal, consistent with all other modals in the app.

### Changed

- **Game night re-roll** — the suggest button now fetches a fresh set of suggestions rather than replacing the rendered list in-place, and a "🔄 Re-roll with new games" link appears when some suggestions have been dismissed.
- **Sort direction uses `data-tooltip`** — the sort-direction button tooltip now updates via `data-tooltip` (CSS tooltip system) instead of `title`.
- **Stats page no longer fetches the full game list** — the stats view previously loaded up to 5 000 games in parallel with the stats request, then iterated the full array for every aggregation. All heavy computations are now server-side; the extra `GET /api/games/` call on stats load has been removed.
- **Player session covers use primary image over BGG thumbnail** — the player sessions drill-down modal now prefers the locally cached `image_url` when available and falls back to `thumbnail_url` (the small BGG thumbnail) only when the primary image is absent, showing higher-quality covers in the session history list.
- **Real-time inline validation on the add-game form** — the name, min/max players, min/max playtime, and difficulty fields now show errors while typing, not only on submit. A green border appears when the value becomes valid. All `.valid` markers are cleared when the form resets after a successful save.
- **Status badge icons** — the Wishlist badge now shows a `★` prefix and the Sold badge shows a `✓` prefix via CSS `::before`, improving scannability in the card grid and list view.
- **Focus indicator enhanced** — `:focus-visible` now adds a 4 px `box-shadow` halo alongside the existing outline, making keyboard focus position much easier to track.
- **`prefers-reduced-motion` support** — all CSS animations and transitions are suppressed for users who have enabled reduced motion in their OS accessibility settings.
- **`prefers-contrast: more` support** — borders are strengthened and muted text colours are elevated to improve legibility when the user has enabled high-contrast mode in their OS.
- **Mobile touch targets** — icon buttons expand to a 44 × 44 px minimum hit area on screens ≤ 600 px, meeting the WCAG 2.1 touch target guideline while keeping the visual size unchanged.
- **Modals use dynamic viewport height** — `max-height` switched from `90vh`/`92vh` to `90dvh`/`92dvh` so modals are not clipped when the mobile browser's address bar collapses or expands.
- **Mobile modal safe-area support** — the bottom-sheet modal now pads past the device safe-area inset so content is not obscured by the iPhone home indicator or a landscape notch; the hero image is reduced to 160 px on small screens to maximise visible content.
- **Mobile stats page scaling** — on screens ≤ 480 px the stats title, section padding, and stat card sizes are all scaled down to fit comfortably without horizontal overflow.
- **Card hover actions always visible on touch devices** — the quick-action buttons (View, + Log, Own It) that appear on hover are now always visible on touch-only devices via `@media (hover: none)`.
- **Light theme text contrast** — `--text-3` in the light theme darkened from `#6a6a72` to `#50505a`, raising the contrast ratio from ~3.8:1 to ~5.1:1 (passes WCAG AA for normal text).
- **Recently-played shelf fade edges** — a CSS `mask-image` gradient fades both ends of the horizontal scroll strip to indicate overflowing content.
- **Stat card hover feedback** — all stat dashboard cards now lift and show an accent glow on hover. Previously only cards with drill-down behaviour had this effect.
- **Gallery image alt text** — gallery thumbnails and lightbox images now use the image's caption as `alt` text when one exists, falling back to "Photo N of {game name}" instead of an empty string.
- **"Log Session" button style** — the "+ Log Session" toggle in the game modal's Play History section now uses the secondary button style, matching the Refresh BGG and Share buttons in the same modal.

### Fixed

- **Corrupt backup returned 500 instead of 422** — `PRAGMA integrity_check` on a non-SQLite file raises `sqlite3.DatabaseError: file is not a database`, which was not caught and fell through to the generic 500 handler. The exception is now caught alongside the existing `HTTPException` path and re-raised as a 422 with a clear message.
- **Repeat session failed when previous session had no rating** — `session_rating: last.session_rating || 0` sent `0` to the API, which rejects ratings below 1. The value is now `null` when the source session was unrated, matching how the quick-log and log-session forms omit the field. The same fix applies to the undo-restore path for deleted sessions.
- **Layout width shifted when switching filter tabs** — switching between tabs with different numbers of games caused the 6 px custom scrollbar to appear or disappear, shifting all content horizontally. `scrollbar-gutter: stable` is now set on `html`, reserving the gutter space permanently so the layout never reflows. This also prevents the same shift when modals open and set `overflow: hidden` on the body.
- **Add Game submit button hidden on desktop after form wizard init** — `_initFormWizard` called `showStep(0)` unconditionally, setting `submitBtn.style.display = 'none'` as an inline style that overrode the CSS rule on desktop, making the form impossible to submit without a mobile breakpoint.
- **Restore same backup file unresponsive after canceling preview** — the restore file input was never cleared after the preview dialog was dismissed, so selecting the same file a second time did not fire the `change` event.
- **Backup integrity check result not inspected** — the `preview_restore` endpoint ran `PRAGMA integrity_check` but discarded the result; a corrupt backup database would silently pass validation and return garbage counts. The result is now verified and a 422 is returned on failure.
- **Unnecessary API call on every page load from pause mode sync** — `_syncPauseUI()` was called at startup and unconditionally pushed the pause-mode value to the server settings endpoint, even when the value had not changed. Server sync is now only performed when the user actually toggles the setting.
- **Goals game-select dropdown always empty** — `buildStatsView` was refactored to receive an empty game list, but the goals section's "Game" dropdown still built its `<option>` elements from that parameter. Selecting the "Game Sessions" goal type showed an empty picker with no games, and saving raised "Please select a game" regardless. The dropdown now reads from the loaded game state directly.
- **Recently Added included wishlist games and expansions** — the server query had no status or parent-game filter, so wishlist entries and expansion packs could appear at the top of the "Recently Added" stats section. The query now restricts to owned and sold base games only.
- **Shelf of Shame included expansion games** — the never-played query lacked the `parent_game_id IS NULL` guard present on every other ownership-scoped query in the stats endpoint (dormant, health score, top mechanics, etc.). Expansions that had never been played individually were incorrectly listed alongside base games.
- **Event propagation on modal close and back buttons** — clicking the close (×) or back (‹) buttons in modals previously bubbled the event to parent listeners, which could trigger accidental navigation or re-open the modal. `stopPropagation()` is now called before invoking the handler. The fix now covers all modals: players, shortcuts, game night, and share (previously only the game detail modal was patched).
- **BGG ID lost on add-game form submission** — selecting a game from BGG search populated the hidden `bgg_id` field via `_prefillAddGameForm`, but the submit handler never read it into the API payload. Games added via BGG lookup were stored without a BGG ID, breaking "Refresh from BGG", BGG links, and duplicate detection.
- **Difficulty field accepted non-numeric input silently** — `parseFloat("abc")` returns `NaN`, and `NaN < 1` evaluates to `false`, so arbitrary text passed client-side validation without an error message. An `isNaN` guard is now included alongside the range check.
- **Undo delete restored game with wrong creation date** — the undo handler stripped `date_added` from the restore payload alongside internal fields, causing the re-created game to receive the current timestamp instead of its original creation date.
- **Crash on player sessions endpoint** — `GET /api/players/{id}/sessions` always returned 500 because the query referenced `models.Game.title`, which does not exist (the column is `name`). The query and result mapping are now corrected.
- **XSS in static HTML export** — game names or descriptions containing `</script>` could break out of the inline `<script>` block in the exported HTML file. `json.dumps()` does not escape `</` by default; the serialised payload is now post-processed to replace `</` with `<\/` before embedding.
- **Restore endpoint loaded entire backup into RAM** — `await file.read()` allocated a buffer equal to the full upload size before writing to disk, risking OOM on large backups. The upload is now streamed to a temp file in 64 KB chunks with the 500 MB limit enforced incrementally.
- **BGG rate-limiter dict grew without bound** — per-IP timestamp lists were pruned on each request but dict keys (IP addresses) were never removed. On servers with many unique IPs the dict accumulated indefinitely. Empty entries are now deleted whenever the dict exceeds 1 000 keys.
- **Settings endpoint accepted unbounded value length** — `PUT /api/settings/{key}` had no length constraint on the value field. The `SettingValue` schema now enforces `max_length=10 000`.
- **Theme-flash script threw in private-browsing mode** — the inline `<script>` in `<head>` of `index.html` and `share.html` called `localStorage.getItem()` without a try/catch. Browsers that block storage access in private mode throw a `SecurityError` at that point, preventing all subsequent scripts from loading. The call is now wrapped in `try { … } catch (_) {}`.
- **Escape keydown listener accumulated across stats reloads** — `wireStatsView` added a `document.addEventListener('keydown', …)` handler on every call with no cleanup, stacking a new listener on each stats view render. The handler is now registered with an `AbortController` signal; each `wireStatsView` call aborts the previous controller before creating a new one.
- **Missing Content-Security-Policy header** — the security-headers middleware set `X-Content-Type-Options`, `X-Frame-Options`, and `Referrer-Policy` but omitted `Content-Security-Policy`. A CSP is now added restricting resources to same-origin by default, allowing `data:` and `blob:` image sources, and blocking `object-src` entirely.

---

## [0.2.7] — 2026-04-29

### Fixed

- **PDF export missing cover images** — `load_cover` skipped any game where `image_ext` is `NULL` in the database. These are records cached before the `image_ext` column was introduced whose image files exist on disk but whose extension was never backfilled. The image-serving endpoint already handles this with a glob fallback; the PDF exporter now mirrors that same logic.
- **PDF descriptions truncated** — game descriptions were limited to 700 characters in the exported PDF. The truncation has been removed so full descriptions are included.

---

## [0.2.6] — 2026-04-29

### Added

- **PDF export for collection sharing** — the Share modal's export button now generates a downloadable PDF of your collection via a new `GET /api/games/export/pdf` endpoint backed by reportlab. Each entry includes the cover image (proportionally scaled), title, full description, difficulty, playtime, and player count. Colours align with the app's warm palette; headings use Times-Bold to approximate the display font.

### Changed

- **Collection export replaced: PDF instead of static HTML** — the static HTML export previously accessible from the Share modal has been replaced with the PDF export.

### Fixed

- **Stats drill-down modals always showed "No sessions logged for this period"** — click handlers for every bar chart (sessions by month, heatmap cells, day-of-week columns, rating buckets) looked up games using `state.games`, which is the paginated collection view capped at 200 entries. Any played game beyond the first page was not found and filtered out. Handlers now use the full `allGames` array (up to 5 000 games, no filters) already fetched by `loadStats`.

---

## [0.2.5] — 2026-04-28

### Fixed

- **Stats page stuck on endless loading spinner** — three bugs combined to prevent the Stats tab from ever rendering: (1) the `most_played` query joined `Game` to itself instead of to `PlaySession`, causing a 500 error on any database with logged sessions; (2) `GET /api/games/` capped `limit` at 2 000, but `loadStats` requests `limit=5000`, so FastAPI returned 422 before the query ran; (3) the error state rendered inside the same `loading-spinner` container as the spinner, making both failure modes visually indistinguishable from an infinite load.
- **"Cooling Off" stats section never rendered** — `show_cooling_off` and the `cooling_off` key were present in `SECTION_DEFAULTS` inside `buildStatsView` but absent from `STATS_PREFS_DEFAULTS` in `app.js`. Because `loadStatsPrefs` normalises `section_order` against `STATS_PREFS_DEFAULTS`, the section was silently dropped before the ordered HTML was assembled and never appeared regardless of the toggle setting.

---

## [0.2.4] — 2026-04-25

### Added

- **Default SVG avatar presets** — eight built-in SVG avatars (Meeple, Dice, Robot, Crown, Cat, Fox, Bear, Knight) are available in the player profile panel alongside the custom photo upload. Hover the avatar circle and click the person icon to open a picker grid; the active selection is highlighted. Choosing a preset clears any custom upload, and uploading a custom photo clears any active preset. Preset avatars appear everywhere player avatars are rendered.
- **Persistent collection filters** — the active search text, never-played toggle, player count, play-time cap, mechanic chips, category chips, and location filter are now saved to localStorage and restored on page reload alongside the existing sort and view-mode preferences. The active-filter indicator bar is shown immediately on load if any filter was active when the page was last closed.
- **Search across designers, mechanics, and categories** — collection search now matches against a game's designers, mechanics, and categories in addition to its name. Multi-word queries are tokenised (stop words shorter than 2 characters are dropped) and each token must match somewhere across all four fields, so "deck building" finds games with that mechanic regardless of name, and "hargrave" finds all games by Elizabeth Hargrave.
- **"Cooling Off" stats section** — a new section on the Stats page lists owned base games last played between 3 months and 1 year ago, surfacing games that are starting to cool off before they go fully dormant. The section appears between "Shelf of Shame" and "Dormant Games" and can be toggled and reordered like any other stats section.
- **Player win-rate trend and recent form** — the player profile panel now shows three new data points: a W/L pip row for the last 10 decided sessions (newest-first), a current streak badge for 2+ consecutive wins or losses, and a monthly win-rate bar chart for the last 12 months. All three are computed server-side.

### Changed

- **Native game sharing** — the custom in-modal share panel with WhatsApp/Signal-specific buttons has been replaced by a single action that uses the Web Share API where available, falling back to clipboard copy. The formatted message includes the game name, players/playtime, a 280-character truncated description, and the image URL.
- **Head-to-head rivalry queries optimised** — the per-co-player W/L calculation was an N+1 loop (two scalar subqueries per co-player). It is now a single aggregated query using conditional sums, reducing database round-trips from `1 + 2N` to `2` for a player with N co-players.
- **Unique mechanics count via database** — the count of distinct mechanics is now computed at the database level via a join-and-distinct query, replacing the previous approach of loading all games into Python and parsing stored JSON arrays.

### Fixed

- **Share page returned 200 for hidden games** — games marked "hidden from share" now return 404 on the sharing routes. Want-to-play submissions for hidden games are also blocked.
- **Player sessions-by-month chart always showed equal-height bars** — `.player-sessions-bar` had `flex: 1` set, causing the flex algorithm to ignore the `height: ${pct}%` inline style and render every bar at the same height. Bars now use pixel heights calculated relative to the fixed chart area, with `justify-content: flex-end` so they grow from the bottom correctly.
- **Session count missing from game responses** — `session_count` is now included in `GameResponse` and populated via a grouped `PlaySession` count query, enabling per-game play counts without a separate request.
- **Share page and static export image fallback** — the share view and static HTML export now handle missing or server-relative image URLs gracefully, substituting a placeholder SVG instead of showing a broken image.

---

## [0.2.3] — 2026-04-24

### Added

- **Player profile photos** — upload a custom photo for any player via the player profile panel (click a player's name to open it, then hover the avatar circle and click the camera icon). Photos are stored in `data/avatars/` and replace the coloured-initials circle everywhere a player avatar appears: the player list, player profile panel, co-player rows in the profile, quick-log player chips, and the stats leaderboard. Existing photos can be removed with the × button that appears on hover. Profile photos are included in ZIP backups and restored automatically.

### Changed

- **Game-night suggestion and similar-games scoring overhauled** — suggestions now incorporate per-session average ratings alongside user ratings, with a priority-ordered quality signal (user rating → session average → BGG rating). A discovery bonus scales with BGG rating, explicitly low user ratings are penalised, and a diversity cap limits results to at most 3 games per difficulty band. Similar-games scoring gains IDF-weighted category and mechanic matching with normalisation, player-count Jaccard overlap, and graduated difficulty scoring. Tests extended to cover session ratings, BGG fallback, penalty logic, and IDF-based ranking.

### Fixed

- **Static HTML export had no CSS and showed no games** — two bugs combined: (1) `style.css` was referenced as `/css/style.css`, an absolute path that browsers reject when opening a local file; (2) `window.__STATIC_COLLECTION__` was injected just before `</body>`, after the inline script that reads it, so the variable was always `null` at initialisation. The export now inlines the full CSS as a `<style>` block and appends the data variable to the same script block that reads it, with the logo embedded as a base64 data URL so no network requests are needed.
- **Cost/hr on game modal inflated when sessions lacked recorded duration** — sessions without a logged duration contributed 0 minutes to the total, understating hours played and inflating the $/hr figure. Unrecorded sessions now use the game's `min_playtime` as an estimate; if `min_playtime` is unset, the average of sessions that do have duration is used. Sessions with no recorded or estimated duration continue to suppress the cost/hr display.
- **Coach tour could start multiple times on concurrent load paths** — `maybeStartTour` had no guard against concurrent invocations; each could independently pass the localStorage check and fire the first-visit tour. An in-progress flag (`_tourCheckDone`) is now set before the async settings fetch and on tour completion, preventing duplicate tours and redundant server round-trips.
- **Opening a game from certain contexts failed silently** — `onOpenGame` was called with a raw numeric ID instead of the resolved game object. If the ID didn't match a loaded game the callback received `undefined` with no visible error. The call site now looks up the full game object and skips the callback if no match is found.
- **Heatmap scroll position incorrect on first render** — the 52-week activity heatmap's scroll-to-current-week logic ran synchronously after the element was inserted, reading `scrollWidth = 0` because layout had not yet completed. The scroll is now deferred to the next animation frame.
- **IntersectionObserver fired immediately with `isIntersecting: false`** — observer targets were registered before elements were appended to the document, so the initial callback always saw them as out-of-view. Observe calls are now deferred to the next animation frame, after elements are in the DOM.

---

## [0.2.2] — 2026-04-22

### Fixed

- **Restore silently loaded no data after success** — after `os.replace` atomically swapped the database file, SQLAlchemy's connection pool still held open connections to the previous file descriptor (SQLite WAL keeps the old inode alive). All subsequent reads returned the pre-restore collection. `engine.dispose()` is now called immediately after the file swap, flushing all pooled connections so the next request opens a fresh connection against the restored database.
- **Star ratings only highlighted the hovered star** — hovering over star 3 (for example) lit up only that star instead of stars 1–3. The quick-log popup, the log-session form, and the session-edit form all lacked `mouseover`/`mouseleave` handlers; only click was wired. Each picker now highlights all stars up to the hovered value on hover, and restores the committed selection on mouse-leave.
- **Welcome tagline and empty-tab messages not centred** — the `#empty-state` container is a flex column, but the JS was toggling it with `display: block`, disabling `align-items: center` and leaving the tagline left-aligned. Changed to `display: flex`. The "No owned/wishlist/sold games yet" messages were injected as a child of the `games-grid` CSS grid and only occupied one narrow column cell; added `grid-column: 1 / -1` to `.empty-search-state` so it spans the full grid width.

---

## [0.2.1] — 2026-04-22

### Added

- **Stats section info popovers** — every stats section now has an ⓘ button that reveals an explanatory popover. Only one popover is open at a time; pressing Escape closes the active one.
- **Goals & Challenges breakdown** — the Goals info popover now lists all supported goal types (unique games, play count, total hours, win rate, categories covered, sessions per month) with descriptions.

### Fixed

- **Restore failed: [errno 18] invalid cross-device link** — the restore endpoint created its temporary ZIP in `/tmp`, which is a different filesystem from `/app/data` inside Docker. `os.replace` requires both paths to be on the same filesystem. The temp file is now written directly into `DATA_DIR`, making the rename atomic.
- **ZIP path traversal in restore** — a crafted backup could contain entries like `images/../../../etc/passwd` that escaped `DATA_DIR` when extracted. The restore endpoint now resolves every destination path with `os.realpath` and rejects anything that does not start within `DATA_DIR`.
- **"Welcome to Cardboard" shown on non-empty filtered tabs** — switching to the Owned, Wishlist, or Sold tab when that tab had zero games incorrectly displayed the new-user welcome screen. The check now distinguishes a truly empty collection (all tabs, no games, no filters) from an empty filtered view and shows a tab-specific message instead.
- **Theme toggle flicker** — element-level CSS transitions fired simultaneously with the View Transitions API cross-fade, causing buttons and backgrounds to double-animate. A `html.view-transitioning` class now suppresses all element transitions for the duration of the page-level overlay.
- **Rating Delta section not toggling with Ratings** — hiding the Ratings section in the stats panel did not hide the Rating Delta subsection below it. Both sections are now toggled together.
- **BGG import used wrong game name** — the BGG XML export uses `sortindex="1"` to mark the canonical title (e.g. "The Castles of Burgundy" vs "Castles of Burgundy, The"). The importer now prefers the `sortindex="1"` element and falls back to the generic `<name>` element, matching BGG's own display behaviour.
- **Shortcuts panel used inconsistent UI** — the keyboard shortcuts overlay used a bespoke modal with opacity-only animation. It now uses the same `openModal`/`closeModal` system as all other panels (spring scale + blur backdrop, focus trap, scroll lock, Escape to close).
- **"Import from BGG" on empty homepage showed file picker immediately** — clicking the button opened a file picker with no context. It now navigates to the Stats page, opens the Settings panel, scrolls the BGG import row into view, and flashes a highlight so the user understands where to proceed.
- **Exception chain lost when saving tags** — `_save_tags` wrapped errors in a generic HTTP 500 without `from e`, discarding the original traceback. The chain is now preserved for easier production debugging.

### Changed

- **Settings panel reorganised** — the Stats settings panel has been reduced from six action rows to three clearer ones: **Backup & Restore** (download ZIP + restore from ZIP), **Import** (BGG Collection, BGG Plays, CSV — all in one row), and **Export Data** (JSON + CSV with field picker). The "Share collection" and "Static HTML Export" rows have been removed since both are already accessible from the footer's Share modal.
- **Difficulty precision** — game difficulty now accepts and displays values to two decimal places (e.g. 2.75) instead of one.

### Tests

- Added 18 tests in `backend/tests/test_backup_restore.py` covering the full backup/restore lifecycle with a real file-based SQLite fixture: valid backup format, SQLite magic header, images included, roundtrip data integrity, gallery and instructions extraction, double roundtrip, and all error cases (missing `cardboard.db`, corrupt database, non-ZIP file, empty ZIP, path traversal, unknown subdirs).

---

## [0.2.0] — 2026-04-22

### Added

- **Static HTML export** — download a self-contained `.html` file of your collection (Settings → Stats backup panel, or Share → Static HTML Export). The file embeds all game data and cached cover images as base64, so recipients can open it in any browser with no server, no account, and no network access required. Only games marked "hidden from share" are excluded, consistent with the live share link behaviour.
- **Smooth theme transitions** — switching between dark and light mode now animates instead of snapping. Chrome and Edge use the native View Transitions API for a full-page cross-fade; Safari and Firefox use an opacity fade fallback. Both paths take ~360–380 ms.

### Fixed

- **Backup restore crash** — importing a `.zip` backup via the Settings restore button threw `TypeError: validate_file_extension() missing 1 required positional argument: 'detail'`, making restores impossible. The missing argument has been added.
- **Collection Health score wrong for empty collections** — with no rated games the Avg Rating factor defaulted to 5/10 internally, producing a misleading score of 20/100 and a half-filled bar graph. It now correctly defaults to 0, so a brand-new empty collection shows 0/100.
- **Footer links pointed to old repository** — the GitHub and Report Bug links in the app footer still referenced `cardboard-v2`. Both now point to the correct `cardboard` repository, with the bug report link deep-linking directly to the bug report issue template.

### Changed

- **Collection Health grade label** — the lowest tier (0–39) has been renamed from "Needs Attention" to "Just Starting", and the score-key legend in the info popover updated to match. The previous label was alarming for new users who haven't yet added or played any games.
- **Light mode color palette** — the warm beige (`#dbd4ca`) palette has been replaced with a cool neutral gray (`#eaeaee` base). Text contrast is improved and button/input outlines are sharper against the gray backgrounds.
- **Docker defaults baked into image** — `DATABASE_URL` and `FRONTEND_PATH` are now set as `ENV` defaults in the Dockerfile. Users no longer need to define them in `docker-compose.yml` or `docker run` commands; the correct values for the container's layout are applied automatically. Both can still be overridden if needed.

---

## [0.1.0] — 2026-04-22

Initial public release.

### Added

- Collection management — add, edit, bulk-edit, and delete games with detailed fields (players, playtime, difficulty, rating, labels, categories, mechanics, designers, publishers, condition, purchase info, storage location)
- BoardGameGeek integration — search and auto-fill metadata; parent/expansion linking
- Play tracking — log sessions with date, duration, players, winner, notes, and per-session rating; quick-log overlay; solo mode
- Player profiles — per-player stats, win rates, top games, co-player leaderboard with head-to-head records
- Stats dashboard — totals, most-played, player leaderboard, rating distribution, added/sessions-by-month charts, 52-week activity heatmap, day-of-week breakdown, shelf of shame, collection value
- Goals & challenges — progress-tracked goals with auto-complete detection
- Media — cover images, multi-image photo gallery with captions, instruction PDF upload with inline viewer, 3D scan support (USDZ/GLB) with AR and in-browser viewing
- Sharing — token-based read-only share links with optional expiry; visitors can submit "want to play" requests
- Game night — suggestion engine filtered by player count and playtime; random "Pick for Me" selector
- CSV import
- Dark and light theme, keyboard shortcuts overlay, milestone confetti, PWA support
- Single Docker container deployment; Unraid instructions included
- Pre-built images published to GHCR on version tags (`ghcr.io/noideadeveloper/cardboard`)

[Unreleased]: https://github.com/NoIdeaDeveloper/cardboard/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/NoIdeaDeveloper/cardboard/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/NoIdeaDeveloper/cardboard/compare/v0.2.7...v0.3.0
[0.2.7]: https://github.com/NoIdeaDeveloper/cardboard/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/NoIdeaDeveloper/cardboard/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/NoIdeaDeveloper/cardboard/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/NoIdeaDeveloper/cardboard/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/NoIdeaDeveloper/cardboard/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/NoIdeaDeveloper/cardboard/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/NoIdeaDeveloper/cardboard/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/NoIdeaDeveloper/cardboard/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/NoIdeaDeveloper/cardboard/releases/tag/v0.1.0
