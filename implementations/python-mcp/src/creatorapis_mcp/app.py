from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import urllib.error
import urllib.request
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, parse_qsl, urlencode, urlparse, urlunparse

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, Response

from .contributions import (
    ATTRIBUTION_PROMPT,
    EVAL_CRITERIA,
    init_attribution_tables,
    process_contribution_action,
)
from .contributions import (
    get_routing_candidates as _get_routing_candidates,
)
from .email_login_page import render_email_signin_page
from .setup_page import setup_page_response

ROOT = Path(__file__).resolve().parents[2]
PUBLIC_ORIGIN = os.environ.get("CREATORAPIS_MCP_PUBLIC_ORIGIN", "http://127.0.0.1:8000").rstrip("/")
PUBLIC_BASE_PATH = os.environ.get("CREATORAPIS_MCP_PUBLIC_BASE_PATH", "").rstrip("/")
PUBLIC_BASE_URL = f"{PUBLIC_ORIGIN}{PUBLIC_BASE_PATH}"
RESOURCE_URI = f"{PUBLIC_BASE_URL}/mcp"
OAUTH_AUTHORIZATION_ENDPOINT = f"{PUBLIC_BASE_URL}/oauth/authorize"
OAUTH_TOKEN_ENDPOINT = f"{PUBLIC_BASE_URL}/oauth/token"
OAUTH_REGISTRATION_ENDPOINT = f"{PUBLIC_BASE_URL}/oauth/register"
OAUTH_SERVER_METADATA_URI = (
    f"{PUBLIC_ORIGIN}/.well-known/oauth-authorization-server{PUBLIC_BASE_PATH}"
)
RESOURCE_METADATA_URI = (
    f"{PUBLIC_ORIGIN}/.well-known/oauth-protected-resource{PUBLIC_BASE_PATH}/mcp"
)
EMAIL_LINK_URI = f"{PUBLIC_BASE_URL}/oauth/email-link"
OAUTH_SCOPES = {
    "creator:tale.write": "Create a calibrated evaluation and deliver passing self-reported projections to your own isolated profile"
}
TOOL_SCOPES = {
    "get_creator_apis_attribution_prompt": "creator:tale.write",
    "submit_creator_apis_attribution_profile": "creator:tale.write",
}
ALLOWED_REDIRECT_URIS = {
    uri.strip()
    for uri in os.environ.get("CREATORAPIS_MCP_ALLOWED_REDIRECT_URIS", "").split(",")
    if uri.strip()
}
EMAIL_RELAY_URL = os.environ.get("CREATORAPIS_MCP_EMAIL_RELAY_URL", "").strip()

TOOLS = [
    {
        "name": "get_creator_apis_attribution_prompt",
        "description": "Get instructions for locally drafting and calibrating a user-specific approval evaluation, then delivering only passing privacy-bounded profile projections. Reads no history itself.",
        "inputSchema": {
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        },
    },
    {
        "name": "submit_creator_apis_attribution_profile",
        "description": "Create, calibrate, lock, or pause an owner-scoped evaluation, or deliver a profile only when a locked evaluation passes. No per-submission approval phrase is used. Evaluation results are client-reported, not independently verified.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": [
                        "create_eval",
                        "calibrate_eval",
                        "lock_eval",
                        "pause_eval",
                        "deliver",
                    ],
                },
                "criteria": {
                    "type": "array",
                    "items": {"type": "string", "enum": list(EVAL_CRITERIA)},
                    "uniqueItems": True,
                },
                "minimum_calibrations": {
                    "type": "integer",
                    "minimum": 3,
                    "maximum": 20,
                },
                "threshold_percent": {"type": "integer", "minimum": 75, "maximum": 100},
                "auto_delivery": {"type": "boolean"},
                "eval_id": {"type": "string", "pattern": "^eval_[a-f0-9]{32}$"},
                "sample_sha256": {"type": "string", "pattern": "^[a-f0-9]{64}$"},
                "evaluator_decision": {
                    "type": "string",
                    "enum": ["pass", "revise", "fail"],
                },
                "human_verdict": {
                    "type": "string",
                    "enum": ["approve", "revise", "reject"],
                },
                "feedback_tags": {
                    "type": "array",
                    "items": {
                        "type": "string",
                        "enum": [
                            "evidence",
                            "privacy",
                            "uncertainty",
                            "energy",
                            "style",
                            "scope",
                        ],
                    },
                    "uniqueItems": True,
                },
                "lock_phrase": {"type": "string"},
                "evaluation_checks": {
                    "type": "object",
                    "properties": {
                        criterion: {"type": "string", "enum": ["pass", "fail"]}
                        for criterion in EVAL_CRITERIA
                    },
                    "additionalProperties": False,
                },
                "evaluated_payload_sha256": {
                    "type": "string",
                    "pattern": "^[a-f0-9]{64}$",
                },
                "request_id": {
                    "type": "string",
                    "description": "Opaque idempotency key for the profile projection.",
                },
                "agent_system": {
                    "type": "string",
                    "description": "Short self-reported AI system label; not identity proof.",
                },
                "coverage_start": {"type": "string", "format": "date"},
                "coverage_end": {"type": "string", "format": "date"},
                "coverage_status": {
                    "type": "string",
                    "enum": ["full", "partial", "unknown"],
                },
                "capability_tale": {
                    "type": "string",
                    "description": "Self-reported summary only; no transcripts, private links, identities, credentials, token counts, or spend.",
                },
                "daily_energy": {
                    "type": "array",
                    "description": "Daily category/event counts only; no task-level records.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "date": {"type": "string", "format": "date"},
                            "category": {
                                "type": "string",
                                "pattern": "^[a-z0-9][a-z0-9_-]{0,39}$",
                            },
                            "events": {"type": "integer", "minimum": 1},
                        },
                        "required": ["date", "category", "events"],
                        "additionalProperties": False,
                    },
                },
            },
            "required": ["action"],
            "additionalProperties": False,
        },
    },
]


def db_path() -> Path:
    return Path(os.environ.get("CREATORAPIS_MCP_DB", str(ROOT / "data" / "artifacts.sqlite3")))


def _normalize_email(email: str) -> str:
    return email.strip().casefold()


def _email_digest(email: str) -> str:
    key = os.environ.get("CREATORAPIS_MCP_IDENTITY_KEY", "").encode("utf-8")
    if len(key) < 32:
        raise RuntimeError("identity_key_not_configured")
    return hmac.new(key, _normalize_email(email).encode("utf-8"), hashlib.sha256).hexdigest()


def _ensure_column(conn: sqlite3.Connection, table: str, name: str, declaration: str) -> None:
    columns = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
    if name not in columns:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {declaration}")


