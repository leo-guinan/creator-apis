def render_email_signin_page(
    request_id: str, nonce: str, public_base_path: str, open_registration: bool = False
) -> str:
    """Render the passwordless OAuth email-entry step without loading external assets."""
    if open_registration:
        intro = "Enter any valid email address and we’ll send a one-time sign-in link to verify control of that inbox. You’ll review the requested permissions before anything connects."
        email_hint = "Use an inbox you can access. The one-time link expires in 10 minutes."
    else:
        intro = "Enter an approved email address and we’ll send a one-time sign-in link. You’ll review the requested permissions before anything connects."
        email_hint = "Use the address approved for this account. The link expires in 10 minutes."
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>Sign in · Creator APIs</title>
  <style nonce="{nonce}">
    :root {{
      color-scheme: light;
      --ink: #17211f;
      --muted: #596762;
      --line: #d9e0da;
      --paper: #f4f6f1;
      --panel: #ffffff;
      --green: #175b46;
      --green-hover: #104b39;
      --focus: #bc842f;
      --error: #8a3025;
      --error-bg: #fff1ee;
      --success: #1c5a42;
      --success-bg: #eff7f1;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      min-height: 100svh;
      margin: 0;
      padding: 24px 16px;
      display: grid;
      place-items: center;
      background: var(--paper);
      color: var(--ink);
      font: 16px/1.55 Arial, Helvetica, sans-serif;
    }}
    main {{
      width: min(100%, 520px);
      margin: auto;
      padding: clamp(26px, 6vw, 42px);
      border: 1px solid var(--line);
      border-radius: 18px;
      background: var(--panel);
      box-shadow: 0 18px 54px rgba(28, 48, 38, .08);
    }}
    .brand {{ display: flex; align-items: center; gap: 11px; margin-bottom: 34px; }}
    .brand-mark {{
      width: 36px; height: 36px; display: grid; place-items: center;
      border-radius: 10px; background: var(--green); color: #fff;
      font-size: 17px; font-weight: 700; letter-spacing: -.03em;
    }}
    .brand-name {{ color: var(--ink); font-size: 13px; font-weight: 700; letter-spacing: .015em; }}
    .eyebrow {{
      margin: 0 0 10px; color: var(--green);
      font: 700 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
      letter-spacing: .11em; text-transform: uppercase;
    }}
    h1 {{ margin: 0; font-size: clamp(32px, 6vw, 42px); line-height: 1.1; letter-spacing: -.025em; }}
    .intro {{ max-width: 44ch; margin: 16px 0 26px; color: var(--muted); }}
    label {{ display: block; margin: 0 0 7px; font-size: 14px; font-weight: 700; }}
    input {{
      width: 100%; min-height: 50px; padding: 12px 14px;
      border: 1px solid #aebbb3; border-radius: 9px;
      background: #fff; color: var(--ink); font: inherit;
    }}
    input::placeholder {{ color: #77827d; }}
    input:focus-visible, button:focus-visible {{ outline: 3px solid var(--focus); outline-offset: 3px; }}
    .hint {{ margin: 8px 0 0; color: var(--muted); font-size: 13px; }}
    button {{
      width: 100%; min-height: 50px; margin-top: 20px; padding: 12px 18px;
      border: 0; border-radius: 9px; background: var(--green); color: #fff;
      font: 700 15px/1.3 Arial, Helvetica, sans-serif; cursor: pointer;
      transition: background-color 140ms ease, transform 140ms ease;
    }}
    button:hover:not(:disabled) {{ background: var(--green-hover); }}
    button:active:not(:disabled) {{ transform: translateY(1px); }}
    button:disabled {{ cursor: wait; opacity: .72; }}
    .form-meta {{ display: flex; flex-wrap: wrap; gap: 8px 16px; margin: 14px 0 0; color: var(--muted); font-size: 12px; }}
    .form-meta span::before {{ content: "•"; margin-right: 7px; color: var(--green); }}
    .privacy-note {{
      margin: 27px 0 0; padding-top: 18px; border-top: 1px solid var(--line);
      color: var(--muted); font-size: 13px;
    }}
    .status {{ min-height: 0; margin: 0; font-size: 14px; }}
    .status:not([data-state="idle"]) {{ margin-top: 16px; padding: 12px 14px; border-radius: 9px; }}
    .status[data-state="error"] {{ background: var(--error-bg); color: var(--error); }}
    .status[data-state="success"] {{ background: var(--success-bg); color: var(--success); }}
    .status[data-state="pending"] {{ color: var(--muted); }}
    [hidden] {{ display: none !important; }}
    @media (max-width: 560px) {{
      body {{ align-items: start; padding: max(20px, env(safe-area-inset-top)) 14px 20px; }}
      main {{ margin: auto; padding: 25px 21px; border-radius: 15px; }}
      .brand {{ margin-bottom: 28px; }}
    }}
    @media (prefers-reduced-motion: reduce) {{
      *, *::before, *::after {{ scroll-behavior: auto !important; transition-duration: .01ms !important; }}
    }}
  </style>
</head>
<body>
  <main class="auth-card" data-page="email-signin">
    <div class="brand" aria-label="Creator APIs">
      <span class="brand-mark" aria-hidden="true">C</span>
      <span class="brand-name">Creator APIs</span>
    </div>
    <p class="eyebrow">Private connection · step 1 of 2</p>
    <h1>Sign in to continue.</h1>
    <p class="intro">{intro}</p>
    <form id="login" aria-describedby="email-hint">
      <input type="hidden" name="request_id" value="{request_id}">
      <label for="email">Email address</label>
      <input id="email" name="email" type="email" autocomplete="email" inputmode="email" required maxlength="254" aria-describedby="email-hint">
      <p class="hint" id="email-hint">{email_hint}</p>
      <button type="submit">Send sign-in link</button>
      <p class="form-meta" aria-label="Sign-in details"><span>No password</span><span>One-time link</span></p>
    </form>
    <p class="status" id="status" role="status" aria-live="polite" aria-atomic="true" data-state="idle"></p>
    <p class="privacy-note">This step only verifies your email. No profile access is granted until you approve the permissions on the next screen.</p>
  </main>
  <script nonce="{nonce}">
    (() => {{
      const form = document.getElementById("login");
      const status = document.getElementById("status");
      const button = form.querySelector("button[type=submit]");
      const setStatus = (message, state) => {{
        status.textContent = message;
        status.dataset.state = state;
      }};
      form.addEventListener("submit", async (event) => {{
        event.preventDefault();
        button.disabled = true;
        button.textContent = "Sending link…";
        form.setAttribute("aria-busy", "true");
        setStatus("Sending your request securely…", "pending");
        try {{
          const response = await fetch("{public_base_path}/oauth/email-request", {{
            method: "POST",
            headers: {{ "Content-Type": "application/json" }},
            body: JSON.stringify({{
              request_id: form.elements.request_id.value,
              email: document.getElementById("email").value
            }}),
            referrerPolicy: "no-referrer"
          }});
          const data = await response.json();
          if (!response.ok) {{
            const messages = {{
              email_login_unavailable: "Email sign-in is temporarily unavailable. Return to your AI client and start again.",
              invalid_authorization_request: "This sign-in request expired or was already used. Return to your AI client and try again.",
              recipient_not_allowed: "This address is not enabled for this service. Check it or contact the administrator."
            }};
            throw new Error(messages[data.error] || "We couldn’t send a link. Check the address and try again.");
          }}
          form.hidden = true;
          document.querySelector(".eyebrow").textContent = "PRIVATE CONNECTION · REQUEST ACCEPTED";
          document.querySelector("h1").textContent = "Check your inbox.";
          document.querySelector(".intro").textContent = "The request was accepted by the mail service. Check the inbox for the address you entered; the one-time link expires in 10 minutes.";
          setStatus("No profile access is granted yet. You’ll review and approve permissions after opening the link.", "success");
        }} catch (error) {{
          button.disabled = false;
          button.textContent = "Send sign-in link";
          setStatus(error instanceof TypeError ? "Could not reach the sign-in service. Check your connection and try again." : error.message, "error");
        }} finally {{
          form.setAttribute("aria-busy", "false");
        }}
      }});
    }})();
  </script>
</body>
</html>"""
