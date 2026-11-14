from __future__ import annotations


def _confirm(client, headers, hold_id, key="key-1"):
    return client.post(
        "/bookings", json={"hold_id": hold_id}, headers={**headers, "Idempotency-Key": key}
    )


def test_hold_is_still_visible_after_cache_flush(client, event, kv, as_user, make_hold):
    alice = as_user("alice")
    hold = make_hold(alice, event).json()
    kv.flush()
    resp = client.get(f"/holds/{hold['id']}", headers=alice)
    assert resp.status_code == 200
    assert resp.json()["id"] == hold["id"]


def test_booking_can_be_confirmed_after_cache_flush(client, event, kv, as_user, make_hold):
    alice = as_user("alice")
    hold = make_hold(alice, event).json()
    kv.flush()
    assert _confirm(client, alice, hold["id"]).status_code == 201


def test_released_hold_stays_gone_after_cache_flush(client, event, kv, as_user, make_hold):
    alice = as_user("alice")
    hold = make_hold(alice, event).json()
    client.delete(f"/holds/{hold['id']}", headers=alice)
    kv.flush()
    assert client.get(f"/holds/{hold['id']}", headers=alice).status_code == 410


def test_unknown_hold_is_still_gone(client, as_user):
    assert client.get("/holds/missing", headers=as_user("alice")).status_code == 410
