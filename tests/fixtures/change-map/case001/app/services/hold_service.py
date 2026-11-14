from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta
from typing import Sequence

from app.domain.errors import Forbidden, HoldNotActive, NotFound, SeatUnavailable, ValidationFailed
from app.domain.models import Hold, HoldStatus, Principal
from app.infra.clock import Clock
from app.infra.kv_store import KeyValueStore
from app.repositories.base import EventRepository, HoldRepository, SeatRepository


def _hold_to_json(hold: Hold) -> str:
    return json.dumps(
        {
            "id": hold.id,
            "event_id": hold.event_id,
            "user_id": hold.user_id,
            "seat_ids": list(hold.seat_ids),
            "expires_at": hold.expires_at.isoformat(),
        }
    )


def _hold_from_json(raw: str) -> Hold:
    data = json.loads(raw)
    return Hold(
        id=data["id"],
        event_id=data["event_id"],
        user_id=data["user_id"],
        seat_ids=tuple(data["seat_ids"]),
        expires_at=datetime.fromisoformat(data["expires_at"]),
    )


class HoldService:
    def __init__(
        self,
        events: EventRepository,
        seats: SeatRepository,
        holds: HoldRepository,
        kv: KeyValueStore,
        clock: Clock,
        ttl_seconds: int,
        max_seats_per_hold: int,
    ) -> None:
        self._events = events
        self._seats = seats
        self._holds = holds
        self._kv = kv
        self._clock = clock
        self._ttl = ttl_seconds
        self._max_seats = max_seats_per_hold

    def create_hold(self, principal: Principal, event_id: str, seat_ids: Sequence[str]) -> Hold:
        ids = list(seat_ids)
        if not ids:
            raise ValidationFailed("at least one seat is required")
        if len(set(ids)) != len(ids):
            raise ValidationFailed("duplicate seats in request")
        if len(ids) > self._max_seats:
            raise ValidationFailed(f"at most {self._max_seats} seats per hold")
        if self._events.get(event_id) is None:
            raise NotFound("event not found")
        if len(self._seats.get_many(event_id, ids)) != len(ids):
            raise NotFound("one or more seats not found")

        hold_id = uuid.uuid4().hex
        if not self._seats.try_hold(event_id, ids, hold_id):
            raise SeatUnavailable("one or more seats are not available")

        hold = Hold(
            id=hold_id,
            event_id=event_id,
            user_id=principal.user_id,
            seat_ids=tuple(ids),
            expires_at=self._clock.now() + timedelta(seconds=self._ttl),
        )
        try:
            self._holds.add(hold)
            self._kv.set(f"hold:{hold.id}", _hold_to_json(hold), ttl_seconds=self._ttl)
        except Exception:
            self._seats.release(hold_id)
            raise
        self._kv.delete(f"availability:{event_id}")
        return hold

    def get_hold(self, hold_id: str) -> Hold | None:
        """Return the hold, or None if it is unknown or no longer active.

        Falls back to the durable record when the cache entry is missing, so a
        cache restart does not strand customers who are mid-checkout.
        """
        raw = self._kv.get(f"hold:{hold_id}")
        if raw is not None:
            return _hold_from_json(raw)
        stored = self._holds.get(hold_id)
        if stored is not None and stored.status is HoldStatus.ACTIVE:
            return stored
        return None

    def view_hold(self, principal: Principal, hold_id: str) -> Hold:
        hold = self._require_active(hold_id)
        if hold.user_id != principal.user_id and not principal.is_admin:
            raise Forbidden("not the owner of this hold")
        return hold

    def release_hold(self, principal: Principal, hold_id: str) -> None:
        hold = self._require_active(hold_id)
        if hold.user_id != principal.user_id and not principal.is_admin:
            raise Forbidden("not the owner of this hold")
        self._close(hold, HoldStatus.RELEASED)

    def expire_hold(self, hold: Hold) -> None:
        self._close(hold, HoldStatus.EXPIRED)

    def mark_confirmed(self, hold: Hold) -> None:
        self._holds.update_status(hold.id, HoldStatus.CONFIRMED)
        self._kv.delete(f"hold:{hold.id}")

    def _require_active(self, hold_id: str) -> Hold:
        hold = self.get_hold(hold_id)
        if hold is None:
            raise HoldNotActive("hold is no longer active")
        return hold

    def _close(self, hold: Hold, status: HoldStatus) -> None:
        self._seats.release(hold.id)
        self._holds.update_status(hold.id, status)
        self._kv.delete(f"hold:{hold.id}")
        self._kv.delete(f"availability:{hold.event_id}")
