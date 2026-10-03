from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets
import sqlite3
import uuid
from datetime import datetime, timezone
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

CODE_RE = r"^ref_[A-Za-z0-9_-]{16,64}$"
SOURCES = {"direct", "twitter", "youtube", "other"}
EVENTS = {"click", "qualified_visit", "enrollment_start", "enrollment", "recurring_conversion"}
DESTINATION_HOST_ALLOWLIST = {"course.buildinpublicuniversity.com"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _key() -> bytes:
    value = os.environ.get("CREATORAPIS_MCP_REFERRAL_KEY", "")
    if len(value) < 32:
        raise RuntimeError("referral_key_not_configured")
    return value.encode()


def _digest(value: str) -> str:
    return hmac.new(_key(), value.strip().encode(), hashlib.sha256).hexdigest()


def init_referral_tables(conn: sqlite3.Connection) -> None:
    conn.execute("""CREATE TABLE IF NOT EXISTS student_referrals (
        referral_hash TEXT PRIMARY KEY,
        student_digest TEXT NOT NULL,
        label TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS referral_events (
        event_id TEXT PRIMARY KEY,
        referral_hash TEXT NOT NULL,
        event_name TEXT NOT NULL,
        source TEXT NOT NULL,
        content_slug TEXT,
        occurred_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
    )""")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_referral_events_rank ON referral_events(referral_hash, event_name, occurred_at)"
    )


def destination_with_referral(
    destination_url: str, code: str, source: str, content_slug: str
) -> str:
    parsed = urlparse(destination_url)
    if parsed.scheme != "https" or parsed.hostname not in DESTINATION_HOST_ALLOWLIST:
        raise ValueError("destination_url must be an approved HTTPS course destination")
    query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    query.update(
        {
            "ref": code,
            "utm_source": source,
            "utm_medium": "student-referral",
            "utm_campaign": "bipu-university",
            "utm_content": content_slug,
        }
    )
    return urlunparse(
        (
            parsed.scheme,
            parsed.netloc,
            parsed.path,
            parsed.params,
            urlencode(query),
            parsed.fragment,
        )
    )


def create_referral(conn: sqlite3.Connection, student_id: str, label: str) -> tuple[str, str]:
    if not isinstance(student_id, str) or not 1 <= len(student_id.strip()) <= 128:
        raise ValueError("student_id must be a bounded identifier")
    if not isinstance(label, str) or not 1 <= len(label.strip()) <= 80:
        raise ValueError("label must be bounded text")
    digest = _digest(student_id)
    existing = conn.execute(
        "SELECT referral_hash FROM student_referrals WHERE student_digest=? AND revoked_at IS NULL ORDER BY created_at LIMIT 1",
        (digest,),
    ).fetchone()
    if existing:
        # The public code is not recoverable from storage; callers should persist the receipt.
        raise ValueError("student already has a referral code; use the existing code")
    code = "ref_" + secrets.token_urlsafe(18)
    conn.execute(
        "INSERT INTO student_referrals(referral_hash,student_digest,label,created_at) VALUES(?,?,?,?)",
        (_digest(code), digest, label.strip(), _now()),
    )
    return code, digest


def record_event(
    conn: sqlite3.Connection,
    code: str,
    event_name: str,
    source: str,
    content_slug: str | None = None,
    event_id: str | None = None,
) -> dict[str, Any]:
    if not isinstance(code, str) or not re.fullmatch(CODE_RE, code):
        raise ValueError("invalid referral code")
    if event_name not in EVENTS or source not in SOURCES:
        raise ValueError("invalid referral event")
    if content_slug is not None and (
        not isinstance(content_slug, str)
        or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", content_slug)
    ):
        raise ValueError("invalid content_slug")
    referral = conn.execute(
        "SELECT 1 FROM student_referrals WHERE referral_hash=? AND revoked_at IS NULL",
        (_digest(code),),
    ).fetchone()
    if not referral:
        raise ValueError("unknown referral code")
    event_id = event_id or "evt_" + uuid.uuid4().hex
    result = conn.execute(
        "INSERT OR IGNORE INTO referral_events(event_id,referral_hash,event_name,source,content_slug,occurred_at,metadata_json) VALUES(?,?,?,?,?,?,?)",
        (event_id, _digest(code), event_name, source, content_slug, _now(), "{}"),
    )
    return {"event_id": event_id, "accepted": result.rowcount == 1}


def leaderboard(conn: sqlite3.Connection, days: int = 30) -> list[dict[str, Any]]:
    days = max(1, min(days, 366))
    rows = conn.execute(
        """SELECT r.label, r.created_at, e.source,
      SUM(CASE WHEN e.event_name='click' THEN 1 ELSE 0 END) clicks,
      SUM(CASE WHEN e.event_name='qualified_visit' THEN 1 ELSE 0 END) visits,
      SUM(CASE WHEN e.event_name='enrollment' THEN 1 ELSE 0 END) enrollments,
      SUM(CASE WHEN e.event_name='recurring_conversion' THEN 1 ELSE 0 END) recurring
      FROM student_referrals r LEFT JOIN referral_events e ON e.referral_hash=r.referral_hash
      AND e.occurred_at >= datetime('now', ?) WHERE r.revoked_at IS NULL
      GROUP BY r.referral_hash ORDER BY enrollments DESC, visits DESC, clicks DESC""",
        (f"-{days} days",),
    ).fetchall()
    return [
        {
            "label": row[0],
            "created_at": row[1],
            "sources": row[2],
            "clicks": row[3] or 0,
            "qualified_visits": row[4] or 0,
            "enrollments": row[5] or 0,
            "recurring_conversions": row[6] or 0,
            "claim_status": "observed_events_only",
        }
        for row in rows
    ]
