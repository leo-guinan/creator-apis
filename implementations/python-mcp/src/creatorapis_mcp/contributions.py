from __future__ import annotations

import hashlib
import hmac
import json
import re
import sqlite3
import uuid
from datetime import date, datetime, timezone
from importlib.resources import files
from pathlib import Path
from typing import Any, Callable

CONSENT_VERSION = "creatorapis-attribution-v2-locked-eval"
MEASUREMENT_STATUS = "self_reported"
CONSENT_ATTESTATION = "client_reported_eval_lock"
EVAL_CRITERIA = (
    "evidence_traceability",
    "uncertainty_and_falsifiers",
    "privacy_boundary",
    "daily_energy_integrity",
)
CALIBRATION_TAGS = {"evidence", "privacy", "uncertainty", "energy", "style", "scope"}
MAX_TALE_CHARS = 20_000
MAX_SYSTEM_LABEL_CHARS = 80
MAX_COVERAGE_DAYS = 366
MAX_ENERGY_ROWS = 5_000
MAX_EVENTS_PER_DAY_CATEGORY = 100_000
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
EVAL_ID_RE = re.compile(r"^eval_[a-f0-9]{32}$")
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
CATEGORY_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,39}$")
EMAIL_IN_TEXT_RE = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.I)
URL_IN_TEXT_RE = re.compile(r"https?://", re.I)

ATTRIBUTION_PROMPT = (
    files("creatorapis_mcp")
    .joinpath("prompts/contribution-v1.md")
    .read_text(encoding="utf-8")
    .strip()
)


def _parse_iso_date(value: Any, field: str) -> date:
    if not isinstance(value, str) or not DATE_RE.fullmatch(value):
        raise ValueError(f"{field} must be an ISO UTC date (YYYY-MM-DD)")
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        raise ValueError(f"{field} must be a valid calendar date") from None
    if parsed.isoformat() != value:
        raise ValueError(f"{field} must be a valid calendar date")
    return parsed


