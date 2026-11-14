from __future__ import annotations

import uuid

from app.domain.errors import Forbidden, HoldNotActive, NotFound, SeatUnavailable
from app.domain.models import Booking, Principal
from app.infra.clock import Clock
from app.infra.kv_store import KeyValueStore
from app.repositories.base import BookingRepository, SeatRepository
from app.services.hold_service import HoldService


class BookingService:
    def __init__(
        self,
        holds: HoldService,
        seats: SeatRepository,
        bookings: BookingRepository,
        kv: KeyValueStore,
        clock: Clock,
    ) -> None:
        self._holds = holds
        self._seats = seats
        self._bookings = bookings
        self._kv = kv
        self._clock = clock

    def confirm(self, principal: Principal, hold_id: str) -> Booking:
        hold = self._holds.get_hold(hold_id)
        if hold is None:
            raise HoldNotActive("hold is no longer active")
        if hold.user_id != principal.user_id:
            raise Forbidden("not the owner of this hold")

        seats = self._seats.get_many(hold.event_id, hold.seat_ids)
        if self._seats.mark_booked(hold.id) != len(hold.seat_ids):
            raise SeatUnavailable("held seats could not be booked")

        booking = Booking(
            id=uuid.uuid4().hex,
            event_id=hold.event_id,
            user_id=principal.user_id,
            hold_id=hold.id,
            seat_ids=hold.seat_ids,
            total_cents=sum(s.price_cents for s in seats),
            created_at=self._clock.now(),
        )
        self._bookings.add(booking)
        self._holds.mark_confirmed(hold)
        self._kv.delete(f"availability:{hold.event_id}")
        return booking

    def get_booking(self, principal: Principal, booking_id: str) -> Booking:
        booking = self._bookings.get(booking_id)
        if booking is None:
            raise NotFound("booking not found")
        if booking.user_id != principal.user_id and not principal.is_admin:
            raise Forbidden("not the owner of this booking")
        return booking

    def list_my_bookings(self, principal: Principal) -> list[Booking]:
        return self._bookings.list_for_user(principal.user_id)
