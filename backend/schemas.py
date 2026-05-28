from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator, model_validator
from typing import Annotated, Optional, List, Dict
from datetime import date, datetime


def _strip_name(v):
    return v.strip() if isinstance(v, str) else v


def _validate_min_max(model):
    if model.min_players is not None and model.max_players is not None and model.min_players > model.max_players:
        raise ValueError('min_players cannot exceed max_players')
    if model.min_playtime is not None and model.max_playtime is not None and model.min_playtime > model.max_playtime:
        raise ValueError('min_playtime cannot exceed max_playtime')
    return model


class GameBase(BaseModel):
    name: str = Field(..., max_length=255)

    @field_validator('name', mode='before')
    @classmethod
    def strip_name(cls, v):
        return _strip_name(v)

    status: str = Field('owned', pattern='^(owned|wishlist|sold)$')
    year_published: Optional[int] = Field(None, ge=1800, le=2099)
    min_players: Optional[int] = Field(None, ge=1)
    max_players: Optional[int] = Field(None, ge=1)
    min_playtime: Optional[int] = Field(None, ge=1)
    max_playtime: Optional[int] = Field(None, ge=1)
    difficulty: Optional[float] = Field(None, ge=1, le=5)
    description: Optional[str] = Field(None, max_length=5000)
    image_url: Optional[str] = Field(None, max_length=2000)
    thumbnail_url: Optional[str] = Field(None, max_length=2000)
    instructions_filename: Optional[str] = Field(None, max_length=255)
    categories: Optional[str] = Field(None, max_length=2000)
    mechanics: Optional[str] = Field(None, max_length=2000)
    designers: Optional[str] = Field(None, max_length=2000)
    publishers: Optional[str] = Field(None, max_length=2000)
    labels: Optional[str] = Field(None, max_length=2000)
    purchase_date: Optional[date] = None
    purchase_price: Optional[float] = Field(None, ge=0)
    purchase_location: Optional[str] = Field(None, max_length=255)
    sale_price: Optional[float] = Field(None, ge=0)
    location: Optional[str] = Field(None, max_length=255)
    show_location: bool = False
    user_rating: Optional[float] = Field(None, ge=1, le=10)
    user_notes: Optional[str] = Field(None, max_length=2000)
    last_played: Optional[date] = None
    parent_game_id: Optional[int] = Field(None, ge=1)
    bgg_id: Optional[Annotated[int, Field(ge=1)]] = None
    bgg_rating: Optional[float] = Field(None, ge=1, le=10)
    priority: Optional[int] = Field(None, ge=1, le=5)
    target_price: Optional[float] = Field(None, ge=0)
    condition: Optional[str] = Field(None, pattern='^(New|Good|Fair|Poor)$')
    edition: Optional[str] = Field(None, max_length=255)
    share_hidden: bool = False

    @model_validator(mode='after')
    def check_min_max(self):
        return _validate_min_max(self)


class GameCreate(GameBase):
    pass


class GameUpdate(BaseModel):
    name: Optional[str] = Field(None, max_length=255)

    @field_validator('name', mode='before')
    @classmethod
    def strip_name(cls, v):
        return _strip_name(v)

    status: Optional[str] = Field(None, pattern='^(owned|wishlist|sold)$')
    year_published: Optional[int] = Field(None, ge=1800, le=2099)
    min_players: Optional[int] = Field(None, ge=1)
    max_players: Optional[int] = Field(None, ge=1)
    min_playtime: Optional[int] = Field(None, ge=1)
    max_playtime: Optional[int] = Field(None, ge=1)
    difficulty: Optional[float] = Field(None, ge=1, le=5)
    description: Optional[str] = Field(None, max_length=5000)
    image_url: Optional[str] = Field(None, max_length=2000)
    thumbnail_url: Optional[str] = Field(None, max_length=2000)
    categories: Optional[str] = Field(None, max_length=2000)
    mechanics: Optional[str] = Field(None, max_length=2000)
    designers: Optional[str] = Field(None, max_length=2000)
    publishers: Optional[str] = Field(None, max_length=2000)
    labels: Optional[str] = Field(None, max_length=2000)
    purchase_date: Optional[date] = None
    purchase_price: Optional[float] = Field(None, ge=0)
    purchase_location: Optional[str] = Field(None, max_length=255)
    sale_price: Optional[float] = Field(None, ge=0)
    location: Optional[str] = Field(None, max_length=255)
    show_location: Optional[bool] = None
    user_rating: Optional[float] = Field(None, ge=1, le=10)
    user_notes: Optional[str] = Field(None, max_length=2000)
    last_played: Optional[date] = None
    parent_game_id: Optional[int] = Field(None, ge=1)
    bgg_id: Optional[Annotated[int, Field(ge=1)]] = None
    bgg_rating: Optional[float] = Field(None, ge=1, le=10)
    priority: Optional[int] = Field(None, ge=1, le=5)
    target_price: Optional[float] = Field(None, ge=0)
    condition: Optional[str] = Field(None, pattern='^(New|Good|Fair|Poor)$')
    edition: Optional[str] = Field(None, max_length=255)
    share_hidden: Optional[bool] = None

    @model_validator(mode='after')
    def check_min_max(self):
        return _validate_min_max(self)


