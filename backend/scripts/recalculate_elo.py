"""
Management script to recalculate all Elo ratings from existing scored sessions.
Run once after deploying the Elo feature.

Usage:
    cd backend
    python scripts/recalculate_elo.py
"""

import os
import sys

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("DATABASE_URL", "sqlite:///./data/cardboard.db")
os.environ.setdefault("DATA_DIR", "./data")

from database import SessionLocal
import models
from elo_db import recalculate_elo_for_players


def main():
    db = SessionLocal()
    try:
        # Get all player IDs
        player_rows = db.query(models.Player.id).all()
        all_ids = {r.id for r in player_rows}

        if not all_ids:
            print("No players found.")
            return

        print(f"Recalculating Elo for {len(all_ids)} players...")
        recalculate_elo_for_players(all_ids, db)
        db.commit()
        print("Done.")

        # Show top 10
        top = (
            db.query(models.Player.name, models.Player.elo_rating, models.Player.games_played)
            .order_by(models.Player.elo_rating.desc())
            .limit(10)
            .all()
        )
        print("\nTop players by Elo:")
        for i, (name, elo, gp) in enumerate(top, 1):
            print(f"  {i}. {name}: {round(elo, 1)} ({gp} rated games)")
    finally:
        db.close()


if __name__ == "__main__":
    main()
