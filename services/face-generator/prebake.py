"""Pre-baked face windows.

Mirrors packages/shared/src/prebake.ts — keep the constants in lockstep when
either side changes. Anchor positions are derived from POPULATION_BASELINE
(static day-zero total) so the on-disk filenames in the prebake volume stay
valid as the daily total ticks up.
"""

from __future__ import annotations

POPULATION_BASELINE = 8_289_468_500
PREBAKE_WINDOW_COUNT = 100
PREBAKE_WINDOW_SIZE = 100

_STEP = POPULATION_BASELINE // PREBAKE_WINDOW_COUNT
_HALF = PREBAKE_WINDOW_SIZE // 2


def prebake_anchors() -> list[int]:
    """Start slot of every pre-baked window, in order."""
    anchors: list[int] = []
    for i in range(PREBAKE_WINDOW_COUNT):
        center = _STEP * i + _STEP // 2
        start = center - _HALF if center > _HALF else 0
        anchors.append(start)
    return anchors


def is_prebaked(slot: int) -> bool:
    """O(1) check — does ``slot`` fall in any pre-baked window?"""
    if slot < 0 or slot >= POPULATION_BASELINE:
        return False
    slice_idx = slot // _STEP
    if slice_idx >= PREBAKE_WINDOW_COUNT:
        return False
    center = _STEP * slice_idx + _STEP // 2
    start = center - _HALF if center > _HALF else 0
    end = start + PREBAKE_WINDOW_SIZE
    return start <= slot < end
