/**
 * OAuth 2.0 Authorization Server routes.
 *
 * Routes:
 *   GET  /oauth/authorize  — renders the ADB connection setup form
 *   POST /oauth/authorize  — saves connection, redirects with auth code
 *   POST /oauth/token      — exchanges code for access + refresh tokens
 *
 * Auth codes are in-memory with a 5-minute TTL.
 * In production, swap the Map for Redis or OCI Cache.
 */
import { Router, type Request, type Response } from 'express';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { signAccessToken, signRefreshToken, verifyToken, generateUserId } from './tokens.js';
import { upsertConnection } from './store.js';
import { config } from '../config.js';
import type { OracleConnectionConfig } from '../types.js';
import { logger } from '../logger.js';

export const oauthRouter = Router();

// ── Auth code store (TTL: 5 min) ────────────────────────────────────────────
const authCodes = new Map<string, { userId: string; expiresAt: number }>();

function pruneExpiredCodes(): void {
  const now = Date.now();
  for (const [code, entry] of authCodes)
    if (entry.expiresAt < now) authCodes.delete(code);
}

// ── GET /oauth/authorize ───────────────────────────────────────────────
oauthRouter.get('/authorize', (req: Request, res: Response) => {
  const { client_id, redirect_uri, state, response_type } = req.query;

  if (response_type !== 'code')
    return void res.status(400).json({ error: 'unsupported_response_type' });

  res.send(authorizeHtml(
    String(client_id  ?? ''),
    String(redirect_uri ?? ''),
    String(state ?? ''),
  ));
});

// ── POST /oauth/authorize ──────────────────────────────────────────────
const ConnSchema = z.object({
  client_id:       z.string(),
  redirect_uri:    z.string().url(),
  state:           z.string(),
  conn_name:       z.string().min(1).max(64),
  connect_string:  z.string().min(1),
  db_user:         z.string().min(1),
  db_password:     z.string().min(1),
  allow_dml:       z.string().optional(),
  wallet_b64:      z.string().optional(),
  wallet_password: z.string().optional(),
  existing_user_id: z.string().uuid().optional(),
});

oauthRouter.post('/authorize', (req: Request, res: Response) => {
  const parse = ConnSchema.safeParse(req.body);
  if (!parse.success)
    return void res.status(400).json({ error: 'invalid_request', details: parse.error.flatten() });

  const d = parse.data;
  const userId = d.existing_user_id ?? generateUserId();

  const conn: OracleConnectionConfig = {
    name:          d.conn_name,
    connectString: d.connect_string,
    user:          d.db_user,
    password:      d.db_password,
    allowDml:      d.allow_dml === 'on',
    walletContent:  d.wallet_b64,
    walletPassword: d.wallet_password,
  };

  try {
    upsertConnection(userId, d.conn_name, conn);
  } catch (err) {
    logger.error('Failed to save connection', { err });
    return void res.status(500).json({ error: 'server_error' });
  }

  pruneExpiredCodes();
  const code = randomBytes(32).toString('hex');
  authCodes.set(code, { userId, expiresAt: Date.now() + 5 * 60 * 1000 });
  logger.info('Auth code issued', { userId, connName: d.conn_name });

  const redirect = new URL(d.redirect_uri);
  redirect.searchParams.set('code',  code);
  redirect.searchParams.set('state', d.state);
  res.redirect(302, redirect.toString());
});

// ── POST /oauth/token ───────────────────────────────────────────────────
const TokenSchema = z.discriminatedUnion('grant_type', [
  z.object({
    grant_type:    z.literal('authorization_code'),
    code:          z.string(),
    client_id:     z.string(),
    client_secret: z.string(),
    redirect_uri:  z.string().url(),
  }),
  z.object({
    grant_type:    z.literal('refresh_token'),
    refresh_token: z.string(),
    client_id:     z.string(),
    client_secret: z.string(),
  }),
]);

oauthRouter.post('/token', (req: Request, res: Response) => {
  const parse = TokenSchema.safeParse(req.body);
  if (!parse.success)
    return void res.status(400).json({ error: 'invalid_request' });

  const d = parse.data;

  if (d.client_id !== config.oauth.clientId || d.client_secret !== config.oauth.clientSecret)
    return void res.status(401).json({ error: 'invalid_client' });

  if (d.grant_type === 'authorization_code') {
    pruneExpiredCodes();
    const entry = authCodes.get(d.code);
    if (!entry || entry.expiresAt < Date.now())
      return void res.status(400).json({ error: 'invalid_grant' });

    authCodes.delete(d.code);
    return void res.json({
      access_token:  signAccessToken(entry.userId),
      refresh_token: signRefreshToken(entry.userId),
      token_type:    'Bearer',
      expires_in:    config.oauth.tokenExpiry,
    });
  }

  // refresh_token grant
  try {
    const payload = verifyToken(d.refresh_token);
    if (payload.type !== 'refresh') throw new Error('Not a refresh token');
    return void res.json({
      access_token: signAccessToken(payload.sub),
      token_type:   'Bearer',
      expires_in:   config.oauth.tokenExpiry,
    });
  } catch {
    return void res.status(400).json({ error: 'invalid_grant' });
  }
});

