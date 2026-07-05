import logging
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from database import get_db
import models

logger = logging.getLogger("cardboard.settings")
router = APIRouter(prefix="/api/settings", tags=["settings"])


class SettingValue(BaseModel):
    value: str = Field(max_length=10_000)


@router.get("/{key}")
def get_setting(key: str, db: Session = Depends(get_db)):
    row = db.query(models.UserSetting).filter(models.UserSetting.key == key).first()
    return {"key": key, "value": row.value if row else ""}


@router.put("/{key}", status_code=204)
def put_setting(key: str, body: SettingValue, db: Session = Depends(get_db)):
    row = db.query(models.UserSetting).filter(models.UserSetting.key == key).first()
    if row:
        row.value = body.value
    else:
        db.add(models.UserSetting(key=key, value=body.value))
    db.commit()
    logger.info("Setting saved: %r (len=%d)", key, len(body.value))
    return JSONResponse(status_code=204, content=None)