class GameResponse(GameBase):
    id: int
    image_cached: bool = False
    image_ext: Optional[str] = None
    image_cache_status: Optional[str] = None  # null | "pending" | "cached" | "failed"
    date_added: Optional[datetime] = None
    date_modified: Optional[datetime] = None
    parent_game_name: Optional[str] = None  # denormalized — joined in GET
    heat_level: int = 0        # 0–3, computed from last_played
    expansion_count: int = 0   # number of direct child games
    session_count: int = 0     # total logged play sessions

    model_config = ConfigDict(from_attributes=True)


GameOut = GameResponse


class CollectionStatsResponse(BaseModel):
    total_owned: int
    total_wishlist: int
    total_sold: int
    base_game_count: int
    expansion_count: int
    total_hours: float
    unplayed_count: int
    rated_count: int
    locations: Dict[str, int] = {}
    mechanic_counts: Dict[str, int] = {}
    category_counts: Dict[str, int] = {}
    label_counts: Dict[str, int] = {}
    designer_counts: Dict[str, int] = {}
    publisher_counts: Dict[str, int] = {}
    play_pct: int = 0
    neglected_favorite: Optional[NeglectedFavoriteEntry] = None


class GameImageResponse(BaseModel):
    id: int
    game_id: int
    filename: str
    sort_order: int
    caption: Optional[str] = None
    date_added: Optional[datetime] = None

    model_config = ConfigDict(from_attributes=True)


class GameImageUpdate(BaseModel):
    caption: Optional[str] = Field(None, max_length=500)


class ReorderImagesBody(BaseModel):
    order: List[int]


class GalleryImageFromUrl(BaseModel):
    url: str = Field(..., max_length=2000)


class PlaySessionCreate(BaseModel):
    played_at: date
    player_count: Optional[int] = Field(None, ge=1)
    duration_minutes: Optional[int] = Field(None, ge=1)
    notes: Optional[str] = Field(None, max_length=2000)
    session_rating: Optional[int] = Field(None, ge=1, le=5)
    winner: Optional[str] = Field(None, max_length=255)
    solo: bool = False
    player_names: Optional[List[Annotated[str, StringConstraints(max_length=255)]]] = Field(None, max_length=50)  # names to link/create as players
    scores: Optional[Dict[str, int]] = None  # player_name -> score


class BulkSessionCreate(BaseModel):
    game_ids: List[int]
    played_at: date
    player_count: Optional[int] = Field(None, ge=1)
    duration_minutes: Optional[int] = Field(None, ge=1)
    notes: Optional[str] = Field(None, max_length=2000)
    session_rating: Optional[int] = Field(None, ge=1, le=5)
    winner: Optional[str] = Field(None, max_length=255)
    solo: bool = False
    player_names: Optional[List[Annotated[str, StringConstraints(max_length=255)]]] = Field(None, max_length=50)
    scores: Optional[Dict[str, int]] = None


