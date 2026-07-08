# Contributing to Cardboard

Thanks for your interest! Here's how to get a dev environment running and how to submit changes.

## Development setup

```bash
git clone https://github.com/NoIdeaDeveloper/cardboard.git
cd cardboard

cd backend
pip install -r requirements.txt -r requirements-dev.txt
alembic upgrade head
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

The frontend is plain HTML/CSS/JS in `frontend/` — edit files and refresh the browser for the dev server (it serves `frontend/` directly). For production-style testing, build the bundle with `npm install && npm run build`. Set `ENABLE_DOCS=true` to expose API docs at `http://localhost:8000/api/docs`.

## Running tests

```bash
pytest backend/tests -v   # backend
npm test                  # frontend (vitest)
ruff check backend/       # lint
```

## Submitting changes

1. Fork the repo and create a branch from `main`.
2. Make your changes and add/update tests where appropriate.
3. Open a pull request against `main`. Describe what changed and why.

## Guidelines

- Keep PRs focused — one feature or fix per PR.
- Match the existing code style.
- Don't commit the `data/` directory, `.env`, or any secrets.

## Reporting bugs

Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md) and include steps to reproduce, expected vs. actual behaviour, and your Cardboard version.