def init_store(path: Path | str | None = None) -> None:
    target = Path(path) if path else db_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(target) as conn:
        conn.execute("""CREATE TABLE IF NOT EXISTS oauth_clients (
            client_id TEXT PRIMARY KEY,
            client_name TEXT NOT NULL,
            redirect_uris_json TEXT NOT NULL,
            grant_types_json TEXT NOT NULL,
            response_types_json TEXT NOT NULL,
            created_at TEXT NOT NULL
        )""")
        conn.execute("""CREATE TABLE IF NOT EXISTS oauth_authorization_requests (
            request_id TEXT PRIMARY KEY,
            client_id TEXT NOT NULL,
            redirect_uri TEXT NOT NULL,
            state TEXT NOT NULL,
            code_challenge TEXT NOT NULL,
            scope TEXT NOT NULL,
            resource TEXT NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            status TEXT NOT NULL
        )""")
        conn.execute("""CREATE TABLE IF NOT EXISTS oauth_email_links (
            token_hash TEXT PRIMARY KEY,
            request_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            consumed_at TEXT
        )""")
        conn.execute("""CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
            code_hash TEXT PRIMARY KEY,
            request_id TEXT NOT NULL,
            client_id TEXT NOT NULL,
            redirect_uri TEXT NOT NULL,
            code_challenge TEXT NOT NULL,
            scope TEXT NOT NULL,
            resource TEXT NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            consumed_at TEXT
        )""")
        conn.execute("""CREATE TABLE IF NOT EXISTS oauth_tokens (
            token_hash TEXT PRIMARY KEY,
            client_id TEXT NOT NULL,
            token_type TEXT NOT NULL CHECK(token_type IN ('access','refresh')),
            scope TEXT NOT NULL,
            resource TEXT NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            revoked_at TEXT
        )""")
        conn.execute("""CREATE TABLE IF NOT EXISTS oauth_users (
            user_id TEXT PRIMARY KEY,
            email_digest TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL,
            verified_at TEXT,
            disabled_at TEXT
        )""")
        conn.execute("""CREATE TABLE IF NOT EXISTS creator_profiles (
            profile_id TEXT PRIMARY KEY,
            owner_user_id TEXT NOT NULL,
            display_name TEXT NOT NULL,
            created_at TEXT NOT NULL
        )""")
        conn.execute("""CREATE TABLE IF NOT EXISTS profile_memberships (
            user_id TEXT NOT NULL,
            profile_id TEXT NOT NULL,
            scopes_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            revoked_at TEXT,
            PRIMARY KEY(user_id, profile_id)
        )""")
        _ensure_column(conn, "oauth_authorization_requests", "email_digest", "TEXT")
        _ensure_column(conn, "oauth_authorization_requests", "user_id", "TEXT")
        _ensure_column(conn, "oauth_authorization_requests", "profile_id", "TEXT")
        _ensure_column(conn, "oauth_authorization_codes", "user_id", "TEXT NOT NULL DEFAULT ''")
        _ensure_column(conn, "oauth_authorization_codes", "profile_id", "TEXT NOT NULL DEFAULT ''")
        _ensure_column(conn, "oauth_tokens", "user_id", "TEXT NOT NULL DEFAULT ''")
        _ensure_column(conn, "oauth_tokens", "profile_id", "TEXT NOT NULL DEFAULT ''")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_oauth_requests_expiry ON oauth_authorization_requests(expires_at, status)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_oauth_tokens_client ON oauth_tokens(client_id, token_type, expires_at)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_profile_memberships_user ON profile_memberships(user_id, revoked_at)"
        )
        init_attribution_tables(conn)


EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _allowed_auth_emails() -> set[str]:
    configured = os.environ.get(
        "CREATORAPIS_MCP_AUTH_EMAILS", os.environ.get("CREATORAPIS_MCP_AUTH_EMAIL", "")
    )
    return {
        _normalize_email(item)
        for item in configured.split(",")
        if item.strip() and EMAIL_RE.fullmatch(item.strip())
    }


def _open_auth_registration_enabled() -> bool:
    return os.environ.get("CREATORAPIS_MCP_OPEN_REGISTRATION", "").strip().casefold() in {
        "1",
        "true",
        "yes",
        "on",
    }


def _auth_email_allowed(email: str) -> bool:
    normalized = _normalize_email(email)
    return bool(EMAIL_RE.fullmatch(normalized)) and (
        _open_auth_registration_enabled() or normalized in _allowed_auth_emails()
    )


def _ensure_auth_account(conn: sqlite3.Connection, email_digest: str) -> tuple[str, str | None]:
    row = conn.execute(
        "SELECT user_id, disabled_at FROM oauth_users WHERE email_digest=?",
        (email_digest,),
    ).fetchone()
    if row and row["disabled_at"]:
        raise PermissionError("account_disabled")
    if not row:
        user_id = "user_" + uuid.uuid4().hex
        stamp = _utc_now()
        conn.execute(
            "INSERT INTO oauth_users(user_id,email_digest,created_at,verified_at,disabled_at) VALUES(?,?,?,NULL,NULL)",
            (user_id, email_digest, stamp),
        )
        profile_id = "profile_" + uuid.uuid4().hex
        conn.execute(
            "INSERT INTO creator_profiles(profile_id,owner_user_id,display_name,created_at) VALUES(?,?,?,?)",
            (profile_id, user_id, "Creator profile", stamp),
        )
        conn.execute(
            "INSERT INTO profile_memberships(user_id,profile_id,scopes_json,created_at,revoked_at) VALUES(?,?,?,?,NULL)",
            (user_id, profile_id, json.dumps(["creator:tale.write"]), stamp),
        )
        return user_id, profile_id
    memberships = conn.execute(
        "SELECT profile_id FROM profile_memberships WHERE user_id=? AND revoked_at IS NULL ORDER BY created_at, profile_id",
        (row["user_id"],),
    ).fetchall()
    if not memberships:
        raise PermissionError("account_has_no_profiles")
    return row["user_id"], memberships[0]["profile_id"] if len(memberships) == 1 else None


def _active_profile_scopes(
    conn: sqlite3.Connection, user_id: str, profile_id: str
) -> set[str] | None:
    return _effective_profile_scopes(conn, user_id, profile_id)