def normalize_submission(
    arguments: dict[str, Any], has_secret: Callable[[str], bool]
) -> dict[str, Any]:
    required = {
        "request_id",
        "agent_system",
        "coverage_start",
        "coverage_end",
        "coverage_status",
        "capability_tale",
        "daily_energy",
    }
    if set(arguments) != required:
        raise ValueError("submission has missing or unknown fields")

    request_id = arguments["request_id"]
    if not isinstance(request_id, str) or not REQUEST_ID_RE.fullmatch(request_id):
        raise ValueError("request_id must be a bounded opaque identifier")

    system = arguments["agent_system"]
    if (
        not isinstance(system, str)
        or not system.strip()
        or len(system.strip()) > MAX_SYSTEM_LABEL_CHARS
        or any(ord(char) < 32 for char in system)
    ):
        raise ValueError("agent_system must be a short, single-line label")
    system = system.strip()
    if has_secret(system) or EMAIL_IN_TEXT_RE.search(system) or URL_IN_TEXT_RE.search(system):
        raise ValueError("agent_system must not contain credentials, email addresses, or URLs")

    start = _parse_iso_date(arguments["coverage_start"], "coverage_start")
    end = _parse_iso_date(arguments["coverage_end"], "coverage_end")
    if end < start:
        raise ValueError("coverage_end must not precede coverage_start")
    if (end - start).days + 1 > MAX_COVERAGE_DAYS:
        raise ValueError("coverage window exceeds 366 days")
    if end > datetime.now(timezone.utc).date():
        raise ValueError("coverage window must not include future UTC dates")

    coverage_status = arguments["coverage_status"]
    if coverage_status not in {"full", "partial", "unknown"}:
        raise ValueError("coverage_status must be full, partial, or unknown")

    tale = arguments["capability_tale"]
    if not isinstance(tale, str) or not tale.strip() or len(tale) > MAX_TALE_CHARS:
        raise ValueError(
            f"capability_tale must be non-empty text of at most {MAX_TALE_CHARS} characters"
        )
    tale = tale.strip()
    if has_secret(tale):
        raise ValueError("capability_tale rejected because it appears to contain a credential")
    if EMAIL_IN_TEXT_RE.search(tale) or URL_IN_TEXT_RE.search(tale):
        raise ValueError("capability_tale must not contain email addresses or URLs")

    rows = arguments["daily_energy"]
    if not isinstance(rows, list) or len(rows) > MAX_ENERGY_ROWS:
        raise ValueError("daily_energy must be a bounded array")
    counts: dict[tuple[str, str], int] = {}
    for row in rows:
        if not isinstance(row, dict) or set(row) != {"date", "category", "events"}:
            raise ValueError("each daily_energy row must contain only date, category, and events")
        day = _parse_iso_date(row["date"], "daily_energy.date")
        if day < start or day > end:
            raise ValueError("daily_energy date must fall within the declared coverage window")
        if day > datetime.now(timezone.utc).date():
            raise ValueError("daily_energy date must not be in the future")
        category = row["category"]
        if not isinstance(category, str) or not CATEGORY_RE.fullmatch(category):
            raise ValueError("category must be a lowercase category slug")
        count = row["events"]
        if type(count) is not int or count < 1 or count > MAX_EVENTS_PER_DAY_CATEGORY:
            raise ValueError("events must be a positive bounded integer")
        key = (day.isoformat(), category)
        counts[key] = counts.get(key, 0) + count
        if counts[key] > MAX_EVENTS_PER_DAY_CATEGORY:
            raise ValueError("aggregated event count exceeds the allowed bound")

    energy = [
        {"date": day, "category": category, "events": count}
        for (day, category), count in sorted(counts.items())
    ]
    projection = {
        "request_id": request_id,
        "agent_system": system,
        "coverage_start": start.isoformat(),
        "coverage_end": end.isoformat(),
        "coverage_status": coverage_status,
        "capability_tale": tale,
        "daily_energy": energy,
        "measurement_status": MEASUREMENT_STATUS,
        "consent_version": CONSENT_VERSION,
        "consent_attestation": CONSENT_ATTESTATION,
    }
    serialized = json.dumps(projection, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return {
        **projection,
        "content_sha256": hashlib.sha256(serialized.encode("utf-8")).hexdigest(),
    }


def _create_contribution_table(conn: sqlite3.Connection) -> None:
    conn.execute("""CREATE TABLE IF NOT EXISTS routing_profile_contributions (
        contribution_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        agent_system TEXT NOT NULL,
        coverage_start TEXT NOT NULL,
        coverage_end TEXT NOT NULL,
        coverage_status TEXT NOT NULL CHECK(coverage_status IN ('full','partial','unknown')),
        capability_tale TEXT NOT NULL,
        measurement_status TEXT NOT NULL CHECK(measurement_status='self_reported'),
        consent_attestation TEXT NOT NULL CHECK(consent_attestation IN ('client_reported_user_approval','client_reported_eval_lock')),
        consent_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        content_sha256 TEXT NOT NULL,
        evaluation_id TEXT,
        evaluation_score INTEGER,
        evaluation_policy_sha256 TEXT,
        delivery_mode TEXT,
        evaluated_payload_sha256 TEXT,
        evaluation_checks_json TEXT,
        evaluation_receipt_sha256 TEXT,
        UNIQUE(profile_id, request_id)
    )""")


def init_attribution_tables(conn: sqlite3.Connection) -> None:
    existing = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='routing_profile_contributions'"
    ).fetchone()
    if existing:
        columns = {
            row[1] for row in conn.execute("PRAGMA table_info(routing_profile_contributions)")
        }
        if "evaluation_id" not in columns:
            conn.execute(
                "ALTER TABLE routing_profile_contributions RENAME TO routing_profile_contributions_legacy_v1"
            )
            _create_contribution_table(conn)
            conn.execute("""INSERT INTO routing_profile_contributions(
                contribution_id,user_id,profile_id,request_id,agent_system,coverage_start,coverage_end,
                coverage_status,capability_tale,measurement_status,consent_attestation,consent_version,
                created_at,content_sha256
            ) SELECT contribution_id,user_id,profile_id,request_id,agent_system,coverage_start,coverage_end,
                coverage_status,capability_tale,measurement_status,consent_attestation,consent_version,
                created_at,content_sha256 FROM routing_profile_contributions_legacy_v1""")
            conn.execute("DROP TABLE routing_profile_contributions_legacy_v1")
    else:
        _create_contribution_table(conn)

    contribution_columns = {
        row[1] for row in conn.execute("PRAGMA table_info(routing_profile_contributions)")
    }
    for column in (
        "evaluated_payload_sha256",
        "evaluation_checks_json",
        "evaluation_receipt_sha256",
    ):
        if column not in contribution_columns:
            conn.execute(f"ALTER TABLE routing_profile_contributions ADD COLUMN {column} TEXT")

    conn.execute("""CREATE TABLE IF NOT EXISTS routing_profile_energy_events (
        contribution_id TEXT NOT NULL,
        utc_date TEXT NOT NULL,
        category TEXT NOT NULL,
        event_count INTEGER NOT NULL CHECK(event_count > 0),
        PRIMARY KEY(contribution_id, utc_date, category)
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS contribution_evaluations (
        eval_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK(version > 0),
        criteria_json TEXT NOT NULL,
        minimum_calibrations INTEGER NOT NULL CHECK(minimum_calibrations BETWEEN 3 AND 20),
        threshold_percent INTEGER NOT NULL CHECK(threshold_percent BETWEEN 75 AND 100),
        auto_delivery INTEGER NOT NULL CHECK(auto_delivery = 1),
        state TEXT NOT NULL CHECK(state IN ('calibrating','locked','paused','superseded')),
        policy_sha256 TEXT NOT NULL,
        lock_attestation TEXT,
        created_at TEXT NOT NULL,
        locked_at TEXT,
        UNIQUE(profile_id, version)
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS contribution_eval_calibrations (
        calibration_id TEXT PRIMARY KEY,
        eval_id TEXT NOT NULL,
        sample_sha256 TEXT NOT NULL,
        evaluator_decision TEXT NOT NULL CHECK(evaluator_decision IN ('pass','revise','fail')),
        human_verdict TEXT NOT NULL CHECK(human_verdict IN ('approve','revise','reject')),
        feedback_tags_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(eval_id, sample_sha256)
    )""")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_routing_energy_lookup ON routing_profile_energy_events(category, utc_date, contribution_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_contribution_eval_owner ON contribution_evaluations(user_id, profile_id, version)"
    )


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _tool_success(payload: dict[str, Any]) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": json.dumps(payload, separators=(",", ":"))}]}


