import logging
import re

import models
from database import get_db
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

logger = logging.getLogger("cardboard.settings")
router = APIRouter(prefix="/api/settings", tags=["settings"])

# Settings keys must be alphanumeric + underscores, 1-64 chars, and prefixed
# with "cardboard_". This prevents unbounded row growth from arbitrary keys.
_KEY_RE = re.compile(r"^cardboard_[a-zA-Z0-9_]{1,55}$")


class SettingValue(BaseModel):
    value: str = Field(max_length=10_000)


def _validate_key(key: str) -> None:
    if not _KEY_RE.match(key):
        raise HTTPException(status_code=400, detail="Invalid setting key")


@router.get("/{key}")
def get_setting(key: str, db: Session = Depends(get_db)):
    _validate_key(key)
    row = db.query(models.UserSetting).filter(models.UserSetting.key == key).first()
    return {"key": key, "value": row.value if row else ""}


@router.put("/{key}", status_code=204)
def put_setting(key: str, body: SettingValue, db: Session = Depends(get_db)):
    _validate_key(key)
    row = db.query(models.UserSetting).filter(models.UserSetting.key == key).first()
    if row:
        row.value = body.value
    else:
        db.add(models.UserSetting(key=key, value=body.value))
    db.commit()
    logger.info("Setting saved: %r (len=%d)", key, len(body.value))
    return JSONResponse(status_code=204, content=None)