def _effective_profile_scopes(
    conn: sqlite3.Connection, user_id: str, profile_id: str
) -> set[str] | None:
    row = conn.execute(
        "SELECT m.scopes_json,u.verified_at,u.disabled_at FROM profile_memberships m "
        "JOIN oauth_users u ON u.user_id=m.user_id "
        "WHERE m.user_id=? AND m.profile_id=? AND m.revoked_at IS NULL",
        (user_id, profile_id),
    ).fetchone()
    if not row or row["disabled_at"] or not row["verified_at"]:
        return None
    try:
        scopes = set(json.loads(row["scopes_json"]))
    except (TypeError, json.JSONDecodeError):
        return None
    return scopes if scopes.issubset(OAUTH_SCOPES) else None


def _consent_scopes(
    conn: sqlite3.Connection, user_id: str, profile_id: str, requested_scopes: set[str]
) -> set[str]:
    row = conn.execute(
        "SELECT m.scopes_json,u.disabled_at FROM profile_memberships m "
        "JOIN oauth_users u ON u.user_id=m.user_id "
        "WHERE m.user_id=? AND m.profile_id=? AND m.revoked_at IS NULL",
        (user_id, profile_id),
    ).fetchone()
    if not row or row["disabled_at"]:
        return set()
    try:
        available = set(json.loads(row["scopes_json"]))
    except (TypeError, json.JSONDecodeError):
        return set()
    return requested_scopes & available if available.issubset(OAUTH_SCOPES) else set()


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_store()
    yield


app = FastAPI(title="Creator APIs MCP", docs_url=None, redoc_url=None, lifespan=lifespan)


def _rpc_error(request_id: Any, code: int, message: str) -> JSONResponse:
    return JSONResponse(
        {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {"code": code, "message": message},
        }
    )


def _tool_error(message: str) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": message}], "isError": True}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _new_opaque_token() -> str:
    return secrets.token_urlsafe(32)


@dataclass(frozen=True)
class AuthContext:
    user_id: str
    profile_id: str
    scopes: frozenset[str]
    owns_profile: bool = False


def _authorized_context(request: Request) -> AuthContext | None:
    header = request.headers.get("authorization", "")
    scheme, _, supplied = header.partition(" ")
    if scheme.lower() != "bearer" or not supplied.strip():
        return None
    init_store()
    with sqlite3.connect(db_path(), timeout=5) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT t.scope,t.resource,t.expires_at,t.revoked_at,t.user_id,t.profile_id "
            "FROM oauth_tokens t JOIN profile_memberships m ON m.user_id=t.user_id AND m.profile_id=t.profile_id "
            "WHERE t.token_hash=? AND t.token_type='access' AND m.revoked_at IS NULL",
            (_digest(supplied.strip()),),
        ).fetchone()
        if (
            not row
            or row["revoked_at"]
            or row["resource"] != RESOURCE_URI
            or row["expires_at"] <= _utc_now()
        ):
            return None
        scopes = _effective_profile_scopes(conn, row["user_id"], row["profile_id"])
        token_scopes = set(row["scope"].split())
        if (
            not scopes
            or not token_scopes
            or not token_scopes.issubset(scopes)
            or not token_scopes.issubset(OAUTH_SCOPES)
        ):
            return None
        owner = conn.execute(
            "SELECT owner_user_id FROM creator_profiles WHERE profile_id=?",
            (row["profile_id"],),
        ).fetchone()
        if not owner or owner["owner_user_id"] != row["user_id"]:
            return None
        return AuthContext(row["user_id"], row["profile_id"], frozenset(token_scopes), True)


def _unauthorized_response() -> JSONResponse:
    return JSONResponse(
        {"detail": "Unauthorized"},
        status_code=401,
        headers={"WWW-Authenticate": f'Bearer resource_metadata="{RESOURCE_METADATA_URI}"'},
    )


SECRET_PATTERNS = [
    re.compile(r"(?:api[_ -]?key|secret|password|passwd)\s*[:=]\s*['\"]?[^\s'\"]+", re.I),
    re.compile(r"\b(?:sk|pk|ghp|github_pat|xox[baprs])-[-_A-Za-z0-9]{8,}\b", re.I),
    re.compile(r"\b(?:bearer|token)\s+[A-Za-z0-9._~+/=-]{12,}", re.I),
    re.compile(r"-----BEGIN [^-]*PRIVATE KEY-----", re.I),
]


def _has_secret(text: str) -> bool:
    return any(pattern.search(text) for pattern in SECRET_PATTERNS)