def _tool_failure(message: str) -> dict[str, Any]:
    return {"isError": True, "content": [{"type": "text", "text": message}]}


def _exact_fields(arguments: dict[str, Any], expected: set[str]) -> None:
    if set(arguments) != expected:
        raise ValueError("action has missing or unknown fields")


def _eval_owner(
    conn: sqlite3.Connection, eval_id: str, user_id: str, profile_id: str
) -> sqlite3.Row:
    if not isinstance(eval_id, str) or not EVAL_ID_RE.fullmatch(eval_id):
        raise ValueError("eval_id is invalid")
    row = conn.execute(
        "SELECT * FROM contribution_evaluations WHERE eval_id=? AND user_id=? AND profile_id=?",
        (eval_id, user_id, profile_id),
    ).fetchone()
    if not row:
        raise ValueError("evaluation not found for this profile")
    return row


def _create_eval(
    conn: sqlite3.Connection, user_id: str, profile_id: str, arguments: dict[str, Any]
) -> dict[str, Any]:
    _exact_fields(
        arguments,
        {
            "action",
            "criteria",
            "minimum_calibrations",
            "threshold_percent",
            "auto_delivery",
        },
    )
    criteria = arguments["criteria"]
    if (
        not isinstance(criteria, list)
        or not criteria
        or len(criteria) > len(EVAL_CRITERIA)
        or any(not isinstance(item, str) for item in criteria)
        or len(set(criteria)) != len(criteria)
        or not set(criteria).issubset(EVAL_CRITERIA)
    ):
        raise ValueError("criteria must be a unique non-empty subset of the supported rubric")
    if not {"privacy_boundary", "daily_energy_integrity"}.issubset(criteria):
        raise ValueError("privacy_boundary and daily_energy_integrity are mandatory criteria")
    minimum = arguments["minimum_calibrations"]
    if type(minimum) is not int or not 3 <= minimum <= 20:
        raise ValueError("minimum_calibrations must be an integer from 3 to 20")
    threshold = arguments["threshold_percent"]
    if type(threshold) is not int or not 75 <= threshold <= 100:
        raise ValueError("threshold_percent must be an integer from 75 to 100")
    if arguments["auto_delivery"] is not True:
        raise ValueError(
            "auto_delivery must be explicitly enabled before an evaluation can be locked"
        )

    version = conn.execute(
        "SELECT COALESCE(MAX(version),0)+1 FROM contribution_evaluations WHERE profile_id=?",
        (profile_id,),
    ).fetchone()[0]
    eval_id = "eval_" + uuid.uuid4().hex
    normalized_criteria = sorted(criteria)
    policy = {
        "version": version,
        "criteria": normalized_criteria,
        "minimum_calibrations": minimum,
        "threshold_percent": threshold,
        "auto_delivery": True,
        "destination": "authenticated_owner_profile",
    }
    policy_sha256 = hashlib.sha256(
        json.dumps(policy, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    conn.execute(
        "INSERT INTO contribution_evaluations(eval_id,user_id,profile_id,version,criteria_json,"
        "minimum_calibrations,threshold_percent,auto_delivery,state,policy_sha256,created_at) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        (
            eval_id,
            user_id,
            profile_id,
            version,
            json.dumps(normalized_criteria),
            minimum,
            threshold,
            1,
            "calibrating",
            policy_sha256,
            _utc_now(),
        ),
    )
    return {
        "status": "created",
        "eval_id": eval_id,
        "version": version,
        "state": "calibrating",
        "criteria": normalized_criteria,
        "minimum_calibrations": minimum,
        "threshold_percent": threshold,
        "auto_delivery": True,
        "destination": "authenticated_owner_profile",
        "policy_sha256": policy_sha256,
        "evaluation_type": "client_reported_calibrated_prediction",
    }


def _calibrate_eval(
    conn: sqlite3.Connection, user_id: str, profile_id: str, arguments: dict[str, Any]
) -> dict[str, Any]:
    _exact_fields(
        arguments,
        {
            "action",
            "eval_id",
            "sample_sha256",
            "evaluator_decision",
            "human_verdict",
            "feedback_tags",
        },
    )
    row = _eval_owner(conn, arguments["eval_id"], user_id, profile_id)
    if row["state"] != "calibrating":
        raise ValueError("only a calibrating evaluation accepts examples")
    sample_hash = arguments["sample_sha256"]
    if not isinstance(sample_hash, str) or not SHA256_RE.fullmatch(sample_hash):
        raise ValueError("sample_sha256 must be a lowercase SHA-256 hex digest")
    decision = arguments["evaluator_decision"]
    verdict = arguments["human_verdict"]
    if (
        not isinstance(decision, str)
        or decision not in {"pass", "revise", "fail"}
        or not isinstance(verdict, str)
        or verdict not in {"approve", "revise", "reject"}
    ):
        raise ValueError("evaluator_decision or human_verdict is invalid")
    tags = arguments["feedback_tags"]
    if (
        not isinstance(tags, list)
        or len(tags) > len(CALIBRATION_TAGS)
        or any(not isinstance(tag, str) or tag not in CALIBRATION_TAGS for tag in tags)
        or len(set(tags)) != len(tags)
    ):
        raise ValueError("feedback_tags must be unique bounded tags from the supported set")
    calibration_id = "calibration_" + uuid.uuid4().hex
    conn.execute(
        "INSERT INTO contribution_eval_calibrations(calibration_id,eval_id,sample_sha256,"
        "evaluator_decision,human_verdict,feedback_tags_json,created_at) VALUES(?,?,?,?,?,?,?)",
        (
            calibration_id,
            row["eval_id"],
            sample_hash,
            decision,
            verdict,
            json.dumps(sorted(tags)),
            _utc_now(),
        ),
    )
    count, false_passes = conn.execute(
        "SELECT COUNT(*),SUM(CASE WHEN evaluator_decision='pass' AND human_verdict!='approve' THEN 1 ELSE 0 END) "
        "FROM contribution_eval_calibrations WHERE eval_id=?",
        (row["eval_id"],),
    ).fetchone()
    return {
        "status": "calibrated",
        "eval_id": row["eval_id"],
        "calibration_count": count,
        "minimum_calibrations": row["minimum_calibrations"],
        "observed_false_passes": false_passes or 0,
        "ready_to_lock": count >= row["minimum_calibrations"] and not false_passes,
    }


def _lock_eval(
    conn: sqlite3.Connection, user_id: str, profile_id: str, arguments: dict[str, Any]
) -> dict[str, Any]:
    _exact_fields(arguments, {"action", "eval_id", "lock_phrase"})
    row = _eval_owner(conn, arguments["eval_id"], user_id, profile_id)
    if row["state"] != "calibrating":
        raise ValueError("only a calibrating evaluation can be locked")
    if arguments["lock_phrase"] != f"LOCK {row['eval_id']}":
        raise ValueError("one-time evaluation lock confirmation is required")
    count, false_passes = conn.execute(
        "SELECT COUNT(*),SUM(CASE WHEN evaluator_decision='pass' AND human_verdict!='approve' THEN 1 ELSE 0 END) "
        "FROM contribution_eval_calibrations WHERE eval_id=?",
        (row["eval_id"],),
    ).fetchone()
    if count < row["minimum_calibrations"]:
        raise ValueError("minimum calibration count has not been reached")
    if false_passes:
        raise ValueError(
            "evaluation has observed false passes; recalibrate a new policy before locking"
        )
    conn.execute(
        "UPDATE contribution_evaluations SET state='superseded' WHERE profile_id=? AND state='locked'",
        (profile_id,),
    )
    locked_at = _utc_now()
    conn.execute(
        "UPDATE contribution_evaluations SET state='locked',lock_attestation=?,locked_at=? WHERE eval_id=?",
        (f"client_reported_lock:{row['eval_id']}", locked_at, row["eval_id"]),
    )
    return {
        "state": "locked",
        "eval_id": row["eval_id"],
        "version": row["version"],
        "calibration_count": count,
        "observed_false_passes": 0,
        "auto_delivery": True,
        "destination": "authenticated_owner_profile",
        "policy_sha256": row["policy_sha256"],
        "lock_attestation": "client_reported_phrase",
        "evaluation_type": "client_reported_calibrated_prediction",
    }


def _pause_eval(
    conn: sqlite3.Connection, user_id: str, profile_id: str, arguments: dict[str, Any]
) -> dict[str, Any]:
    _exact_fields(arguments, {"action", "eval_id"})
    row = _eval_owner(conn, arguments["eval_id"], user_id, profile_id)
    if row["state"] != "locked":
        raise ValueError("only a locked evaluation can be paused")
    conn.execute(
        "UPDATE contribution_evaluations SET state='paused' WHERE eval_id=?",
        (row["eval_id"],),
    )
    return {"state": "paused", "eval_id": row["eval_id"], "auto_delivery": False}


def _deliver(
    conn: sqlite3.Connection,
    user_id: str,
    profile_id: str,
    arguments: dict[str, Any],
    has_secret: Callable[[str], bool],
) -> dict[str, Any]:
    profile_fields = {
        "request_id",
        "agent_system",
        "coverage_start",
        "coverage_end",
        "coverage_status",
        "capability_tale",
        "daily_energy",
    }
    _exact_fields(
        arguments,
        profile_fields | {"action", "eval_id", "evaluation_checks", "evaluated_payload_sha256"},
    )
    row = _eval_owner(conn, arguments["eval_id"], user_id, profile_id)
    if row["state"] != "locked" or row["auto_delivery"] != 1:
        raise ValueError("a locked, active auto-delivery evaluation is required")
    profile_payload = {key: arguments[key] for key in profile_fields}
    serialized = json.dumps(
        profile_payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )
    expected_hash = hashlib.sha256(serialized.encode("utf-8")).hexdigest()
    submitted_hash = arguments["evaluated_payload_sha256"]
    if (
        not isinstance(submitted_hash, str)
        or not SHA256_RE.fullmatch(submitted_hash)
        or not hmac.compare_digest(expected_hash, submitted_hash)
    ):
        raise ValueError("evaluation receipt does not match the exact profile payload")
    criteria = json.loads(row["criteria_json"])
    checks = arguments["evaluation_checks"]
    if (
        not isinstance(checks, dict)
        or set(checks) != set(criteria)
        or any(
            not isinstance(value, str) or value not in {"pass", "fail"} for value in checks.values()
        )
    ):
        raise ValueError("evaluation_checks must give one pass/fail result per locked criterion")
    score = int(100 * sum(value == "pass" for value in checks.values()) / len(criteria))
    if checks.get("privacy_boundary") != "pass" or checks.get("daily_energy_integrity") != "pass":
        raise ValueError("mandatory privacy and daily-energy checks must pass")
    if score < row["threshold_percent"]:
        raise ValueError("evaluation score is below the locked threshold")
    checks_json = json.dumps(checks, sort_keys=True, separators=(",", ":"))
    evaluation_receipt = {
        "eval_id": row["eval_id"],
        "policy_sha256": row["policy_sha256"],
        "evaluated_payload_sha256": submitted_hash,
        "evaluation_checks": checks,
    }
    evaluation_receipt_sha256 = hashlib.sha256(
        json.dumps(evaluation_receipt, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    normalized = normalize_submission(profile_payload, has_secret)

    existing = conn.execute(
        "SELECT contribution_id,content_sha256,evaluation_id,evaluation_policy_sha256,evaluation_score,"
        "evaluation_receipt_sha256 FROM routing_profile_contributions WHERE profile_id=? AND request_id=?",
        (profile_id, normalized["request_id"]),
    ).fetchone()
    if existing:
        if (
            existing["content_sha256"] != normalized["content_sha256"]
            or existing["evaluation_id"] != row["eval_id"]
            or existing["evaluation_policy_sha256"] != row["policy_sha256"]
            or existing["evaluation_receipt_sha256"] != evaluation_receipt_sha256
        ):
            raise ValueError("request_id already exists for a different payload or evaluation")
        return {
            "status": "accepted",
            "duplicate": True,
            "contribution_id": existing["contribution_id"],
            "profile_id": profile_id,
            "request_id": normalized["request_id"],
            "measurement_status": MEASUREMENT_STATUS,
            "coverage_status": normalized["coverage_status"],
            "daily_energy_rows": len(normalized["daily_energy"]),
            "evaluation_id": row["eval_id"],
            "evaluation_score": existing["evaluation_score"],
            "evaluation_type": "client_reported_calibrated_prediction",
            "evaluation_receipt_sha256": existing["evaluation_receipt_sha256"],
            "delivery_mode": "locked_eval_auto",
        }

    contribution_id = "contribution_" + uuid.uuid4().hex
    conn.execute(
        "INSERT INTO routing_profile_contributions(contribution_id,user_id,profile_id,request_id,agent_system,"
        "coverage_start,coverage_end,coverage_status,capability_tale,measurement_status,consent_attestation,"
        "consent_version,created_at,content_sha256,evaluation_id,evaluation_score,evaluation_policy_sha256,delivery_mode,"
        "evaluated_payload_sha256,evaluation_checks_json,evaluation_receipt_sha256) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            contribution_id,
            user_id,
            profile_id,
            normalized["request_id"],
            normalized["agent_system"],
            normalized["coverage_start"],
            normalized["coverage_end"],
            normalized["coverage_status"],
            normalized["capability_tale"],
            MEASUREMENT_STATUS,
            CONSENT_ATTESTATION,
            CONSENT_VERSION,
            _utc_now(),
            normalized["content_sha256"],
            row["eval_id"],
            score,
            row["policy_sha256"],
            "locked_eval_auto",
            submitted_hash,
            checks_json,
            evaluation_receipt_sha256,
        ),
    )
    conn.executemany(
        "INSERT INTO routing_profile_energy_events(contribution_id,utc_date,category,event_count) VALUES(?,?,?,?)",
        [
            (contribution_id, item["date"], item["category"], item["events"])
            for item in normalized["daily_energy"]
        ],
    )
    return {
        "status": "accepted",
        "duplicate": False,
        "contribution_id": contribution_id,
        "profile_id": profile_id,
        "request_id": normalized["request_id"],
        "measurement_status": MEASUREMENT_STATUS,
        "coverage_status": normalized["coverage_status"],
        "daily_energy_rows": len(normalized["daily_energy"]),
        "evaluation_id": row["eval_id"],
        "evaluation_score": score,
        "evaluation_type": "client_reported_calibrated_prediction",
        "evaluation_policy_sha256": row["policy_sha256"],
        "evaluated_payload_sha256": submitted_hash,
        "evaluation_receipt_sha256": evaluation_receipt_sha256,
        "delivery_mode": "locked_eval_auto",
    }


def process_contribution_action(
    database: Path | str,
    user_id: str,
    profile_id: str,
    arguments: dict[str, Any],
    has_secret: Callable[[str], bool],
) -> dict[str, Any]:
    action = arguments.get("action")
    if not isinstance(action, str) or action not in {
        "create_eval",
        "calibrate_eval",
        "lock_eval",
        "pause_eval",
        "deliver",
    }:
        return _tool_failure(
            "action must be create_eval, calibrate_eval, lock_eval, pause_eval, or deliver"
        )
    conn = sqlite3.connect(database, timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        init_attribution_tables(conn)
        conn.execute("BEGIN IMMEDIATE")
        if action == "create_eval":
            receipt = _create_eval(conn, user_id, profile_id, arguments)
        elif action == "calibrate_eval":
            receipt = _calibrate_eval(conn, user_id, profile_id, arguments)
        elif action == "lock_eval":
            receipt = _lock_eval(conn, user_id, profile_id, arguments)
        elif action == "pause_eval":
            receipt = _pause_eval(conn, user_id, profile_id, arguments)
        else:
            receipt = _deliver(conn, user_id, profile_id, arguments, has_secret)
        conn.commit()
        return _tool_success(receipt)
    except ValueError as exc:
        conn.rollback()
        return _tool_failure(str(exc))
    except sqlite3.IntegrityError:
        conn.rollback()
        return _tool_failure("calibration sample already exists or evaluation state is invalid")
    except sqlite3.Error:
        conn.rollback()
        return _tool_failure("contribution storage is unavailable")
    finally:
        conn.close()


def get_routing_candidates(
    database: Path | str, category: str, start_date: str, end_date: str
) -> list[dict[str, Any]]:
    if not isinstance(category, str) or not CATEGORY_RE.fullmatch(category):
        raise ValueError("category must be a lowercase category slug")
    start = _parse_iso_date(start_date, "start_date")
    end = _parse_iso_date(end_date, "end_date")
    if end < start:
        raise ValueError("end_date must not precede start_date")

    results = []
    with sqlite3.connect(database, timeout=10) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT c.contribution_id,c.profile_id,c.agent_system,c.coverage_start,c.coverage_end,"
            "c.coverage_status,c.capability_tale,c.measurement_status,c.consent_version,c.created_at,"
            "SUM(e.event_count) AS matched_event_count "
            "FROM routing_profile_contributions c JOIN routing_profile_energy_events e "
            "ON e.contribution_id=c.contribution_id "
            "WHERE e.category=? AND e.utc_date BETWEEN ? AND ? "
            "GROUP BY c.contribution_id ORDER BY c.created_at,c.contribution_id",
            (category, start.isoformat(), end.isoformat()),
        ).fetchall()
        for row in rows:
            results.append(
                {
                    "contribution_id": row["contribution_id"],
                    "profile_id": row["profile_id"],
                    "agent_system": row["agent_system"],
                    "coverage_start": row["coverage_start"],
                    "coverage_end": row["coverage_end"],
                    "coverage_status": row["coverage_status"],
                    "capability_tale": row["capability_tale"],
                    "measurement_status": row["measurement_status"],
                    "claim_status": "self_reported_unverified",
                    "category_taxonomy": "self_reported_noncanonical",
                    "consent_version": row["consent_version"],
                    "created_at": row["created_at"],
                    "matched_event_count": row["matched_event_count"],
                    "matched_category": category,
                    "matched_start_date": start.isoformat(),
                    "matched_end_date": end.isoformat(),
                }
            )
    return results
