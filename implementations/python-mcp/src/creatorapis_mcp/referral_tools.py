from __future__ import annotations

import sqlite3
from typing import Any

from .referrals import create_referral, destination_with_referral, leaderboard, record_event

PUBLIC_REFERRAL_ORIGIN = (
    __import__("os")
    .environ.get("CREATORAPIS_MCP_PUBLIC_ORIGIN", "http://127.0.0.1:8000")
    .rstrip("/")
)


def handle_referral_tool(database, profile_id: str, arguments: dict[str, Any]) -> dict[str, Any]:
    action = arguments.get("action")
    with sqlite3.connect(database, timeout=10) as conn:
        conn.row_factory = sqlite3.Row
        if action == "create":
            code, _ = create_referral(conn, arguments["student_id"], arguments["label"])
            link = destination_with_referral(
                arguments["destination_url"], code, arguments["source"], arguments["content_slug"]
            )
            tracking_link = f"{PUBLIC_REFERRAL_ORIGIN}/r/{code}?source={arguments['source']}&content={arguments['content_slug']}"
            content = arguments.get("content")
            if content is not None and (not isinstance(content, str) or len(content) > 20000):
                raise ValueError("content must be at most 20000 characters")
            instrumented_content = None
            if content is not None:
                instrumented_content = content.replace(arguments["destination_url"], tracking_link)
                if instrumented_content == content:
                    instrumented_content = content.rstrip() + f"\n\n[Share this]({tracking_link})"
            conn.commit()
            return {
                "status": "created",
                "profile_id": profile_id,
                "referral_code": code,
                "instrumented_url": link,
                "tracking_url": tracking_link,
                "markdown": f"[Share this]({tracking_link})",
                "instrumented_content": instrumented_content,
                "claim_status": "routing_receipt_only",
            }
        if action == "event":
            result = record_event(
                conn,
                arguments["referral_code"],
                arguments["event_name"],
                arguments["source"],
                arguments.get("content_slug"),
                arguments.get("event_id"),
            )
            conn.commit()
            return {"status": "accepted", **result, "claim_status": "observed_event_only"}
        if action == "leaderboard":
            return {
                "status": "observed",
                "days": arguments.get("days", 30),
                "rows": leaderboard(conn, arguments.get("days", 30)),
            }
    raise ValueError("unknown referral action")