class PlaySessionUpdate(BaseModel):
    played_at: Optional[date] = None
    player_count: Optional[int] = Field(None, ge=1)
    duration_minutes: Optional[int] = Field(None, ge=1)
    notes: Optional[str] = Field(None, max_length=2000)
    session_rating: Optional[int] = Field(None, ge=1, le=5)
    winner: Optional[str] = Field(None, max_length=255)
    solo: Optional[bool] = None
    player_names: Optional[List[Annotated[str, StringConstraints(max_length=255)]]] = Field(None, max_length=50)
    scores: Optional[Dict[str, int]] = None


class PlaySessionResponse(PlaySessionCreate):
    id: int
    game_id: int
    date_added: Optional[datetime] = None
    players: List[str] = []  # resolved player names
    player_scores: Dict[str, int] = {}  # player_name -> score (populated separately)
    game_session_count: Optional[int] = None   # total sessions for this game (set on POST only)
    game_total_minutes: Optional[int] = None   # total minutes played for this game (set on POST only)

    model_config = ConfigDict(from_attributes=True)


class PlayerSessionResponse(PlaySessionResponse):
    game_name: str = ""
    game_thumbnail: Optional[str] = None


class PlayerCreate(BaseModel):
    name: str = Field(..., max_length=255)

    @field_validator('name', mode='before')
    @classmethod
    def strip_name(cls, v):
        return _strip_name(v)


class PlayerUpdate(BaseModel):
    name: str = Field(..., max_length=255)

    @field_validator('name', mode='before')
    @classmethod
    def strip_name(cls, v):
        return _strip_name(v)


class PlayerResponse(BaseModel):
    id: int
    name: str
    date_added: Optional[datetime] = None
    session_count: int = 0
    win_count: int = 0
    avatar_url: Optional[str] = None     # custom photo URL or preset SVG path, set server-side
    avatar_preset: Optional[str] = None  # active preset key, e.g. "meeple"

    model_config = ConfigDict(from_attributes=True)


class AvatarPresetSet(BaseModel):
    preset: str


class PlayerTopGame(BaseModel):
    game_id: int
    game_name: str
    play_count: int


class PlayerCoPlayer(BaseModel):
    player_id: int
    player_name: str
    count: int
    wins_against: int = 0   # sessions where this player won while co-player was present
    losses_to: int = 0      # sessions where co-player won while this player was present
    avatar_url: Optional[str] = None


class PlayerSessionsByMonth(BaseModel):
    month: str   # "YYYY-MM"
    count: int


class PlayerWinRateByMonth(BaseModel):
    month: str         # "YYYY-MM"
    win_rate: int      # 0-100, only over sessions with a recorded winner
    sessions: int      # how many decided sessions in this month


class PlayerStreak(BaseModel):
    kind: str          # "W", "L", or "" if no decided sessions yet
    length: int        # consecutive results from most recent backwards


class PlayerStatsResponse(BaseModel):
    session_count: int
    win_count: int
    last_played: Optional[date] = None
    top_games: List['PlayerTopGame'] = []
    most_played_with: List['PlayerCoPlayer'] = []
    sessions_by_month: List['PlayerSessionsByMonth'] = []
    # Decided sessions only (winner field non-null) for the next three:
    recent_form: List[str] = []                                # ≤10 results, newest-first
    current_streak: PlayerStreak = Field(default_factory=lambda: PlayerStreak(kind="", length=0))
    win_rate_by_month: List[PlayerWinRateByMonth] = []


GOAL_TYPES = frozenset({
    'sessions_total', 'sessions_year', 'play_all_owned', 'game_sessions', 'unique_mechanics',
    'unique_games_year', 'total_hours', 'category_coverage', 'win_rate_target',
})


class GoalCreate(BaseModel):
    title: str = Field(..., max_length=255)
    type: str
    target_value: int = Field(..., ge=1)
    game_id: Optional[int] = None
    year: Optional[int] = None

    @field_validator('type')
    @classmethod
    def validate_type(cls, v):
        if v not in GOAL_TYPES:
            raise ValueError(f'type must be one of {sorted(GOAL_TYPES)}')
        return v


