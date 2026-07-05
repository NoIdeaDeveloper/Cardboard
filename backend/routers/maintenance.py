"""Maintenance log endpoints: track missing pieces, sleeves, damage per game."""
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from database import get_db
import models
import schemas
from utils import get_game_or_404

logger = logging.getLogger("cardboard.maintenance")
router = APIRouter(prefix="/api/games", tags=["maintenance"])


@router.get("/{game_id}/maintenance", response_model=list[schemas.MaintenanceLogEntry])
def list_maintenance(game_id: int, db: Session = Depends(get_db)):
    get_game_or_404(game_id, db)
    return (
        db.query(models.MaintenanceLog)
        .filter(models.MaintenanceLog.game_id == game_id)
        .order_by(models.MaintenanceLog.created_at.desc())
        .all()
    )


@router.post("/{game_id}/maintenance", response_model=schemas.MaintenanceLogEntry, status_code=201)
def add_maintenance(game_id: int, body: schemas.MaintenanceLogCreate, db: Session = Depends(get_db)):
    get_game_or_404(game_id, db)
    entry = models.MaintenanceLog(
        game_id=game_id,
        kind=body.kind,
        description=body.description,
        status="open",
    )
    db.add(entry)
    db.commit()
    db.refresh(entry)
    logger.info("Maintenance log added: game_id=%d kind=%s", game_id, body.kind)
    return entry


@router.patch("/maintenance/{entry_id}", response_model=schemas.MaintenanceLogEntry)
def update_maintenance(entry_id: int, body: schemas.MaintenanceLogUpdate, db: Session = Depends(get_db)):
    entry = db.query(models.MaintenanceLog).filter(models.MaintenanceLog.id == entry_id).first()
    if not entry:
        raise HTTPException(status_code=404, detail="Maintenance entry not found")
    if body.status is not None:
        entry.status = body.status
        entry.resolved_at = datetime.now(timezone.utc) if body.status == "resolved" else None
    if body.description is not None:
        entry.description = body.description
    db.commit()
    db.refresh(entry)
    return entry


@router.delete("/maintenance/{entry_id}", status_code=204)
def delete_maintenance(entry_id: int, db: Session = Depends(get_db)):
    entry = db.query(models.MaintenanceLog).filter(models.MaintenanceLog.id == entry_id).first()
    if not entry:
        raise HTTPException(status_code=404, detail="Maintenance entry not found")
    db.delete(entry)
    db.commit()


@router.get("/maintenance/open", response_model=list[schemas.MaintenanceLogEntry])
def list_open_maintenance(db: Session = Depends(get_db)):
    """List all open maintenance entries across all games (for the stats 'needs attention' view)."""
    return (
        db.query(models.MaintenanceLog)
        .filter(models.MaintenanceLog.status == "open")
        .order_by(models.MaintenanceLog.created_at.desc())
        .all()
    )