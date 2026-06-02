from datetime import datetime, timezone
from sqlalchemy import Column, Index, Integer, String, Float, Text, Date, DateTime, Boolean, ForeignKey
from database import Base


class Game(Base):
    __tablename__ = "games"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False, index=True)
    status = Column(String(20), default='owned', nullable=False, index=True)
    year_published = Column(Integer, nullable=True)
    min_players = Column(Integer, nullable=True)
    max_players = Column(Integer, nullable=True)
    min_playtime = Column(Integer, nullable=True)
    max_playtime = Column(Integer, nullable=True)
    difficulty = Column(Float, nullable=True)
    description = Column(Text, nullable=True)
    image_url = Column(Text, nullable=True)
    thumbnail_url = Column(Text, nullable=True)
    image_cached = Column(Boolean, default=False, nullable=False)
    image_ext = Column(String(10), nullable=True)  # cached image file extension e.g. ".jpg"
    image_cache_status = Column(String(10), nullable=True)  # null | "pending" | "cached" | "failed"
    instructions_filename = Column(Text, nullable=True)
    purchase_date = Column(Date, nullable=True)
    purchase_price = Column(Float, nullable=True)
    purchase_location = Column(String(255), nullable=True)
    sale_price = Column(Float, nullable=True)
    user_rating = Column(Float, nullable=True)  # 1-10
    user_notes = Column(Text, nullable=True)
    location = Column(String(255), nullable=True)
    show_location = Column(Boolean, default=False, nullable=False)
    last_played = Column(Date, nullable=True)
    # Python-side defaults so they work reliably with SQLite
    date_added = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
    date_modified = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc), nullable=False)
    parent_game_id = Column(Integer, ForeignKey("games.id"), nullable=True, index=True)
    # New fields
    bgg_id = Column(Integer, nullable=True, index=True)
    bgg_rating = Column(Float, nullable=True)  # BGG community average rating
    priority = Column(Integer, nullable=True)  # 1-5 wishlist priority
    target_price = Column(Float, nullable=True)  # wishlist target price
    condition = Column(String(20), nullable=True)  # New/Good/Fair/Poor
    edition = Column(String(255), nullable=True)  # edition/version string
    share_hidden = Column(Boolean, default=False, nullable=False)

    # Composite indexes for common filter+sort patterns
    __table_args__ = (
        Index('ix_games_status_name',        'status', 'name'),
        Index('ix_games_status_last_played',  'status', 'last_played'),
        Index('ix_games_status_date_added',   'status', 'date_added'),
    )


class GameImage(Base):
    __tablename__ = "game_images"

    id = Column(Integer, primary_key=True, index=True)
    game_id = Column(Integer, ForeignKey("games.id", ondelete="CASCADE"), nullable=False, index=True)
    filename = Column(String(255), nullable=False)
    sort_order = Column(Integer, default=0, nullable=False)
    caption = Column(String(500), nullable=True)
    date_added = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)


class PlaySession(Base):
    __tablename__ = "play_sessions"

    id = Column(Integer, primary_key=True, index=True)
    game_id = Column(Integer, ForeignKey("games.id", ondelete="CASCADE"), nullable=False, index=True)
    played_at = Column(Date, nullable=False)
    player_count = Column(Integer, nullable=True)
    duration_minutes = Column(Integer, nullable=True)
    notes = Column(Text, nullable=True)
    session_rating = Column(Integer, nullable=True)   # 1–5 stars, per-session rating
    winner = Column(String(255), nullable=True)
    solo = Column(Boolean, default=False, nullable=False)
    date_added = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)

    __table_args__ = (
        Index('ix_play_sessions_game_played', 'game_id', 'played_at'),
    )


class Player(Base):
    __tablename__ = "players"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False, unique=True)
    date_added = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
    avatar_ext = Column(String(10), nullable=True)    # e.g. ".jpg" when a custom photo is uploaded
    avatar_preset = Column(String(50), nullable=True)  # e.g. "meeple" when a default SVG is chosen
    elo_rating = Column(Float, default=1500.0, nullable=False)
    games_played = Column(Integer, default=0, nullable=False)