class GoalResponse(BaseModel):
    id: int
    title: str
    type: str
    target_value: int
    game_id: Optional[int] = None
    game_name: Optional[str] = None  # denormalized
    year: Optional[int] = None
    current_value: int
    is_complete: bool
    completed_at: Optional[datetime] = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class WantToPlayCreate(BaseModel):
    visitor_name: Optional[str] = Field(None, max_length=100)
    message: Optional[str] = Field(None, max_length=500)


class WantToPlayResponse(BaseModel):
    id: int
    game_id: int
    game_name: str
    visitor_name: Optional[str] = None
    message: Optional[str] = None
    seen: bool
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ShareTokenResponse(BaseModel):
    token: str
    label: Optional[str] = None
    created_at: Optional[datetime] = None
    expires_at: Optional[datetime] = None

    model_config = ConfigDict(from_attributes=True)


class GameSuggestion(BaseModel):
    id: int
    name: str
    image_url: Optional[str] = None
    min_players: Optional[int] = None
    max_players: Optional[int] = None
    min_playtime: Optional[int] = None
    max_playtime: Optional[int] = None
    difficulty: Optional[float] = None
    user_rating: Optional[float] = None
    last_played: Optional[date] = None
    reasons: List[str] = []


class SuggestRequest(BaseModel):
    player_count: Optional[int] = Field(None, ge=1, le=20)
    max_minutes: Optional[int] = Field(None, ge=1, le=1440)


class ValueGameEntry(BaseModel):
    id: int
    name: str
    purchase_price: float
    # cost-per-play list
    sessions: Optional[int] = None
    cpp: Optional[float] = None       # cost per play ($)
    # cost-per-hour list
    total_minutes: Optional[int] = None
    cph: Optional[float] = None       # cost per hour ($/hr)
    # most-expensive-unplayed list
    date_added: Optional[datetime] = None


class CollectionValueStats(BaseModel):
    owned_total: Optional[float] = None      # total purchase price of owned games
    avg_price: Optional[float] = None        # average purchase price of owned games
    unplayed_total: Optional[float] = None   # total purchase price of unplayed owned games
    best_value_by_play: List[ValueGameEntry] = []   # lowest $/session (top 5)
    best_value_by_time: List[ValueGameEntry] = []   # lowest $/hr (top 5)
    most_expensive_unplayed: List[ValueGameEntry] = []  # priciest owned, never played (top 5)


class MostPlayedEntry(BaseModel):
    id: int
    name: str
    count: int
    total_minutes: int


class AddedByMonthEntry(BaseModel):
    month: str
    count: int


class SessionsByMonthEntry(BaseModel):
    month: str
    count: int
    game_ids: List[int] = []


class RecentSessionEntry(BaseModel):
    game_id: int
    game_name: str
    played_at: date
    player_count: Optional[int] = None
    duration_minutes: Optional[int] = None


class TopPlayerEntry(BaseModel):
    player_id: int
    player_name: str
    session_count: int
    win_count: int
    win_rate: int  # 0-100 percent
    avatar_url: Optional[str] = None


class SessionsByDowEntry(BaseModel):
    dow: int   # 0=Sunday … 6=Saturday (SQLite strftime %w)
    count: int
    game_ids: List[int] = []


class SessionsByDayEntry(BaseModel):
    date: str   # "YYYY-MM-DD"
    count: int
    game_ids: List[int] = []


class ShelfWarmerEntry(BaseModel):
    id: int
    name: str
    last_played: date
    days_since: int


class TopMechanicEntry(BaseModel):
    name: str
    count: int


class NeverPlayedEntry(BaseModel):
    id: int
    name: str
    date_added: Optional[datetime] = None


class DormantGameEntry(BaseModel):
    id: int
    name: str
    last_played: date


class RecentlyAddedEntry(BaseModel):
    id: int
    name: str
    date_added: datetime


class NeglectedFavoriteEntry(BaseModel):
    id: int
    name: str
    months_ago: int


class RatingDeltaEntry(BaseModel):
    id: int
    name: str
    delta: float


class CollectionHealth(BaseModel):
    score: int
    play_pct: int
    rating_score: int
    diversity_score: int
    played_count: int
    owned_base_count: int
    avg_rating_raw: float
    unique_mechanics: int


class BestPlayerCountEntry(BaseModel):
    game_id: int
    game_name: str
    player_count: int
    avg_rating: float
    total_sessions: int
    image_url: Optional[str] = None