def _submit_attribution_profile(
    arguments: dict[str, Any], user_id: str, profile_id: str
) -> dict[str, Any]:
    init_store()
    conn = sqlite3.connect(db_path(), timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        owner = conn.execute(
            "SELECT p.owner_user_id,u.verified_at,u.disabled_at FROM creator_profiles p "
            "JOIN oauth_users u ON u.user_id=p.owner_user_id WHERE p.profile_id=?",
            (profile_id,),
        ).fetchone()
        scopes = _effective_profile_scopes(conn, user_id, profile_id)
        if (
            not owner
            or owner["owner_user_id"] != user_id
            or not owner["verified_at"]
            or owner["disabled_at"]
            or not scopes
            or "creator:tale.write" not in scopes
        ):
            return _tool_error(
                "a verified owner profile with active contribution scope is required"
            )
    finally:
        conn.close()
    return process_contribution_action(db_path(), user_id, profile_id, arguments, _has_secret)


def _attribution_prompt_for_profile(user_id: str, profile_id: str) -> str:
    init_store()
    with sqlite3.connect(db_path(), timeout=10) as conn:
        conn.row_factory = sqlite3.Row
        evaluation = conn.execute(
            "SELECT * FROM contribution_evaluations WHERE user_id=? AND profile_id=? ORDER BY version DESC LIMIT 1",
            (user_id, profile_id),
        ).fetchone()
        if evaluation is None:
            state = "No evaluation exists for this profile. Propose and calibrate one before any delivery."
        else:
            count, false_passes = conn.execute(
                "SELECT COUNT(*),SUM(CASE WHEN evaluator_decision='pass' AND human_verdict!='approve' THEN 1 ELSE 0 END) "
                "FROM contribution_eval_calibrations WHERE eval_id=?",
                (evaluation["eval_id"],),
            ).fetchone()
            state = (
                f"Current eval_id: {evaluation['eval_id']}\n"
                f"State: {evaluation['state']}\n"
                f"Version: {evaluation['version']}\n"
                f"Criteria: {', '.join(json.loads(evaluation['criteria_json']))}\n"
                f"Threshold: {evaluation['threshold_percent']}%\n"
                f"Calibration examples: {count}/{evaluation['minimum_calibrations']}\n"
                f"Observed false passes: {false_passes or 0}\n"
                f"Auto-delivery: {'enabled after lock' if evaluation['auto_delivery'] else 'disabled'}\n"
                f"Policy SHA-256: {evaluation['policy_sha256']}"
            )
    return (
        f"{ATTRIBUTION_PROMPT}\n\n"
        "Current profile evaluation state (only for the authenticated owner's profile):\n"
        f"{state}\n"
        "Evaluation decisions and calibration labels are client-reported, not independent ground truth. "
        "A locked evaluation predicts the user's likely acceptance; it cannot guarantee it."
    )


def get_routing_candidates(category: str, start_date: str, end_date: str) -> list[dict[str, Any]]:
    """Internal-only lookup over owner-scoped profiles; not exposed as an MCP tool or HTTP route."""
    init_store()
    return _get_routing_candidates(db_path(), category, start_date, end_date)


async def _handle(request: Request, payload: dict[str, Any]) -> Response:
    auth = _authorized_context(request)
    if auth is None:
        return _unauthorized_response()
    request_id = payload.get("id")
    method = payload.get("method")
    if method == "notifications/initialized":
        return Response(status_code=204)
    if payload.get("jsonrpc") != "2.0" or not isinstance(method, str):
        return _rpc_error(request_id, -32600, "Invalid Request")
    if method == "initialize":
        return JSONResponse(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "protocolVersion": "2025-03-26",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "creator-apis-mcp", "version": "0.1.0"},
                },
            }
        )
    if method == "tools/list":
        return JSONResponse({"jsonrpc": "2.0", "id": request_id, "result": {"tools": TOOLS}})
    if method != "tools/call":
        return _rpc_error(request_id, -32601, "Method not found")
    params = payload.get("params")
    if not isinstance(params, dict) or not isinstance(params.get("name"), str):
        return _rpc_error(request_id, -32602, "Invalid tools/call params")
    name = params["name"]
    arguments = params.get("arguments", {})
    if not isinstance(arguments, dict):
        return _rpc_error(request_id, -32602, "arguments must be an object")
    required_scope = TOOL_SCOPES.get(name)
    if required_scope is None:
        return _rpc_error(request_id, -32602, "Unknown tool")
    if required_scope not in auth.scopes:
        return _rpc_error(request_id, -32003, f"Insufficient scope: {required_scope}")
    if not auth.owns_profile:
        return _rpc_error(
            request_id,
            -32004,
            "Contribution tools are available only for your own profile",
        )
    if name == "get_creator_apis_attribution_prompt":
        result = (
            _tool_error("prompt tool accepts no arguments")
            if arguments
            else {
                "content": [
                    {
                        "type": "text",
                        "text": _attribution_prompt_for_profile(auth.user_id, auth.profile_id),
                    }
                ]
            }
        )
    elif name == "submit_creator_apis_attribution_profile":
        result = _submit_attribution_profile(arguments, auth.user_id, auth.profile_id)
    else:
        return _rpc_error(request_id, -32602, "Unknown tool")
    return JSONResponse({"jsonrpc": "2.0", "id": request_id, "result": result})