// ── OAuth connection setup form ───────────────────────────────────────────
function esc(s: string) {
  return s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function authorizeHtml(clientId: string, redirectUri: string, state: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>OraLink MCP — Connect Oracle ADB</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
         background:#0f172a;color:#e2e8f0;min-height:100vh;
         display:flex;align-items:center;justify-content:center;padding:1rem}
    .card{background:#1e293b;border:1px solid #334155;border-radius:12px;
          padding:2rem;width:100%;max-width:500px}
    .header{display:flex;align-items:center;gap:.75rem;margin-bottom:1.75rem}
    .icon{width:44px;height:44px;background:#f97316;border-radius:10px;
          display:flex;align-items:center;justify-content:center;font-size:1.4rem}
    h1{font-size:1.2rem;font-weight:700;color:#f1f5f9}
    .subtitle{font-size:.8125rem;color:#94a3b8;margin-top:2px}
    .group{margin-top:1.125rem}
    label{display:block;font-size:.8rem;font-weight:500;color:#94a3b8;margin-bottom:.35rem}
    input[type=text],input[type=password]{
      width:100%;padding:.6rem .75rem;background:#0f172a;
      border:1px solid #334155;border-radius:6px;
      color:#e2e8f0;font-size:.9375rem}
    input:focus{outline:none;border-color:#f97316}
    .hint{font-size:.72rem;color:#64748b;margin-top:.3rem}
    hr{border:none;border-top:1px solid #334155;margin:1.25rem 0}
    .row{display:flex;align-items:center;gap:.5rem;margin-top:1rem}
    .row label{margin:0;cursor:pointer}
    button{width:100%;margin-top:1.5rem;padding:.75rem;
           background:#f97316;border:none;border-radius:6px;
           color:#fff;font-size:1rem;font-weight:600;cursor:pointer}
    button:hover{background:#ea6c05}
    .note{margin-top:.875rem;font-size:.72rem;color:#64748b;text-align:center}
  </style>
</head>
<body>
<div class="card">
  <div class="header">
    <div class="icon">🔗</div>
    <div>
      <h1>OraLink MCP</h1>
      <p class="subtitle">Connect Oracle Autonomous Database</p>
    </div>
  </div>

  <form method="POST" action="/oauth/authorize">
    <input type="hidden" name="client_id"    value="${esc(clientId)}">
    <input type="hidden" name="redirect_uri" value="${esc(redirectUri)}">
    <input type="hidden" name="state"        value="${esc(state)}">

    <div class="group">
      <label>Connection name</label>
      <input type="text" name="conn_name" placeholder="my-adb-prod" required>
      <p class="hint">A label for this connection (letters, numbers, hyphens).</p>
    </div>

    <div class="group">
      <label>Connect string</label>
      <input type="text" name="connect_string"
        placeholder="myadb_high or (description=(address=...))"
        required>
      <p class="hint">TLS connect string from OCI → ADB → DB Connection. Paste the full string or just the service alias from tnsnames.ora.</p>
    </div>

    <div class="group">
      <label>Database username</label>
      <input type="text" name="db_user" value="ADMIN" required>
      <p class="hint">OCI ADB creates an <strong style="color:#e2e8f0">ADMIN</strong> user by default. Change only if you connect as a different schema.</p>
    </div>

    <div class="group">
      <label>Admin password</label>
      <input type="password" name="db_password" required>
      <p class="hint">The password you set for the ADMIN user when creating this ADB instance in the OCI Console.</p>
    </div>

    <hr>

    <div class="group">
      <label>Wallet (base64 of wallet.zip) <span style="color:#64748b">— optional for TLS-only</span></label>
      <input type="text" name="wallet_b64" placeholder="base64 -i Wallet_xxx.zip | tr -d '\\n'">
      <p class="hint">Required for mTLS. Leave blank for one-way TLS (ADB-S default since 2023).</p>
    </div>

    <div class="group">
      <label>Wallet password</label>
      <input type="password" name="wallet_password">
      <p class="hint">Only needed when a wallet is provided above.</p>
    </div>

    <div class="row">
      <input type="checkbox" id="allow_dml" name="allow_dml">
      <label for="allow_dml">Allow DML (INSERT / UPDATE / DELETE / MERGE)</label>
    </div>
    <p class="hint" style="margin-top:.3rem">
      Off by default — only SELECT queries are permitted.
    </p>

    <button type="submit">Connect Oracle ADB →</button>
  </form>
  <p class="note">🔒 Credentials are AES-256-GCM encrypted. Wallet is held in memory only.</p>
</div>
</body>
</html>`;
}
