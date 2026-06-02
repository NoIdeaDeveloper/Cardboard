# Cardboard

A self-hosted board game collection tracker. FastAPI + vanilla JS frontend in a single Docker container, backed by SQLite. No external dependencies beyond optional BoardGameGeek lookups.

<details>
<summary>Screenshots</summary>
<br>
<table>
<tr>
<td width="33%" align="center"><a href="docs/screenshots/collection.png"><img src="docs/screenshots/collection.png" alt="Collection"></a></td>
<td width="33%" align="center"><a href="docs/screenshots/add-game.png"><img src="docs/screenshots/add-game.png" alt="Add a Game"></a></td>
<td width="33%" align="center"><a href="docs/screenshots/stats.png"><img src="docs/screenshots/stats.png" alt="Stats"></a></td>
</tr>
<tr>
<td align="center"><b>Collection</b><br><sub>Browse, search, and filter your library</sub></td>
<td align="center"><b>Add a Game</b><br><sub>Search BGG or enter details manually</sub></td>
<td align="center"><b>Stats</b><br><sub>Insights, charts, and play activity</sub></td>
</tr>
</table>
</details>

## Quick Start

### Docker Compose (recommended)

```bash
git clone https://github.com/NoIdeaDeveloper/cardboard.git cardboard
cd cardboard
cp .env.example .env          # optional — edit to change port, data path, etc.
docker compose up -d
```

Open `http://localhost:8000`. Data is persisted to `./data/` on the host.

**Update** (pulls the latest published release):

```bash
docker compose pull && docker compose up -d
```

### Pre-built image (Docker Hub / GHCR)

A pre-built image is published to the GitHub Container Registry on every version tag:

```
ghcr.io/noideadeveloper/cardboard:latest
```

Pull and run without cloning the repo:

```bash
docker run -d \
  --name cardboard \
  --restart unless-stopped \
  -p 8000:8000 \
  -v /path/to/data:/app/data \
  ghcr.io/noideadeveloper/cardboard:latest
```

**Update:**

```bash
docker pull ghcr.io/noideadeveloper/cardboard:latest
docker stop cardboard && docker rm cardboard
# re-run the docker run command above
```

### Unraid

1. In the Unraid UI go to **Docker → Add Container**.
2. Fill in the fields:

| Field | Value |
|---|---|
| Name | `cardboard` |
| Repository | `ghcr.io/noideadeveloper/cardboard:latest` |
| Network Type | `Bridge` |
| Port (host → container) | `8000 → 8000` |
| Path (host → container) | `/mnt/user/appdata/cardboard → /app/data` |

3. Click **Apply**. The container will pull the image and start. Open `http://<unraid-ip>:8000`.

**Update on Unraid:** Stop the container, click the image tag, select **Pull latest**, then restart.

Alternatively, install the **Compose Manager** plugin and use the `docker-compose.yml` from this repo, setting `DATA_PATH=/mnt/user/appdata/cardboard`.

## Features

- **Collection management** — add, edit, bulk-edit, and delete games with detailed fields (players, playtime, difficulty, rating, labels, categories, mechanics, designers, publishers, condition, purchase info, storage location)
- **BGG integration** — search and auto-fill from BoardGameGeek; import collections (XML) and play history; parent/expansion linking
- **Import** — CSV and BGG XML collection import
- **Media** — cover images, multi-image photo gallery with captions, instruction PDF upload with inline viewer
- **Play tracking** — log sessions with date, duration, players, winner, notes, and per-session rating; quick-log overlay on game cards; solo mode
- **Player profiles** — per-player stats, win rates, top games, co-player leaderboard with head-to-head records
- **Stats dashboard** — totals, most-played, player leaderboard, rating distribution, added/sessions-by-month charts, 52-week activity heatmap (scrolled to the current week on load), day-of-week breakdown, shelf of shame, collection value
- **Goals & challenges** — progress-tracked goals (total sessions, play all owned, unique mechanics, etc.) with auto-complete detection
- **Sharing** — token-based read-only share links with optional expiry; visitors can browse, filter, and submit "want to play" requests; export a self-contained static HTML page to share without exposing your server
- **Game night** — suggestion engine filtered by player count and playtime; scores games using user ratings, per-session ratings, and BGG rating as a fallback; penalizes low-rated and recently-played games; enforces variety across difficulty bands; random "Pick for Me" selector
- **Similar games** — IDF-weighted mechanic and category matching (rare tags score higher than ubiquitous ones), graduated difficulty comparison, and Jaccard player-count overlap
- **Onboarding tour** — first-visit coach-mark walkthrough of key features; dismissing or completing it is permanently recorded in the database (with a localStorage cache) so you are never re-prompted
- **Quality of life** — dark/light theme, keyboard shortcuts overlay, milestone confetti, PWA support, ETag caching

## Configuration

Set via environment variables (or `.env` for Docker):

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8000` | Host port the container is mapped to |
| `DATA_PATH` | `./data` | Host path for the data bind mount |
| `ALLOWED_ORIGINS` | `*` | CORS origins (set to your domain in production) |
| `LOG_LEVEL` | `INFO` | Python log level |
| `DATABASE_URL` | `sqlite:///./data/cardboard.db` | SQLAlchemy connection string — only needed if using PostgreSQL or a custom path |
| `FRONTEND_PATH` | `/app/frontend` | Path to the frontend assets — only needed if running the backend outside of Docker |

## Backups

**In-app:** Settings panel > Download ZIP (database + all media).

**Manual:** Copy the `data/` directory. Restore by replacing it and restarting the container.

```
data/
├── cardboard.db       # database
├── images/            # cover images
├── gallery/           # photo galleries
├── instructions/      # PDFs
└── avatars/           # player avatars
```

## Development

```bash
cd backend && pip install -r requirements.txt
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

Frontend is plain HTML/CSS/JS in `frontend/` — edit and refresh, no build step. API docs at `/api/docs`.

## Tech Stack

Python, FastAPI, SQLAlchemy, Alembic, SQLite, vanilla JS/CSS, Docker.