def _send_auth_email(magic_link: str, request_id: str, recipient: str) -> dict[str, Any]:
    relay_token = os.environ.get("CREATORAPIS_MCP_EMAIL_RELAY_TOKEN", "").strip()
    if not relay_token:
        raise RuntimeError("email_relay_not_configured")
    payload = json.dumps(
        {
            "magic_link": magic_link,
            "idempotency_key": request_id,
            "recipient": recipient,
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        EMAIL_RELAY_URL,
        data=payload,
        headers={
            "Authorization": f"Bearer {relay_token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=8) as response:
            result = json.loads(response.read(4096).decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"email_relay_http_{exc.code}") from None
    except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError):
        raise RuntimeError("email_relay_unavailable") from None
    if not isinstance(result, dict) or result.get("status") != "accepted":
        raise RuntimeError("email_relay_not_accepted")
    return result


def _json_error(status: int, error: str) -> JSONResponse:
    return JSONResponse({"error": error}, status_code=status, headers={"Cache-Control": "no-store"})


async def _read_json_limited(request: Request, limit: int = 8192) -> Any | None:
    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type != "application/json":
        return None
    raw = await request.body()
    if not raw or len(raw) > limit:
        return None
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None


def _issue_token(
    conn: sqlite3.Connection,
    client_id: str,
    token_type: str,
    scope: str,
    resource: str,
    expires_at: str,
    user_id: str,
    profile_id: str,
) -> str:
    token = _new_opaque_token()
    conn.execute(
        "INSERT INTO oauth_tokens(token_hash,client_id,token_type,scope,resource,created_at,expires_at,revoked_at,user_id,profile_id) VALUES(?,?,?,?,?,?,?,NULL,?,?)",
        (
            _digest(token),
            client_id,
            token_type,
            scope,
            resource,
            _utc_now(),
            expires_at,
            user_id,
            profile_id,
        ),
    )
    return token


@app.get("/.well-known/oauth-authorization-server")
def oauth_authorization_server_metadata() -> dict[str, Any]:
    return {
        "issuer": PUBLIC_BASE_URL,
        "authorization_endpoint": OAUTH_AUTHORIZATION_ENDPOINT,
        "token_endpoint": OAUTH_TOKEN_ENDPOINT,
        "registration_endpoint": OAUTH_REGISTRATION_ENDPOINT,
        "revocation_endpoint": f"{PUBLIC_BASE_URL}/oauth/revoke",
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none"],
        "scopes_supported": list(OAUTH_SCOPES),
    }


@app.get("/.well-known/oauth-protected-resource")
@app.get("/.well-known/oauth-protected-resource/mcp")
def oauth_protected_resource_metadata() -> dict[str, Any]:
    return {
        "resource": RESOURCE_URI,
        "authorization_servers": [PUBLIC_BASE_URL],
        "bearer_methods_supported": ["header"],
        "scopes_supported": list(OAUTH_SCOPES),
    }


@app.post("/oauth/register")
async def oauth_register(request: Request) -> Response:
    payload = await _read_json_limited(request)
    if not isinstance(payload, dict):
        return _json_error(400, "invalid_client_metadata")
    redirects = payload.get("redirect_uris")
    if (
        not isinstance(redirects, list)
        or not 1 <= len(redirects) <= 2
        or any(not isinstance(uri, str) or uri not in ALLOWED_REDIRECT_URIS for uri in redirects)
        or len(set(redirects)) != len(redirects)
    ):
        return _json_error(400, "invalid_redirect_uri")
    if payload.get("token_endpoint_auth_method", "none") != "none":
        return _json_error(400, "unsupported_token_endpoint_auth_method")
    requested_grants = payload.get("grant_types", ["authorization_code"])
    requested_responses = payload.get("response_types", ["code"])
    supported_grants = {"authorization_code", "refresh_token"}
    if (
        not isinstance(requested_grants, list)
        or not requested_grants
        or any(not isinstance(grant, str) for grant in requested_grants)
        or len(set(requested_grants)) != len(requested_grants)
        or not set(requested_grants).issubset(supported_grants)
        or "authorization_code" not in requested_grants
        or not isinstance(requested_responses, list)
        or requested_responses != ["code"]
    ):
        return _json_error(400, "unsupported_client_metadata")
    requested_name = payload.get("client_name", "AI client")
    if not isinstance(requested_name, str):
        return _json_error(400, "invalid_client_metadata")
    name = requested_name[:128].strip() or "AI client"
    client_id = "client_" + secrets.token_urlsafe(24)
    init_store()
    with sqlite3.connect(db_path(), timeout=10) as conn:
        conn.execute(
            "INSERT INTO oauth_clients(client_id,client_name,redirect_uris_json,grant_types_json,response_types_json,created_at) VALUES(?,?,?,?,?,?)",
            (
                client_id,
                name,
                json.dumps(redirects),
                json.dumps(requested_grants),
                json.dumps(requested_responses),
                _utc_now(),
            ),
        )
    return JSONResponse(
        {
            "client_id": client_id,
            "client_id_issued_at": int(datetime.now(timezone.utc).timestamp()),
            "client_name": name,
            "redirect_uris": redirects,
            "grant_types": requested_grants,
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
        },
        status_code=201,
        headers={"Cache-Control": "no-store"},
    )


@app.get("/oauth/authorize")
async def oauth_authorize(request: Request) -> Response:
    query = request.query_params
    client_id = query.get("client_id", "")
    redirect_uri = query.get("redirect_uri", "")
    state = query.get("state", "")
    challenge = query.get("code_challenge", "")
    method = query.get("code_challenge_method", "")
    resource = query.get("resource", RESOURCE_URI)
    response_type = query.get("response_type", "")
    requested_scope_text = query.get("scope", "")
    requested_scopes = requested_scope_text.split()
    if not requested_scopes:
        requested_scopes = list(OAUTH_SCOPES)
    if (
        not client_id
        or not redirect_uri
        or response_type != "code"
        or not state
        or len(state) > 512
        or method != "S256"
        or not re.fullmatch(r"[A-Za-z0-9_-]{43,128}", challenge)
        or resource != RESOURCE_URI
        or len(requested_scope_text) > 512
        or len(requested_scopes) > len(OAUTH_SCOPES)
        or len(set(requested_scopes)) != len(requested_scopes)
        or any(scope not in OAUTH_SCOPES for scope in requested_scopes)
    ):
        return _json_error(400, "invalid_authorization_request")
    init_store()
    with sqlite3.connect(db_path(), timeout=10) as conn:
        row = conn.execute(
            "SELECT redirect_uris_json FROM oauth_clients WHERE client_id=?",
            (client_id,),
        ).fetchone()
    if not row or redirect_uri not in json.loads(row[0]):
        return _json_error(400, "invalid_client_or_redirect_uri")

    request_id = uuid.uuid4().hex
    stamp = _utc_now()
    expires = (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat()
    scope = " ".join(requested_scopes)
    with sqlite3.connect(db_path(), timeout=10) as conn:
        conn.execute(
            "INSERT INTO oauth_authorization_requests(request_id,client_id,redirect_uri,state,code_challenge,scope,resource,created_at,expires_at,status) VALUES(?,?,?,?,?,?,?,?,?,?)",
            (
                request_id,
                client_id,
                redirect_uri,
                state,
                challenge,
                scope,
                resource,
                stamp,
                expires,
                "awaiting_email",
            ),
        )
    nonce = secrets.token_urlsafe(18)
    html = render_email_signin_page(
        request_id, nonce, PUBLIC_BASE_PATH, _open_auth_registration_enabled()
    )
    return HTMLResponse(
        html,
        headers={
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": f"default-src 'none'; style-src 'nonce-{nonce}'; script-src 'nonce-{nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        },
    )


@app.post("/oauth/email-request")
async def oauth_email_request(request: Request) -> Response:
    if request.headers.get("origin") != PUBLIC_ORIGIN:
        return _json_error(403, "origin_not_allowed")
    payload = await _read_json_limited(request, limit=2048)
    if not isinstance(payload, dict) or set(payload) != {"request_id", "email"}:
        return _json_error(400, "invalid_request")
    request_id = payload.get("request_id")
    email = payload.get("email")
    if not isinstance(request_id, str) or not re.fullmatch(r"[a-f0-9]{32}", request_id):
        return _json_error(400, "invalid_request")
    if not isinstance(email, str) or len(email) > 254 or not EMAIL_RE.fullmatch(email.strip()):
        return _json_error(400, "invalid_request")
    email = _normalize_email(email)
    allowed = _allowed_auth_emails()
    open_registration = _open_auth_registration_enabled()
    if not open_registration and not allowed:
        return _json_error(503, "email_login_unavailable")
    if not _auth_email_allowed(email):
        return _json_error(403, "recipient_not_allowed")
    if not os.environ.get("CREATORAPIS_MCP_EMAIL_RELAY_TOKEN", "").strip():
        return _json_error(503, "email_login_unavailable")
    try:
        email_digest = _email_digest(email)
    except RuntimeError:
        return _json_error(503, "email_login_unavailable")

    init_store()
    magic_token = _new_opaque_token()
    conn = sqlite3.connect(db_path(), timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("BEGIN IMMEDIATE")
        auth_request = conn.execute(
            "SELECT status, expires_at FROM oauth_authorization_requests WHERE request_id=?",
            (request_id,),
        ).fetchone()
        if (
            not auth_request
            or auth_request["status"] != "awaiting_email"
            or auth_request["expires_at"] <= _utc_now()
        ):
            conn.rollback()
            return _json_error(400, "invalid_authorization_request")
        try:
            user_id, profile_id = _ensure_auth_account(conn, email_digest)
        except PermissionError:
            conn.rollback()
            return _json_error(403, "recipient_not_allowed")
        stamp = _utc_now()
        conn.execute(
            "UPDATE oauth_authorization_requests SET email_digest=?,user_id=?,profile_id=?,status='pending' WHERE request_id=?",
            (email_digest, user_id, profile_id, request_id),
        )
        conn.execute(
            "INSERT INTO oauth_email_links(token_hash,request_id,created_at,expires_at,consumed_at) VALUES(?,?,?,?,NULL)",
            (_digest(magic_token), request_id, stamp, auth_request["expires_at"]),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    link = f"{EMAIL_LINK_URI}#{magic_token}"
    try:
        await asyncio.to_thread(_send_auth_email, link, request_id, email)
    except RuntimeError:
        with sqlite3.connect(db_path(), timeout=10) as conn:
            conn.execute(
                "UPDATE oauth_authorization_requests SET status='email_unconfirmed' WHERE request_id=? AND status='pending'",
                (request_id,),
            )
            conn.execute(
                "UPDATE oauth_email_links SET consumed_at=? WHERE request_id=? AND consumed_at IS NULL",
                (_utc_now(), request_id),
            )
        return _json_error(503, "email_login_unavailable")
    return JSONResponse(
        {"status": "accepted"},
        headers={
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
        },
    )


@app.get("/oauth/email-link")
def oauth_email_link_page() -> Response:
    nonce = secrets.token_urlsafe(18)
    html = f"""<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Authorize AI client</title><body><main><h1>Review Creator APIs access</h1><p>AI client is requesting access to a Creator APIs profile. Choose an authorized profile and review the exact permissions below; this page does not grant access until you press Authorize.</p><select id=\"profile\" hidden aria-label=\"Authorized profile\"></select><ul id=\"permissions\"><li>Loading requested permissions…</li></ul><button id=\"authorize\" type=\"button\" disabled>Authorize AI client</button><button id=\"deny\" type=\"button\" disabled>Do not authorize</button><p id=\"status\" role=\"status\"></p></main><script nonce=\"{nonce}\">(function(){{let token=location.hash.slice(1);history.replaceState(null,\"\",location.pathname);const status=document.getElementById(\"status\");const allow=document.getElementById(\"authorize\");const deny=document.getElementById(\"deny\");const list=document.getElementById(\"permissions\");const profile=document.getElementById(\"profile\");let profileId=\"\";const loadPermissions=async()=>{{const r=await fetch(\"{PUBLIC_BASE_PATH}/oauth/email-link/details\",{{method:\"POST\",headers:{{\"Content-Type\":\"application/json\"}},body:JSON.stringify({{token:token,profile_id:profileId}}),referrerPolicy:\"no-referrer\"}});const data=await r.json();if(!r.ok)throw new Error(\"This profile is not authorized for the requested permissions.\");list.replaceChildren(...data.permissions.map(p=>{{const li=document.createElement(\"li\");li.textContent=p;return li;}}));}};profile.addEventListener(\"change\",async()=>{{profileId=profile.value;allow.disabled=true;try{{await loadPermissions();allow.disabled=false;}}catch(e){{status.textContent=e.message;}}}});if(!/^[A-Za-z0-9_-]{{43,128}}$/.test(token)){{status.textContent=\"This link is invalid or expired. Request a new one.\";return;}}fetch(\"{PUBLIC_BASE_PATH}/oauth/email-link/details\",{{method:\"POST\",headers:{{\"Content-Type\":\"application/json\"}},body:JSON.stringify({{token:token}}),referrerPolicy:\"no-referrer\"}}).then(async r=>{{const data=await r.json();if(!r.ok)throw new Error(data.error===\"no_authorized_profile\"?\"No profile has the requested permissions. Ask the profile owner to grant them or request fewer permissions.\":data.error===\"profile_not_authorized\"?\"This profile is not authorized for the requested permissions.\":data.error===\"invalid_or_expired_link\"?\"This link is invalid, expired, or already used. Request a new one.\":\"The link could not be verified. Try again or request a new one.\");profile.replaceChildren(...data.profiles.map(p=>{{const option=document.createElement(\"option\");option.value=p.id;option.textContent=p.name;return option;}}));profileId=data.selected_profile_id||data.profiles[0].id;profile.value=profileId;profile.hidden=data.profiles.length<2;await loadPermissions();allow.disabled=false;deny.disabled=false;}}).catch(e=>{{status.textContent=e.message;}});allow.addEventListener(\"click\",async()=>{{allow.disabled=true;deny.disabled=true;status.textContent=\"Authorizing…\";try{{const r=await fetch(\"{PUBLIC_BASE_PATH}/oauth/email-link/consume\",{{method:\"POST\",headers:{{\"Content-Type\":\"application/json\"}},body:JSON.stringify({{token:token,decision:\"approve\",profile_id:profileId}}),referrerPolicy:\"no-referrer\"}});const data=await r.json();token=\"\";if(!r.ok)throw new Error(\"Authorization could not be completed. Request a new link.\");window.location.replace(data.redirect_url);}}catch(e){{status.textContent=e.message;}}}});deny.addEventListener(\"click\",async()=>{{allow.disabled=true;deny.disabled=true;try{{await fetch(\"{PUBLIC_BASE_PATH}/oauth/email-link/consume\",{{method:\"POST\",headers:{{\"Content-Type\":\"application/json\"}},body:JSON.stringify({{token:token,decision:\"deny\"}}),referrerPolicy:\"no-referrer\"}});token=\"\";status.textContent=\"Access was not authorized. You may close this page.\";}}catch(e){{status.textContent=\"Could not record the denial. You may close this page.\";}}}});}})();</script></body></html>"""
    return HTMLResponse(
        html,
        headers={
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": f"default-src 'none'; script-src 'nonce-{nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        },
    )


@app.post("/oauth/email-link/details")
async def oauth_email_link_details(request: Request) -> Response:
    if request.headers.get("origin") != PUBLIC_ORIGIN:
        return _json_error(403, "origin_not_allowed")
    payload = await _read_json_limited(request, limit=2048)
    if not isinstance(payload, dict) or set(payload) - {"token", "profile_id"}:
        return _json_error(400, "invalid_request")
    token = payload.get("token")
    requested_profile = payload.get("profile_id")
    if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43,128}", token):
        return _json_error(400, "invalid_link")
    if requested_profile is not None and (
        not isinstance(requested_profile, str) or len(requested_profile) > 128
    ):
        return _json_error(400, "invalid_request")
    init_store()
    with sqlite3.connect(db_path(), timeout=10) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT r.scope, r.user_id, r.profile_id, r.expires_at, r.status, l.consumed_at, u.disabled_at "
            "FROM oauth_email_links l JOIN oauth_authorization_requests r USING(request_id) "
            "JOIN oauth_users u ON u.user_id=r.user_id WHERE l.token_hash=?",
            (_digest(token),),
        ).fetchone()
        if (
            not row
            or row["consumed_at"]
            or row["status"] != "pending"
            or row["expires_at"] <= _utc_now()
            or row["disabled_at"]
        ):
            return _json_error(400, "invalid_or_expired_link")
        requested_scopes = set(row["scope"].split())
        memberships = conn.execute(
            "SELECT p.profile_id, p.display_name FROM profile_memberships m "
            "JOIN creator_profiles p ON p.profile_id=m.profile_id "
            "WHERE m.user_id=? AND m.revoked_at IS NULL ORDER BY m.created_at,p.profile_id",
            (row["user_id"],),
        ).fetchall()
        eligible = []
        for membership in memberships:
            granted = _consent_scopes(
                conn, row["user_id"], membership["profile_id"], requested_scopes
            )
            if granted:
                eligible.append(
                    {
                        "id": membership["profile_id"],
                        "name": membership["display_name"],
                        "scopes": sorted(granted),
                    }
                )
    selected = requested_profile or row["profile_id"]
    eligible_by_id = {profile["id"]: profile for profile in eligible}
    if selected and selected not in eligible_by_id:
        return _json_error(403, "no_authorized_profile")
    if not selected and len(eligible) == 1:
        selected = eligible[0]["id"]
    if not eligible:
        return _json_error(403, "no_authorized_profile")
    approved_scopes = eligible_by_id[selected]["scopes"] if selected else []
    return JSONResponse(
        {
            "profiles": [{"id": item["id"], "name": item["name"]} for item in eligible],
            "selected_profile_id": selected,
            "permissions": [OAUTH_SCOPES[scope] for scope in approved_scopes],
            "requested_permissions": [OAUTH_SCOPES[scope] for scope in sorted(requested_scopes)],
            "granted_scopes": approved_scopes,
        },
        headers={"Cache-Control": "no-store"},
    )


@app.post("/oauth/email-link/consume")
async def oauth_email_link_consume(request: Request) -> Response:
    if request.headers.get("origin") != PUBLIC_ORIGIN:
        return _json_error(403, "origin_not_allowed")
    payload = await _read_json_limited(request, limit=2048)
    if not isinstance(payload, dict) or set(payload) - {
        "token",
        "decision",
        "profile_id",
    }:
        return _json_error(400, "invalid_request")
    token = payload.get("token")
    decision = payload.get("decision", "approve")
    requested_profile = payload.get("profile_id")
    if (
        not isinstance(token, str)
        or not re.fullmatch(r"[A-Za-z0-9_-]{43,128}", token)
        or decision not in {"approve", "deny"}
    ):
        return _json_error(400, "invalid_link")
    if requested_profile is not None and (
        not isinstance(requested_profile, str) or len(requested_profile) > 128
    ):
        return _json_error(400, "invalid_request")
    init_store()
    conn = sqlite3.connect(db_path(), timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT l.request_id, l.expires_at AS link_expires, l.consumed_at, r.client_id, r.redirect_uri, r.state, "
            "r.code_challenge, r.scope, r.resource, r.expires_at AS request_expires, r.status, r.user_id, r.profile_id, "
            "u.disabled_at FROM oauth_email_links l JOIN oauth_authorization_requests r USING(request_id) "
            "JOIN oauth_users u ON u.user_id=r.user_id WHERE l.token_hash=?",
            (_digest(token),),
        ).fetchone()
        if (
            not row
            or row["consumed_at"]
            or row["status"] != "pending"
            or row["disabled_at"]
            or row["link_expires"] <= _utc_now()
            or row["request_expires"] <= _utc_now()
        ):
            conn.rollback()
            return _json_error(400, "invalid_or_expired_link")
        stamp = _utc_now()
        if decision == "deny":
            conn.execute(
                "UPDATE oauth_email_links SET consumed_at=? WHERE token_hash=?",
                (stamp, _digest(token)),
            )
            conn.execute(
                "UPDATE oauth_authorization_requests SET status='denied' WHERE request_id=?",
                (row["request_id"],),
            )
            conn.commit()
            return JSONResponse({"status": "denied"}, headers={"Cache-Control": "no-store"})

        requested_scopes = set(row["scope"].split())
        memberships = conn.execute(
            "SELECT m.profile_id FROM profile_memberships m WHERE m.user_id=? AND m.revoked_at IS NULL",
            (row["user_id"],),
        ).fetchall()
        eligible_profiles: dict[str, list[str]] = {}
        for membership in memberships:
            granted = _consent_scopes(
                conn, row["user_id"], membership["profile_id"], requested_scopes
            )
            if granted:
                eligible_profiles[membership["profile_id"]] = sorted(granted)
        profile_id = requested_profile or row["profile_id"]
        if profile_id is None and len(eligible_profiles) == 1:
            profile_id = next(iter(eligible_profiles))
        if profile_id is None:
            conn.rollback()
            return _json_error(400, "profile_selection_required")
        if profile_id not in eligible_profiles:
            conn.rollback()
            return _json_error(403, "no_authorized_profile")
        approved_scope = " ".join(eligible_profiles[profile_id])

        code = _new_opaque_token()
        code_expires = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()
        conn.execute(
            "INSERT INTO oauth_authorization_codes(code_hash,request_id,client_id,redirect_uri,code_challenge,scope,resource,created_at,expires_at,consumed_at,user_id,profile_id) VALUES(?,?,?,?,?,?,?,?,?,NULL,?,?)",
            (
                _digest(code),
                row["request_id"],
                row["client_id"],
                row["redirect_uri"],
                row["code_challenge"],
                approved_scope,
                row["resource"],
                stamp,
                code_expires,
                row["user_id"],
                profile_id,
            ),
        )
        conn.execute(
            "UPDATE oauth_users SET verified_at=COALESCE(verified_at,?) WHERE user_id=?",
            (stamp, row["user_id"]),
        )
        conn.execute(
            "UPDATE oauth_authorization_requests SET status='authorized',profile_id=? WHERE request_id=?",
            (profile_id, row["request_id"]),
        )
        conn.execute(
            "UPDATE oauth_email_links SET consumed_at=? WHERE token_hash=?",
            (stamp, _digest(token)),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    parsed = urlparse(row["redirect_uri"])
    query = parse_qsl(parsed.query, keep_blank_values=True)
    query.extend((("code", code), ("state", row["state"])))
    redirect_url = urlunparse(
        (
            parsed.scheme,
            parsed.netloc,
            parsed.path,
            parsed.params,
            urlencode(query),
            parsed.fragment,
        )
    )
    return JSONResponse({"redirect_url": redirect_url}, headers={"Cache-Control": "no-store"})


async def _form_data(request: Request) -> dict[str, str] | None:
    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type != "application/x-www-form-urlencoded":
        return None
    raw = await request.body()
    if len(raw) > 8192:
        return None
    try:
        parsed = parse_qs(raw.decode("utf-8"), keep_blank_values=True)
    except (UnicodeDecodeError, ValueError):
        return None
    if any(len(values) != 1 for values in parsed.values()):
        return None
    return {key: values[0] for key, values in parsed.items()}


def _token_response(access_token: str, refresh_token: str | None, scope: str) -> JSONResponse:
    payload = {
        "access_token": access_token,
        "token_type": "Bearer",
        "expires_in": 3600,
        "scope": scope,
    }
    if refresh_token:
        payload["refresh_token"] = refresh_token
        payload["refresh_expires_in"] = 2_592_000
    return JSONResponse(payload, headers={"Cache-Control": "no-store", "Pragma": "no-cache"})


@app.post("/oauth/token")
async def oauth_token(request: Request) -> Response:
    form = await _form_data(request)
    if not form:
        return _json_error(400, "invalid_request")
    client_id = form.get("client_id", "")
    grant_type = form.get("grant_type", "")
    if not client_id:
        return _json_error(400, "invalid_client")
    init_store()
    with sqlite3.connect(db_path(), timeout=10) as conn:
        client_record = conn.execute(
            "SELECT grant_types_json FROM oauth_clients WHERE client_id=?", (client_id,)
        ).fetchone()
    if not client_record:
        return _json_error(400, "invalid_client")
    client_grants = set(json.loads(client_record[0]))
    if grant_type not in client_grants:
        return _json_error(400, "unsupported_grant_type")
    conn = sqlite3.connect(db_path(), timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("BEGIN IMMEDIATE")
        stamp = _utc_now()
        if grant_type == "authorization_code":
            code = form.get("code", "")
            redirect_uri = form.get("redirect_uri", "")
            verifier = form.get("code_verifier", "")
            if (
                not code
                or not redirect_uri
                or not re.fullmatch(r"[A-Za-z0-9._~-]{43,128}", verifier)
            ):
                conn.rollback()
                return _json_error(400, "invalid_grant")
            row = conn.execute(
                "SELECT * FROM oauth_authorization_codes WHERE code_hash=? AND client_id=?",
                (_digest(code), client_id),
            ).fetchone()
            if (
                not row
                or row["consumed_at"]
                or row["expires_at"] <= stamp
                or row["redirect_uri"] != redirect_uri
                or form.get("resource", row["resource"]) != row["resource"]
                or (form.get("scope") and form["scope"] != row["scope"])
            ):
                conn.rollback()
                return _json_error(400, "invalid_grant")
            challenge = (
                base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("utf-8")).digest())
                .decode("ascii")
                .rstrip("=")
            )
            if not secrets.compare_digest(challenge, row["code_challenge"]):
                conn.rollback()
                return _json_error(400, "invalid_grant")
            granted_scopes = _active_profile_scopes(conn, row["user_id"], row["profile_id"])
            if not granted_scopes or not set(row["scope"].split()).issubset(granted_scopes):
                conn.rollback()
                return _json_error(400, "invalid_grant")
            conn.execute(
                "UPDATE oauth_authorization_codes SET consumed_at=? WHERE code_hash=? AND consumed_at IS NULL",
                (stamp, _digest(code)),
            )
            access = _issue_token(
                conn,
                client_id,
                "access",
                row["scope"],
                row["resource"],
                (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
                row["user_id"],
                row["profile_id"],
            )
            refresh = None
            if "refresh_token" in client_grants:
                refresh = _issue_token(
                    conn,
                    client_id,
                    "refresh",
                    row["scope"],
                    row["resource"],
                    (datetime.now(timezone.utc) + timedelta(days=30)).isoformat(),
                    row["user_id"],
                    row["profile_id"],
                )
            scope = row["scope"]
        elif grant_type == "refresh_token":
            raw_refresh = form.get("refresh_token", "")
            row = conn.execute(
                "SELECT * FROM oauth_tokens WHERE token_hash=? AND token_type='refresh' AND client_id=?",
                (_digest(raw_refresh), client_id),
            ).fetchone()
            if (
                not row
                or row["revoked_at"]
                or row["expires_at"] <= stamp
                or form.get("resource", row["resource"]) != row["resource"]
                or (form.get("scope") and form["scope"] != row["scope"])
            ):
                conn.rollback()
                return _json_error(400, "invalid_grant")
            granted_scopes = _active_profile_scopes(conn, row["user_id"], row["profile_id"])
            if not granted_scopes or not set(row["scope"].split()).issubset(granted_scopes):
                conn.rollback()
                return _json_error(400, "invalid_grant")
            conn.execute(
                "UPDATE oauth_tokens SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL",
                (stamp, _digest(raw_refresh)),
            )
            access = _issue_token(
                conn,
                client_id,
                "access",
                row["scope"],
                row["resource"],
                (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
                row["user_id"],
                row["profile_id"],
            )
            refresh = _issue_token(
                conn,
                client_id,
                "refresh",
                row["scope"],
                row["resource"],
                (datetime.now(timezone.utc) + timedelta(days=30)).isoformat(),
                row["user_id"],
                row["profile_id"],
            )
            scope = row["scope"]
        else:
            conn.rollback()
            return _json_error(400, "unsupported_grant_type")
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    return _token_response(access, refresh, scope)


@app.post("/oauth/revoke")
async def oauth_revoke(request: Request) -> Response:
    form = await _form_data(request)
    if not form:
        return _json_error(400, "invalid_request")
    client_id = form.get("client_id", "")
    token = form.get("token", "")
    if not client_id or not token:
        return _json_error(400, "invalid_request")
    init_store()
    with sqlite3.connect(db_path(), timeout=10) as conn:
        conn.execute(
            "UPDATE oauth_tokens SET revoked_at=? WHERE token_hash=? AND client_id=? AND revoked_at IS NULL",
            (_utc_now(), _digest(token), client_id),
        )
    return Response(status_code=200, headers={"Cache-Control": "no-store"})


@app.get("/setup", response_class=HTMLResponse)
def setup_page(request: Request) -> HTMLResponse:
    local_preview = request.url.hostname in {"127.0.0.1", "localhost", "testserver"}
    if local_preview:
        endpoint = f"{str(request.base_url).rstrip('/')}/mcp"
    else:
        endpoint = f"{PUBLIC_BASE_URL}/mcp"
    return setup_page_response(endpoint, local_preview=local_preview)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "Creator APIs MCP"}


@app.post("/mcp")
async def mcp(request: Request) -> Response:
    try:
        payload = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        return _rpc_error(None, -32700, "Parse error")
    if not isinstance(payload, dict):
        return _rpc_error(None, -32600, "Invalid Request")
    return await _handle(request, payload)
