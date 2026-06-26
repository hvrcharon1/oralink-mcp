# MANUAL_STEPS.md — OraLink MCP

Steps that require human action and cannot be automated by the pipeline.

---

## 1. Generate secure secrets (before first run)

```bash
# JWT secret (256-bit)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Encryption key (256-bit)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Paste outputs into `.env` as `OAUTH_JWT_SECRET` and `ENCRYPTION_KEY`.

---

## 2. Submit to Claude.ai / Anthropic MCP marketplace

When submitting for listing:

| Field | Value |
|-------|-------|
| MCP endpoint | `https://your-domain.com/mcp` |
| OAuth Authorization URL | `https://your-domain.com/oauth/authorize` |
| OAuth Token URL | `https://your-domain.com/oauth/token` |
| Discovery URL | `https://your-domain.com/.well-known/oauth-authorization-server` |
| Grant type | `authorization_code` |
| Response type | `code` |

Anthopic will provide a `client_id` and `client_secret`. Set these as
`OAUTH_CLIENT_ID` and `OAUTH_CLIENT_SECRET` in your `.env`.

---

## 3. Get Oracle ADB connection details

From OCI Console → Autonomous Database → your instance:

1. Click **DB Connection**
2. Download wallet `.zip` (for mTLS) OR copy a TLS connection string
3. To convert wallet to base64 for the OAuth form:
   ```bash
   base64 -i Wallet_YourADB.zip | tr -d '\n'
   ```
4. Note your service name from `tnsnames.ora` inside the wallet zip.

---

## 4. Deploy to a public HTTPS endpoint

The MCP server **must** be on HTTPS for Claude.ai. Options:

- **OCI Compute + Nginx + Let's Encrypt** (recommended — keeps data in Oracle's cloud)
- **Railway** / **Render** / **Fly.io** — quick deploys, free tier available
- **Docker** on any VPS with a reverse proxy

---

## 5. Add GitHub Actions secrets (for CI/CD)

Go to: https://github.com/hvrcharon1/oralink-mcp/settings/secrets/actions

Add secrets for your deployment target, e.g.:
- `DOCKER_USERNAME` / `DOCKER_PASSWORD` (for Docker Hub push)
- Deployment API keys for Railway/Render/Fly

---

## 6. Create the v0.1.0 git tag to trigger publish workflow

```bash
git tag v0.1.0
git push origin v0.1.0
```
