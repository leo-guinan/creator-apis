import base64
import hashlib
import json
import re
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlparse

from fastapi.testclient import TestClient

import creatorapis_mcp.app as service

REDIRECT = "https://client.example.test/oauth/callback"


def _rpc(client, token, request_id, method, params=None):
    return client.post(
        "/mcp",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            **({"params": params} if params is not None else {}),
        },
    )


def _new_client(client):
    response = client.post(
        "/oauth/register",
        json={
            "client_name": "Research Assistant",
            "redirect_uris": [REDIRECT],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["client_id"]


def _open_verified_user(tmp_path, monkeypatch, email, open_registration=True):
    database = tmp_path / "creator-apis-mcp.sqlite3"
    monkeypatch.setenv("CREATORAPIS_MCP_DB", str(database))
    monkeypatch.setenv("CREATORAPIS_MCP_IDENTITY_KEY", "public-test-identity-key-0123456789")
    monkeypatch.setenv("CREATORAPIS_MCP_EMAIL_RELAY_TOKEN", "not-a-real-provider-token")
    monkeypatch.setenv("CREATORAPIS_MCP_AUTH_EMAILS", "" if open_registration else email)
    monkeypatch.setenv(
        "CREATORAPIS_MCP_OPEN_REGISTRATION", "true" if open_registration else "false"
    )
    service.init_store(database)
    sent = []

    def fake_send(link, request_id, recipient):
        sent.append((link, request_id, recipient))
        return {"status": "accepted", "receipt_id": "test-only"}

    monkeypatch.setattr(service, "_send_auth_email", fake_send)
    verifier = secrets.token_urlsafe(32)
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    )
    client = TestClient(service.app)
    client_id = _new_client(client)
    authorize = client.get(
        "/oauth/authorize",
        params={
            "client_id": client_id,
            "redirect_uri": REDIRECT,
            "response_type": "code",
            "state": "test-state",
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "scope": "creator:tale.write",
            "resource": service.RESOURCE_URI,
        },
    )
    assert authorize.status_code == 200, authorize.text
    request_id = re.search(r'name="request_id" value="([a-f0-9]+)"', authorize.text).group(1)
    assert (
        "any valid email address" in authorize.text
        if open_registration
        else "approved email address" in authorize.text
    )

    requested = client.post(
        "/oauth/email-request",
        headers={"Origin": service.PUBLIC_ORIGIN},
        json={"request_id": request_id, "email": email},
    )
    assert requested.status_code == 200, requested.text
    assert len(sent) == 1 and sent[0][2] == email.casefold()
    magic_token = urlparse(sent[0][0]).fragment
    with sqlite3.connect(database) as conn:
        unverified = conn.execute(
            "SELECT verified_at FROM oauth_users WHERE email_digest=?",
            (service._email_digest(email),),
        ).fetchone()[0]
        raw_email = email.encode() in database.read_bytes()
    assert unverified is None
    assert raw_email is False

    details = client.post(
        "/oauth/email-link/details",
        headers={"Origin": service.PUBLIC_ORIGIN},
        json={"token": magic_token},
    )
    assert details.status_code == 200, details.text
    profile_id = details.json()["selected_profile_id"]
    approved = client.post(
        "/oauth/email-link/consume",
        headers={"Origin": service.PUBLIC_ORIGIN},
        json={"token": magic_token, "decision": "approve", "profile_id": profile_id},
    )
    assert approved.status_code == 200, approved.text
    code = parse_qs(urlparse(approved.json()["redirect_url"]).query)["code"][0]
    exchanged = client.post(
        "/oauth/token",
        data={
            "grant_type": "authorization_code",
            "client_id": client_id,
            "code": code,
            "redirect_uri": REDIRECT,
            "code_verifier": verifier,
            "resource": service.RESOURCE_URI,
        },
    )
    assert exchanged.status_code == 200, exchanged.text
    return client, database, profile_id, exchanged.json()["access_token"], sent


def test_versioned_prompt_asset_is_the_prompt_exposed_by_the_server():
    prompt_asset = service.__file__.replace("app.py", "prompts/contribution-v1.md")
    with open(prompt_asset, encoding="utf-8") as handle:
        expected_prompt = handle.read().strip()
    assert service.ATTRIBUTION_PROMPT == expected_prompt


def _proposal():
    today = datetime.now(timezone.utc).date()
    prior = today - timedelta(days=1)
    first = today - timedelta(days=2)
    request_id = "profile-preview-001"
    return {
        "request_id": request_id,
        "agent_system": "Research Assistant",
        "coverage_start": first.isoformat(),
        "coverage_end": today.isoformat(),
        "coverage_status": "partial",
        "capability_tale": "### Episodes\n\nCompleted a bounded test; one attempt failed. Claims remain self-reported and unverified.",
        "daily_energy": [
            {"date": prior.isoformat(), "category": "research", "events": 2},
            {"date": prior.isoformat(), "category": "research", "events": 3},
            {"date": today.isoformat(), "category": "writing", "events": 1},
        ],
    }


def test_verified_users_get_isolated_profiles_and_exactly_two_tools(tmp_path, monkeypatch):
    first = _open_verified_user(tmp_path, monkeypatch, "one@example.test")
    second = _open_verified_user(tmp_path, monkeypatch, "two@example.test")
    first_client, database, first_profile, first_access, _ = first
    second_client, _, second_profile, second_access, _ = second
    expected = {
        "get_creator_apis_attribution_prompt",
        "submit_creator_apis_attribution_profile",
    }

    assert first_profile != second_profile
    for client, token in ((first_client, first_access), (second_client, second_access)):
        listed = _rpc(client, token, "list", "tools/list").json()
        assert {tool["name"] for tool in listed["result"]["tools"]} == expected

    with sqlite3.connect(database) as conn:
        profiles = conn.execute(
            "SELECT p.profile_id,p.owner_user_id FROM creator_profiles p ORDER BY p.profile_id"
        ).fetchall()
    assert len(profiles) == 2
    assert profiles[0][1] != profiles[1][1]


def test_tool_prompt_requires_local_preview_eval_calibration_and_excludes_raw_or_spend_data(
    tmp_path, monkeypatch
):
    client, _, _, access, _ = _open_verified_user(tmp_path, monkeypatch, "prompt@example.test")
    response = _rpc(
        client,
        access,
        "prompt",
        "tools/call",
        {
            "name": "get_creator_apis_attribution_prompt",
            "arguments": {},
        },
    ).json()
    prompt = response["result"]["content"][0]["text"].lower()
    assert "your own accessible history" in prompt
    assert "show the exact policy" in prompt
    assert "locally show the evaluated draft" in prompt
    assert "lock the evaluation" in prompt
    assert "never send or store raw transcripts" in prompt
    assert "token spend" in prompt
    assert "utc date/category/event-count rows" in prompt


def test_per_submission_approval_phrase_does_not_bypass_locked_eval(tmp_path, monkeypatch):
    client, database, _, access, _ = _open_verified_user(
        tmp_path, monkeypatch, "submit@example.test"
    )
    response = _rpc(
        client,
        access,
        "submit",
        "tools/call",
        {
            "name": "submit_creator_apis_attribution_profile",
            "arguments": {
                "action": "deliver",
                **_proposal(),
                "user_approval": "APPROVE profile-preview-001",
            },
        },
    ).json()
    assert response["result"]["isError"] is True
    with sqlite3.connect(database) as conn:
        assert conn.execute("SELECT COUNT(*) FROM routing_profile_contributions").fetchone()[0] == 0


def test_rejects_extra_spend_fields_private_identity_and_foreign_profile(tmp_path, monkeypatch):
    client, database, _, access, _ = _open_verified_user(
        tmp_path, monkeypatch, "privacy@example.test"
    )
    proposal = _proposal()
    for changed in (
        dict(proposal, token_spend={"usd": 10}),
        dict(proposal, agent_system="private@example.test"),
        dict(proposal, capability_tale="See https://private.example/path"),
        dict(proposal, profile_id="another-users-profile"),
    ):
        response = _rpc(
            client,
            access,
            "invalid",
            "tools/call",
            {
                "name": "submit_creator_apis_attribution_profile",
                "arguments": changed,
            },
        ).json()
        assert response["result"]["isError"] is True
    with sqlite3.connect(database) as conn:
        assert conn.execute("SELECT COUNT(*) FROM routing_profile_contributions").fetchone()[0] == 0


def test_open_registration_is_opt_in_and_unknown_email_is_rejected_by_default(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("CREATORAPIS_MCP_DB", str(tmp_path / "closed.sqlite3"))
    monkeypatch.setenv("CREATORAPIS_MCP_IDENTITY_KEY", "public-test-identity-key-0123456789")
    monkeypatch.setenv("CREATORAPIS_MCP_EMAIL_RELAY_TOKEN", "not-a-real-provider-token")
    monkeypatch.setenv("CREATORAPIS_MCP_AUTH_EMAILS", "approved@example.test")
    sent = []
    monkeypatch.setattr(service, "_send_auth_email", lambda *args: sent.append(args))
    service.init_store()
    client = TestClient(service.app)
    client_id = _new_client(client)
    verifier = secrets.token_urlsafe(32)
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    )
    authorize = client.get(
        "/oauth/authorize",
        params={
            "client_id": client_id,
            "redirect_uri": REDIRECT,
            "response_type": "code",
            "state": "closed-state",
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "scope": "creator:tale.write",
            "resource": service.RESOURCE_URI,
        },
    )
    request_id = re.search(r'name="request_id" value="([a-f0-9]+)"', authorize.text).group(1)
    response = client.post(
        "/oauth/email-request",
        headers={"Origin": service.PUBLIC_ORIGIN},
        json={"request_id": request_id, "email": "unknown@example.test"},
    )
    assert response.status_code == 403
    assert not sent


EVAL_CRITERIA = [
    "evidence_traceability",
    "uncertainty_and_falsifiers",
    "privacy_boundary",
    "daily_energy_integrity",
]


def _canonical_profile_hash(payload):
    profile_fields = {
        key: payload[key]
        for key in (
            "request_id",
            "agent_system",
            "coverage_start",
            "coverage_end",
            "coverage_status",
            "capability_tale",
            "daily_energy",
        )
    }
    serialized = json.dumps(
        profile_fields, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def _contribute(client, access, request_id, arguments):
    response = _rpc(
        client,
        access,
        request_id,
        "tools/call",
        {
            "name": "submit_creator_apis_attribution_profile",
            "arguments": arguments,
        },
    )
    return response.json()["result"]


def _create_eval(client, access, request_id="create-eval"):
    return _contribute(
        client,
        access,
        request_id,
        {
            "action": "create_eval",
            "criteria": EVAL_CRITERIA,
            "minimum_calibrations": 3,
            "threshold_percent": 75,
            "auto_delivery": True,
        },
    )


def _calibrate(client, access, eval_id, index, evaluator_decision="pass", human_verdict="approve"):
    sample_hash = hashlib.sha256(f"calibration-{index}".encode()).hexdigest()
    return _contribute(
        client,
        access,
        f"calibrate-{index}",
        {
            "action": "calibrate_eval",
            "eval_id": eval_id,
            "sample_sha256": sample_hash,
            "evaluator_decision": evaluator_decision,
            "human_verdict": human_verdict,
            "feedback_tags": [],
        },
    )


def _locked_eval(client, access):
    created = _create_eval(client, access)
    assert created.get("isError") is not True
    eval_receipt = json.loads(created["content"][0]["text"])
    eval_id = eval_receipt["eval_id"]
    for index in range(3):
        calibrated = _calibrate(client, access, eval_id, index)
        assert calibrated.get("isError") is not True
    locked = _contribute(
        client,
        access,
        "lock-eval",
        {
            "action": "lock_eval",
            "eval_id": eval_id,
            "lock_phrase": f"LOCK {eval_id}",
        },
    )
    assert locked.get("isError") is not True
    return eval_id, json.loads(locked["content"][0]["text"])


def test_locked_calibrated_eval_allows_auto_delivery_without_payload_approval(
    tmp_path, monkeypatch
):
    client, database, profile_id, access, _ = _open_verified_user(
        tmp_path, monkeypatch, "eval@example.test"
    )
    created = _create_eval(client, access)
    assert created.get("isError") is not True
    eval_id = json.loads(created["content"][0]["text"])["eval_id"]
    with sqlite3.connect(database) as conn:
        assert conn.execute("SELECT COUNT(*) FROM routing_profile_contributions").fetchone()[0] == 0
        assert (
            conn.execute(
                "SELECT state FROM contribution_evaluations WHERE eval_id=?", (eval_id,)
            ).fetchone()[0]
            == "calibrating"
        )

    for index in range(3):
        assert _calibrate(client, access, eval_id, index).get("isError") is not True
    locked = _contribute(
        client,
        access,
        "lock-eval",
        {
            "action": "lock_eval",
            "eval_id": eval_id,
            "lock_phrase": f"LOCK {eval_id}",
        },
    )
    assert locked.get("isError") is not True
    lock_receipt = json.loads(locked["content"][0]["text"])
    assert lock_receipt["state"] == "locked"
    assert lock_receipt["auto_delivery"] is True
    assert lock_receipt["calibration_count"] == 3

    proposal = _proposal()
    delivered = _contribute(
        client,
        access,
        "auto-deliver",
        {
            "action": "deliver",
            "eval_id": eval_id,
            **proposal,
            "evaluation_checks": {criterion: "pass" for criterion in EVAL_CRITERIA},
            "evaluated_payload_sha256": _canonical_profile_hash(proposal),
        },
    )
    assert delivered.get("isError") is not True
    receipt = json.loads(delivered["content"][0]["text"])
    assert receipt["status"] == "accepted"
    assert receipt["profile_id"] == profile_id
    assert receipt["delivery_mode"] == "locked_eval_auto"
    assert receipt["evaluation_score"] == 100

    with sqlite3.connect(database) as conn:
        stored = conn.execute(
            "SELECT evaluation_id,evaluation_score,delivery_mode,measurement_status,consent_attestation,"
            "evaluated_payload_sha256,evaluation_checks_json,evaluation_receipt_sha256 "
            "FROM routing_profile_contributions"
        ).fetchone()
        calibration_rows = conn.execute(
            "SELECT COUNT(*) FROM contribution_eval_calibrations WHERE eval_id=?",
            (eval_id,),
        ).fetchone()[0]
        energy_rows = conn.execute(
            "SELECT utc_date,category,event_count FROM routing_profile_energy_events "
            "ORDER BY utc_date,category"
        ).fetchall()
    assert stored[:5] == (
        eval_id,
        100,
        "locked_eval_auto",
        "self_reported",
        "client_reported_eval_lock",
    )
    assert stored[5] == _canonical_profile_hash(proposal)
    assert json.loads(stored[6]) == {criterion: "pass" for criterion in EVAL_CRITERIA}
    assert re.fullmatch(r"[a-f0-9]{64}", stored[7])
    assert calibration_rows == 3
    proposal_rows = _proposal()["daily_energy"]
    research_day = proposal_rows[0]["date"]
    writing_day = proposal_rows[2]["date"]
    assert energy_rows == [(research_day, "research", 5), (writing_day, "writing", 1)]
    assert b"eval@example.test" not in database.read_bytes()


def test_false_positive_calibration_blocks_eval_lock(tmp_path, monkeypatch):
    client, database, _, access, _ = _open_verified_user(
        tmp_path, monkeypatch, "false-positive@example.test"
    )
    created = _create_eval(client, access)
    eval_id = json.loads(created["content"][0]["text"])["eval_id"]
    assert _calibrate(client, access, eval_id, 0, "pass", "approve").get("isError") is not True
    assert _calibrate(client, access, eval_id, 1, "pass", "revise").get("isError") is not True
    assert _calibrate(client, access, eval_id, 2, "fail", "reject").get("isError") is not True
    locked = _contribute(
        client,
        access,
        "lock-with-false-positive",
        {
            "action": "lock_eval",
            "eval_id": eval_id,
            "lock_phrase": f"LOCK {eval_id}",
        },
    )
    assert locked["isError"] is True
    with sqlite3.connect(database) as conn:
        assert (
            conn.execute(
                "SELECT state FROM contribution_evaluations WHERE eval_id=?", (eval_id,)
            ).fetchone()[0]
            == "calibrating"
        )
        assert conn.execute("SELECT COUNT(*) FROM routing_profile_contributions").fetchone()[0] == 0


def test_invalid_calibration_shape_returns_tool_error_without_crashing(tmp_path, monkeypatch):
    client, database, _, access, _ = _open_verified_user(
        tmp_path, monkeypatch, "invalid-calibration@example.test"
    )
    created = _create_eval(client, access)
    eval_id = json.loads(created["content"][0]["text"])["eval_id"]
    invalid = _contribute(
        client,
        access,
        "invalid-calibration",
        {
            "action": "calibrate_eval",
            "eval_id": eval_id,
            "sample_sha256": hashlib.sha256(b"sample").hexdigest(),
            "evaluator_decision": [],
            "human_verdict": "approve",
            "feedback_tags": [],
        },
    )
    assert invalid.get("isError") is True
    with sqlite3.connect(database) as conn:
        assert (
            conn.execute("SELECT COUNT(*) FROM contribution_eval_calibrations").fetchone()[0] == 0
        )


def test_auto_delivery_requires_locked_eval_and_payload_hash_match(tmp_path, monkeypatch):
    client, database, _, access, _ = _open_verified_user(
        tmp_path, monkeypatch, "eval-gate@example.test"
    )
    created = _create_eval(client, access)
    eval_id = json.loads(created["content"][0]["text"])["eval_id"]
    proposal = _proposal()
    premature = _contribute(
        client,
        access,
        "premature",
        {
            "action": "deliver",
            "eval_id": eval_id,
            **proposal,
            "evaluation_checks": {criterion: "pass" for criterion in EVAL_CRITERIA},
            "evaluated_payload_sha256": _canonical_profile_hash(proposal),
        },
    )
    assert premature["isError"] is True
    for index in range(3):
        assert _calibrate(client, access, eval_id, index).get("isError") is not True
    locked = _contribute(
        client,
        access,
        "lock-eval",
        {
            "action": "lock_eval",
            "eval_id": eval_id,
            "lock_phrase": f"LOCK {eval_id}",
        },
    )
    assert locked.get("isError") is not True
    mismatched = _contribute(
        client,
        access,
        "mismatched",
        {
            "action": "deliver",
            "eval_id": eval_id,
            **proposal,
            "evaluation_checks": {criterion: "pass" for criterion in EVAL_CRITERIA},
            "evaluated_payload_sha256": "0" * 64,
        },
    )
    assert mismatched["isError"] is True
    with sqlite3.connect(database) as conn:
        assert conn.execute("SELECT COUNT(*) FROM routing_profile_contributions").fetchone()[0] == 0


def test_invalid_eval_check_shape_returns_tool_error_without_crashing(tmp_path, monkeypatch):
    client, database, _, access, _ = _open_verified_user(
        tmp_path, monkeypatch, "invalid-eval-check@example.test"
    )
    eval_id, _ = _locked_eval(client, access)
    proposal = _proposal()
    invalid = _contribute(
        client,
        access,
        "invalid-eval-check",
        {
            "action": "deliver",
            "eval_id": eval_id,
            **proposal,
            "evaluation_checks": {criterion: [] for criterion in EVAL_CRITERIA},
            "evaluated_payload_sha256": _canonical_profile_hash(proposal),
        },
    )
    assert invalid.get("isError") is True
    with sqlite3.connect(database) as conn:
        assert conn.execute("SELECT COUNT(*) FROM routing_profile_contributions").fetchone()[0] == 0


def test_prompt_describes_calibrated_eval_lock_not_per_submission_approval(tmp_path, monkeypatch):
    client, _, _, access, _ = _open_verified_user(tmp_path, monkeypatch, "eval-prompt@example.test")
    prompt = (
        _rpc(
            client,
            access,
            "prompt",
            "tools/call",
            {
                "name": "get_creator_apis_attribution_prompt",
                "arguments": {},
            },
        )
        .json()["result"]["content"][0]["text"]
        .lower()
    )
    assert "calibrate over multiple examples" in prompt
    assert "lock the evaluation" in prompt
    assert "automatic delivery" in prompt
    assert "no per-submission approval" in prompt
    assert "does not know their preferences with certainty" in prompt


def test_setup_page_explains_policy_level_calibration_and_auto_delivery_boundary(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("CREATORAPIS_MCP_DB", str(tmp_path / "setup.sqlite3"))
    client = TestClient(service.app)
    response = client.get("/setup")
    assert response.status_code == 200
    body = response.text.lower()
    assert "calibrate" in body
    assert "locked evaluation" in body
    assert "no per-submission approval" in body
    assert "client-reported" in body
    assert "not independently verified" in body


def test_prompt_reports_only_the_authenticated_profiles_eval_state(tmp_path, monkeypatch):
    first = _open_verified_user(tmp_path, monkeypatch, "eval-owner@example.test")
    second = _open_verified_user(tmp_path, monkeypatch, "other-owner@example.test")
    first_client, _, _, first_access, _ = first
    second_client, _, _, second_access, _ = second
    created = _create_eval(first_client, first_access)
    assert created.get("isError") is not True
    eval_id = json.loads(created["content"][0]["text"])["eval_id"]

    first_prompt = _rpc(
        first_client,
        first_access,
        "prompt-owner",
        "tools/call",
        {
            "name": "get_creator_apis_attribution_prompt",
            "arguments": {},
        },
    ).json()["result"]["content"][0]["text"]
    second_prompt = _rpc(
        second_client,
        second_access,
        "prompt-other",
        "tools/call",
        {
            "name": "get_creator_apis_attribution_prompt",
            "arguments": {},
        },
    ).json()["result"]["content"][0]["text"]
    assert eval_id in first_prompt
    assert "state: calibrating" in first_prompt.lower()
    assert eval_id not in second_prompt


def test_evaluation_and_calibration_records_are_profile_isolated(tmp_path, monkeypatch):
    first = _open_verified_user(tmp_path, monkeypatch, "eval-owner-two@example.test")
    second = _open_verified_user(tmp_path, monkeypatch, "other-owner-two@example.test")
    first_client, database, _, first_access, _ = first
    second_client, _, _, second_access, _ = second
    created = _create_eval(first_client, first_access)
    eval_id = json.loads(created["content"][0]["text"])["eval_id"]
    attempted = _calibrate(second_client, second_access, eval_id, 0)
    assert attempted["isError"] is True
    with sqlite3.connect(database) as conn:
        assert (
            conn.execute(
                "SELECT COUNT(*) FROM contribution_eval_calibrations WHERE eval_id=?",
                (eval_id,),
            ).fetchone()[0]
            == 0
        )


def test_paused_locked_eval_cannot_auto_deliver(tmp_path, monkeypatch):
    client, database, _, access, _ = _open_verified_user(
        tmp_path, monkeypatch, "pause@example.test"
    )
    eval_id, _ = _locked_eval(client, access)
    paused = _contribute(client, access, "pause-eval", {"action": "pause_eval", "eval_id": eval_id})
    assert paused.get("isError") is not True
    proposal = _proposal()
    attempted = _contribute(
        client,
        access,
        "after-pause",
        {
            "action": "deliver",
            "eval_id": eval_id,
            **proposal,
            "evaluation_checks": {criterion: "pass" for criterion in EVAL_CRITERIA},
            "evaluated_payload_sha256": _canonical_profile_hash(proposal),
        },
    )
    assert attempted["isError"] is True
    with sqlite3.connect(database) as conn:
        assert conn.execute("SELECT COUNT(*) FROM routing_profile_contributions").fetchone()[0] == 0
