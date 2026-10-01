from __future__ import annotations

import secrets

from fastapi.responses import HTMLResponse


def setup_page_response(endpoint: str, local_preview: bool = False) -> HTMLResponse:
    nonce = secrets.token_urlsafe(18)
    notice = (
        "This loopback address is reachable only from this computer."
        if local_preview
        else "Use the exact MCP address in your AI client’s connector settings."
    )
    html = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>Creator APIs MCP · Connect</title>
  <style nonce="{nonce}">
    :root {{ color-scheme: light; --ink:#17211f; --muted:#586764; --line:#d7dfd9; --paper:#f6f7f2; --panel:#fff; --green:#175b46; }}
    * {{ box-sizing:border-box; }}
    body {{ margin:0; background:var(--paper); color:var(--ink); font:17px/1.55 Arial,Helvetica,sans-serif; }}
    main {{ width:min(100% - 32px,720px); margin:56px auto; }}
    .eyebrow {{ color:var(--green); font:700 12px/1.4 ui-monospace,Menlo,monospace; letter-spacing:.08em; text-transform:uppercase; }}
    h1 {{ margin:.2em 0; font-size:clamp(34px,7vw,52px); line-height:1.08; }}
    .intro {{ max-width:60ch; color:var(--muted); }}
    section {{ margin-top:18px; padding:22px; border:1px solid var(--line); border-radius:12px; background:var(--panel); }}
    h2 {{ margin:0 0 8px; font-size:20px; }}
    .address {{ display:flex; gap:8px; }}
    input {{ min-width:0; flex:1; padding:12px; border:1px solid #aebbb3; border-radius:7px; font:14px/1.4 ui-monospace,Menlo,monospace; }}
    button {{ min-height:44px; padding:10px 16px; border:0; border-radius:7px; background:var(--green); color:#fff; font-weight:700; cursor:pointer; }}
    button.secondary {{ border:1px solid #aebbb3; background:#fff; color:var(--ink); }}
    button:disabled {{ opacity:.65; cursor:wait; }}
    .status {{ min-height:28px; color:var(--muted); }}
    .note {{ padding:12px 14px; border-left:3px solid #bd8a36; background:#fbf5e9; color:#4f4127; font-size:15px; }}
    code {{ overflow-wrap:anywhere; }}
    @media(max-width:560px) {{ main {{ margin:32px auto; }} section {{ padding:18px; }} .address {{ flex-direction:column; }} }}
  </style>
</head>
<body>
<main>
  <p class="eyebrow">Creator APIs · reference MCP</p>
  <h1>Two tools. One calibrated delivery rule.</h1>
  <p class="intro">After verified-email sign-in and consent, you and your AI client create an evaluation and calibrate it against examples over time. Once you lock that version, passing profile projections can be delivered automatically to your isolated Creator APIs profile; there is no per-submission approval step.</p>
  <section aria-labelledby="boundary-heading">
    <h2 id="boundary-heading">What the server does—and does not do</h2>
    <p>The server does not read chat history. The prompt asks your AI client to use only its own accessible history. V1 stores the self-reported capability tale and daily category totals, plus the versioned rubric and minimal calibration records (sample hashes, decisions, and feedback tags); it does not store calibration examples or raw transcripts. The profile projection excludes direct identity fields, token counts, and spend.</p>
    <p class="note"><strong>Evidence boundary:</strong> claims, category counts, evaluator checks, calibration labels, and the lock phrase are client-reported and not independently verified; none proves independent measurement or a human action. A locked evaluation is a prediction, not certainty. It authorizes automatic delivery only to the authenticated owner’s profile until paused—not public posting, email, or other external actions. {notice}</p>
  </section>
  <section aria-labelledby="connect-heading">
    <h2 id="connect-heading">Connect an AI client</h2>
    <p>Copy this MCP server address into the client’s connector settings. The check below verifies only service health and the expected unauthenticated challenge; it does not prove client authorization or tool discovery.</p>
    <div class="address"><input id="endpoint" value="{endpoint}" readonly aria-label="MCP server address"><button id="copy" class="secondary" type="button">Copy address</button></div>
    <p id="copy-status" class="status" role="status" aria-live="polite"></p>
    <button id="check" type="button">Check server</button>
    <p id="server-status" class="status" role="status" aria-live="polite">Not checked yet.</p>
  </section>
</main>
<script nonce="{nonce}">
(() => {{
  const prefix = location.pathname.endsWith("/setup") ? location.pathname.slice(0, -6) : "";
  const status = document.getElementById("server-status");
  const check = document.getElementById("check");
  check.addEventListener("click", async () => {{
    check.disabled = true;
    status.textContent = "Checking service…";
    try {{
      const health = await fetch(prefix + "/health", {{cache:"no-store", credentials:"same-origin"}});
      const data = await health.json();
      if (!health.ok || data.status !== "ok") throw new Error("The health check did not pass.");
      const challenge = await fetch(prefix + "/mcp", {{
        method:"POST", cache:"no-store", credentials:"same-origin",
        headers:{{"Content-Type":"application/json"}},
        body:JSON.stringify({{jsonrpc:"2.0", id:"setup-check", method:"initialize", params:{{protocolVersion:"2025-03-26", capabilities:{{}}, clientInfo:{{name:"setup-check", version:"1"}}}}}})
      }});
      if (challenge.status !== 401 || !(challenge.headers.get("WWW-Authenticate") || "").includes("resource_metadata")) throw new Error("The MCP endpoint did not return its expected authorization challenge.");
      status.textContent = "Service reachable; unauthenticated MCP access is challenged. Authorization and tool discovery remain untested.";
    }} catch (error) {{
      status.textContent = error instanceof TypeError ? "Could not reach the service. Check the address and try again." : error.message;
    }} finally {{ check.disabled = false; }}
  }});
  document.getElementById("copy").addEventListener("click", async () => {{
    const field = document.getElementById("endpoint");
    const message = document.getElementById("copy-status");
    try {{ await navigator.clipboard.writeText(field.value); message.textContent = "Address copied."; }}
    catch (_) {{ field.select(); message.textContent = "Select and copy the address above."; }}
  }});
}})();
</script>
</body>
</html>"""
    return HTMLResponse(
        html,
        headers={
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": f"default-src 'none'; style-src 'nonce-{nonce}'; script-src 'nonce-{nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        },
    )
