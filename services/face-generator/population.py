"""Mirror of packages/shared/src/index.ts: currentTotalSlots().

Keep these in lockstep — both files use the same baseline date, baseline
population, and daily increment so the Modal endpoint accepts exactly the
same slot-index range as the web app.
"""

from __future__ import annotations

from datetime import datetime, timezone

POPULATION_BASELINE = 8_289_468_500
BASELINE_EPOCH_MS = int(datetime(2026, 4, 26, tzinfo=timezone.utc).timestamp() * 1000)
ANNUAL_GROWTH_RATE = 0.0084
DAILY_INCREMENT = 190_718  # floor(BASELINE * 0.0084 / 365)


def current_total_slots(now: datetime | None = None) -> int:
    if now is None:
        now = datetime.now(tz=timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    now_ms = int(now.timestamp() * 1000)
    days = max(0, (now_ms - BASELINE_EPOCH_MS) // 86_400_000)
    return POPULATION_BASELINE + DAILY_INCREMENT * days