class SessionPlayer(Base):
    __tablename__ = "session_players"

    session_id = Column(Integer, ForeignKey("play_sessions.id", ondelete="CASCADE"), primary_key=True)
    player_id = Column(Integer, ForeignKey("players.id", ondelete="CASCADE"), primary_key=True)
    score = Column(Integer, nullable=True)


class ShareToken(Base):
    __tablename__ = "share_tokens"

    token = Column(String(64), primary_key=True)
    label = Column(String(255), nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
    expires_at = Column(DateTime, nullable=True)


class Goal(Base):
    __tablename__ = "goals"

    id = Column(Integer, primary_key=True)
    title = Column(String(255), nullable=False)
    type = Column(String(50), nullable=False)   # sessions_total | sessions_year | play_all_owned | game_sessions | unique_mechanics
    target_value = Column(Integer, nullable=False)
    game_id = Column(Integer, ForeignKey("games.id", ondelete="SET NULL"), nullable=True)
    year = Column(Integer, nullable=True)        # for sessions_year goals
    is_complete = Column(Boolean, default=False, nullable=False)
    completed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)


class WantToPlayRequest(Base):
    __tablename__ = "want_to_play_requests"

    id = Column(Integer, primary_key=True)
    token = Column(String(64), nullable=False, index=True)
    game_id = Column(Integer, ForeignKey("games.id", ondelete="CASCADE"), nullable=False, index=True)
    visitor_name = Column(String(100), nullable=True)
    message = Column(String(500), nullable=True)
    seen = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)


# ===== Tag Junction Tables =====
# Each tag type has a lookup table (unique names) and a pivot table linking games to tags.

class Category(Base):
    __tablename__ = "categories"
    id = Column(Integer, primary_key=True)
    name = Column(String(255), nullable=False, unique=True, index=True)

class GameCategory(Base):
    __tablename__ = "game_categories"
    game_id = Column(Integer, ForeignKey("games.id", ondelete="CASCADE"), primary_key=True)
    category_id = Column(Integer, ForeignKey("categories.id", ondelete="CASCADE"), primary_key=True)


class Mechanic(Base):
    __tablename__ = "mechanics"
    id = Column(Integer, primary_key=True)
    name = Column(String(255), nullable=False, unique=True, index=True)

class GameMechanic(Base):
    __tablename__ = "game_mechanics"
    game_id = Column(Integer, ForeignKey("games.id", ondelete="CASCADE"), primary_key=True)
    mechanic_id = Column(Integer, ForeignKey("mechanics.id", ondelete="CASCADE"), primary_key=True)


class Designer(Base):
    __tablename__ = "designers"
    id = Column(Integer, primary_key=True)
    name = Column(String(255), nullable=False, unique=True, index=True)

class GameDesigner(Base):
    __tablename__ = "game_designers"
    game_id = Column(Integer, ForeignKey("games.id", ondelete="CASCADE"), primary_key=True)
    designer_id = Column(Integer, ForeignKey("designers.id", ondelete="CASCADE"), primary_key=True)


class Publisher(Base):
    __tablename__ = "publishers"
    id = Column(Integer, primary_key=True)
    name = Column(String(255), nullable=False, unique=True, index=True)

class GamePublisher(Base):
    __tablename__ = "game_publishers"
    game_id = Column(Integer, ForeignKey("games.id", ondelete="CASCADE"), primary_key=True)
    publisher_id = Column(Integer, ForeignKey("publishers.id", ondelete="CASCADE"), primary_key=True)


class Label(Base):
    __tablename__ = "labels"
    id = Column(Integer, primary_key=True)
    name = Column(String(255), nullable=False, unique=True, index=True)

class GameLabel(Base):
    __tablename__ = "game_labels"
    game_id = Column(Integer, ForeignKey("games.id", ondelete="CASCADE"), primary_key=True)
    label_id = Column(Integer, ForeignKey("labels.id", ondelete="CASCADE"), primary_key=True)


class UserSetting(Base):
    __tablename__ = "user_settings"

    key = Column(String(255), primary_key=True)
    value = Column(Text, nullable=False, default="")
