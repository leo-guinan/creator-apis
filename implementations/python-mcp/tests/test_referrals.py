import sqlite3

import pytest

from creatorapis_mcp.referrals import (
    create_referral,
    destination_with_referral,
    init_referral_tables,
    leaderboard,
    record_event,
)


def db(monkeypatch, tmp_path):
    monkeypatch.setenv("CREATORAPIS_MCP_REFERRAL_KEY", "test-referral-key-with-at-least-32-bytes")
    conn = sqlite3.connect(tmp_path / "referrals.sqlite3")
    init_referral_tables(conn)
    return conn


def test_create_never_stores_raw_student_id_and_builds_bounded_link(monkeypatch, tmp_path):
    conn = db(monkeypatch, tmp_path)
    code, _ = create_referral(conn, "student-secret-42", "Ada")
    link = destination_with_referral(
        "https://course.buildinpublicuniversity.com/", code, "twitter", "post-1"
    )
    assert link.startswith("https://course.buildinpublicuniversity.com/")
    assert f"ref={code}" in link
    assert b"student-secret-42" not in (tmp_path / "referrals.sqlite3").read_bytes()


def test_events_are_idempotent_and_leaderboard_is_observed_only(monkeypatch, tmp_path):
    conn = db(monkeypatch, tmp_path)
    code, _ = create_referral(conn, "student-1", "Student one")
    first = record_event(conn, code, "enrollment", "youtube", "video-1", "evt-fixed")
    duplicate = record_event(conn, code, "enrollment", "youtube", "video-1", "evt-fixed")
    conn.commit()
    assert first["accepted"] is True
    assert duplicate["accepted"] is False
    rows = leaderboard(conn)
    assert rows[0]["enrollments"] == 1
    assert rows[0]["claim_status"] == "observed_events_only"


def test_destination_allowlist_rejects_non_course_urls(monkeypatch, tmp_path):
    db(monkeypatch, tmp_path)
    with pytest.raises(ValueError):
        destination_with_referral("https://evil.example/", "ref_abcdefghijklmnop", "direct", "x")