class PlayProjection(BaseModel):
    unplayed_count: int
    avg_plays_per_week: float
    projected_clear_date: Optional[date] = None   # estimated date all unplayed games are played
    weeks_to_clear: Optional[float] = None


class CollectionChurn(BaseModel):
    total_ever_acquired: int = 0
    total_sold: int = 0
    current_owned: int = 0
    churn_rate: float = 0.0   # sold / total_ever_acquired, 0–1
    acquired_this_year: int = 0
    sold_this_year: int = 0


class TopWishlistEntry(BaseModel):
    id: int
    name: str


class SessionSummaryResponse(BaseModel):
    session_count: int
    total_minutes: int


class StatsResponse(BaseModel):
    total_games: int
    by_status: Dict[str, int]
    total_sessions: int
    total_hours: float
    avg_session_minutes: float
    most_played: List[MostPlayedEntry]
    never_played_count: int
    avg_rating: Optional[float]
    total_spent: Optional[float]
    label_counts: Dict[str, int]
    ratings_distribution: Dict[str, int]
    added_by_month: List[AddedByMonthEntry]
    sessions_by_month: List[SessionsByMonthEntry]
    recent_sessions: List[RecentSessionEntry]
    session_counts: Dict[str, int]
    total_expansions: int = 0
    top_players: List[TopPlayerEntry] = []
    sessions_by_dow: List[SessionsByDowEntry] = []
    sessions_by_day: List[SessionsByDayEntry] = []
    collection_value: CollectionValueStats = Field(default_factory=CollectionValueStats)
    shelf_warmers: List[ShelfWarmerEntry] = []
    # Server-precomputed fields (eliminate heavy client-side game-array passes)
    top_mechanic: Optional[str] = None
    top_mechanics: List[TopMechanicEntry] = []
    dormant_games: List[DormantGameEntry] = []
    recently_added: List[RecentlyAddedEntry] = []
    never_played_list: List[NeverPlayedEntry] = []
    neglected_favorite: Optional[NeglectedFavoriteEntry] = None
    rating_vs_bgg: List[RatingDeltaEntry] = []
    collection_health: Optional[CollectionHealth] = None
    added_by_month_owned_only: List[AddedByMonthEntry] = []
    daily_streak: int = 0
    weekly_streak: int = 0
    top_wishlist_game: Optional[TopWishlistEntry] = None
    unplayed_with_top_mechanic: int = 0
    best_at_player_counts: List[BestPlayerCountEntry] = []
    play_projection: Optional[PlayProjection] = None
    collection_churn: Optional[CollectionChurn] = None
    health_notifications: List[str] = []
    trade_sell: List[TradeSellEntry] = []


class GroupRecommendRequest(BaseModel):
    player_ids: List[int] = Field(..., min_length=1, max_length=10)
    max_minutes: Optional[int] = Field(None, ge=1, le=1440)
    mechanic: Optional[str] = Field(None, max_length=100)


class GroupRecommendEntry(BaseModel):
    game: GameOut
    reason: str
    confidence: float


class GroupRecommendResponse(BaseModel):
    recommendations: List[GroupRecommendEntry] = []


class DuplicateCheckEntry(BaseModel):
    id: int
    name: str
    status: str
    bgg_id: Optional[int] = None
    reason: str = ""  # "exact_name", "similar_name", "same_bgg_id", "possible_expansion"

    model_config = ConfigDict(from_attributes=True)


class DuplicateCheckResponse(BaseModel):
    duplicates: List[DuplicateCheckEntry] = []


class RecommendGameResponse(BaseModel):
    game: GameOut
    reason: str
    reason_detail: str
    confidence: float
    alternatives: List[GameOut] = []


class TradeSellEntry(BaseModel):
    id: int
    name: str
    purchase_price: Optional[float] = None
    sale_price: Optional[float] = None
    user_rating: Optional[float] = None
    last_played: Optional[date] = None
    session_count: int = 0
    score: int = 0
    reason: str = ""

    model_config = ConfigDict(from_attributes=True)


class TradeSellResponse(BaseModel):
    games: List[TradeSellEntry] = []
