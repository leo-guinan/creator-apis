# Creator APIs Python MCP reference implementation

This is a local-first reference MCP service for enrolling verified-email profiles and collecting privacy-bounded, self-reported capability profiles. It is intentionally not a production deployment. The parent repository's architecture documents remain normative for the broader system.

## What it implements

- OAuth 2.0 Authorization Code + PKCE, profile-scoped tokens, and verified-email sign-in.
- Exactly two ordinary-user MCP tools: get the profile prompt/evaluation state; create, calibrate, lock, pause, or use an evaluation to deliver a passing profile projection.
- A versioned, user-scoped evaluation policy. Calibration records contain only a sample SHA-256 digest, client-reported evaluator decision, user label, and bounded feedback tags—not the sample itself.
- A one-time policy lock. Locking authorizes future passing projections to be delivered automatically to that authenticated profile; it does not authorize public posting, email, purchases, or other destinations. Pausing stops delivery; create and calibrate a new version to resume under a changed policy.
- Daily event counts by date and self-reported category. Duplicate date/category rows are aggregated.
- Validation excluding raw transcripts, personal contact fields in the profile projection, URLs, credentials, token counts, and spend.

A locked evaluation is a calibrated prediction of likely acceptance, not knowledge or certainty. The MCP service does not run an independent evaluator: criterion decisions and calibration labels are supplied by the client and marked client-reported. The server binds the report to the exact profile payload hash, computes the score, enforces the locked threshold and mandatory privacy/energy checks, and stores an evaluation receipt hash. A hash proves byte-level linkage, not that an evaluator ran honestly.

The `LOCK <eval_id>` phrase is also client-reported. This prototype cannot prove that a human, rather than the AI client, entered it. Do not treat it as cryptographic human consent. The setup page states this boundary. Before using the flow for unattended delivery on a public service, provide an independently authenticated policy-lock/pause control and add rate limiting, bot protection, abuse handling, and moderation.

Profile narratives and event counts are `self_reported`; capability claims are `self_reported_unverified`; category taxonomy is `self_reported_noncanonical`. No raw history is fetched by the server. No production data migration, public email action, or public publishing path is included.

## Local setup

Python 3.11 or newer is required.

```bash
cd implementations/python-mcp
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e '.[test]'
pytest -q
```

Run the service locally:

```bash
export CREATORAPIS_MCP_PUBLIC_ORIGIN=http://127.0.0.1:8000
export CREATORAPIS_MCP_IDENTITY_KEY="$(python -c 'import secrets; print(secrets.token_urlsafe(32))')"
export CREATORAPIS_MCP_DB="$PWD/data/artifacts.sqlite3"
uvicorn creatorapis_mcp.app:app --app-dir src --host 127.0.0.1 --port 8000
```

The service creates its SQLite tables at startup. The database path should be private and excluded from version control. The repository `.gitignore` excludes SQLite database and WAL files.

## Configuration

| Variable | Purpose |
| --- | --- |
| `CREATORAPIS_MCP_PUBLIC_ORIGIN` | Public origin used in OAuth/resource metadata. Use loopback for local work. |
| `CREATORAPIS_MCP_PUBLIC_BASE_PATH` | Optional path prefix for a reverse-proxy deployment. |
| `CREATORAPIS_MCP_DB` | SQLite database path. Keep the database private. |
| `CREATORAPIS_MCP_IDENTITY_KEY` | Required key of at least 32 bytes for keyed email digests. Keep in protected environment configuration; never commit it. |
| `CREATORAPIS_MCP_OPEN_REGISTRATION` | Opt-in switch (`true`/`1`). Defaults off. Do not enable for public service without enrollment abuse controls. |
| `CREATORAPIS_MCP_AUTH_EMAILS` | Optional email allowlist when open registration is off. |
| `CREATORAPIS_MCP_ALLOWED_REDIRECT_URIS` | Comma-separated exact OAuth callback allowlist. |
| `CREATORAPIS_MCP_EMAIL_RELAY_URL` | Authorized transactional email relay endpoint. |
| `CREATORAPIS_MCP_EMAIL_RELAY_TOKEN` | Relay credential; keep it out of source, logs, and test fixtures. |

The test suite replaces the email send function with a mock and does not send email. To test actual login delivery, configure an authorized relay in a private environment; a relay acceptance is not proof of inbox delivery.

## Evaluation lifecycle

1. The AI client and user agree on the rubric, threshold, minimum calibration count (3–20), and owner-profile auto-delivery scope. Privacy and daily-energy checks are mandatory.
2. The client evaluates examples locally and asks the user for `approve`, `revise`, or `reject` feedback. The tool receives only an opaque sample hash, decisions, and bounded tags.
3. Locking is rejected until the minimum number of distinct calibration samples exists and there are zero observed false passes (the evaluator said `pass` while the user said `revise` or `reject`). The client must present the immutable policy and calibration summary before issuing the lock phrase.
4. After locking, `deliver` requires a locked policy, a report for every rubric criterion, the exact canonical payload hash, passing mandatory checks, and a score at or above the threshold. No per-submission approval phrase is used.
5. A policy is immutable after lock. A later evaluation version supersedes the prior locked version when it locks. A paused evaluation does not resume; create a new version.

The service's score is derived from client-supplied pass/fail checks. It is not an independent judgment, truth label, measured capability, or proof of user intent. Human calibration examples remain on the client side; only hashes and bounded labels are stored by this server.

## MCP client setup

Configure an MCP client to use the server's Streamable HTTP endpoint:

```text
http://127.0.0.1:8000/mcp
```

The endpoint requires OAuth authorization. `/setup` provides a local connection page; `/health` is only a health check and does not prove MCP compatibility. An integration test uses the official MCP Python SDK 1.x Streamable HTTP client against the FastAPI ASGI app, verifies initialization, lists exactly two tools, and calls the prompt tool. This exercises protocol behavior in-process; it does not verify a public network deployment, real email delivery, browser authorization, or compatibility with every AI client.

## Verification

```bash
pytest -q
python -m compileall -q src tests
ruff check src tests
ruff format --check src tests
```

The end-to-end tests use a mocked email sender, complete verified-email enrollment/OAuth/PKCE, create and calibrate an evaluation, lock it, and auto-deliver a privacy-bounded projection. They also test profile isolation, privacy rejection, payload binding, false-pass rejection, pause behavior, and aggregated event counts. An official MCP client integration test covers initialize, tool discovery, and a tool call against the in-process ASGI app. These local tests do not establish production readiness or real email delivery.
