import json
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone

import anyio
import httpx
from mcp.client.session import ClientSession
from mcp.client.streamable_http import streamable_http_client

import creatorapis_mcp.app as service


def test_official_mcp_client_initializes_lists_and_calls_tools(tmp_path, monkeypatch):
    database = tmp_path / "mcp-interop.sqlite3"
    monkeypatch.setenv("CREATORAPIS_MCP_DB", str(database))
    service.init_store(database)

    user_id = "user_interop"
    profile_id = "profile_interop"
    client_id = "client_interop"
    access_token = secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)
    with sqlite3.connect(database) as conn:
        conn.execute(
            "INSERT INTO oauth_users(user_id,email_digest,created_at,verified_at,disabled_at) "
            "VALUES(?,?,?,?,NULL)",
            (user_id, "test-only-digest", now.isoformat(), now.isoformat()),
        )
        conn.execute(
            "INSERT INTO creator_profiles(profile_id,owner_user_id,display_name,created_at) "
            "VALUES(?,?,?,?)",
            (profile_id, user_id, "Interop test", now.isoformat()),
        )
        conn.execute(
            "INSERT INTO profile_memberships(user_id,profile_id,scopes_json,created_at,revoked_at) "
            "VALUES(?,?,?,?,NULL)",
            (user_id, profile_id, json.dumps(["creator:tale.write"]), now.isoformat()),
        )
        conn.execute(
            "INSERT INTO oauth_tokens(token_hash,client_id,token_type,scope,resource,created_at,expires_at,revoked_at,user_id,profile_id) "
            "VALUES(?,?,?,?,?,?,?,NULL,?,?)",
            (
                service._digest(access_token),
                client_id,
                "access",
                "creator:tale.write",
                service.RESOURCE_URI,
                now.isoformat(),
                (now + timedelta(hours=1)).isoformat(),
                user_id,
                profile_id,
            ),
        )

    async def exercise_client():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=service.app),
            base_url="http://testserver",
            headers={"Authorization": f"Bearer {access_token}"},
        ) as http_client:
            async with streamable_http_client("http://testserver/mcp", http_client=http_client) as (
                read_stream,
                write_stream,
                _get_session_id,
            ):
                async with ClientSession(read_stream, write_stream) as session:
                    initialized = await session.initialize()
                    assert initialized.serverInfo.name == "creator-apis-mcp"
                    tools = await session.list_tools()
                    assert {tool.name for tool in tools.tools} == {
                        "get_creator_apis_attribution_prompt",
                        "submit_creator_apis_attribution_profile",
                        "create_student_referral_link",
                        "record_student_referral_event",
                        "get_student_referral_leaderboard",
                    }
                    result = await session.call_tool("get_creator_apis_attribution_prompt", {})
                    assert result.isError is not True
                    assert "Current profile evaluation state" in result.content[0].text

    anyio.run(exercise_client)
