from __future__ import annotations

from fastapi import APIRouter, Response

from app.api.schemas import HoldCreate, hold_out
from app.deps import ContainerDep, PrincipalDep

router = APIRouter(prefix="/holds", tags=["holds"])


@router.post("", status_code=201)
def create_hold(body: HoldCreate, principal: PrincipalDep, container: ContainerDep) -> dict:
    hold = container.hold_service.create_hold(principal, body.event_id, body.seat_ids)
    return hold_out(hold)


@router.get("/{hold_id}")
def get_hold(hold_id: str, principal: PrincipalDep, container: ContainerDep) -> dict:
    return hold_out(container.hold_service.view_hold(principal, hold_id))


@router.delete("/{hold_id}", status_code=204)
def release_hold(hold_id: str, principal: PrincipalDep, container: ContainerDep) -> Response:
    container.hold_service.release_hold(principal, hold_id)
    return Response(status_code=204)
