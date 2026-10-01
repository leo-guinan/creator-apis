import os

os.environ.setdefault("CREATORAPIS_MCP_PUBLIC_ORIGIN", "http://testserver")
os.environ.setdefault("CREATORAPIS_MCP_PUBLIC_BASE_PATH", "")
os.environ.setdefault(
    "CREATORAPIS_MCP_ALLOWED_REDIRECT_URIS",
    "https://client.example.test/oauth/callback",
)
