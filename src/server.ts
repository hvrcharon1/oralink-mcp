/**
 * OraLink MCP — Express application entry point.
 *
 * Endpoints:
 *   GET  /.well-known/oauth-authorization-server  RFC 8414 discovery doc
 *   GET  /oauth/authorize                         OAuth consent / setup form
 *   POST /oauth/authorize                         Save connection + issue code
 *   POST /oauth/token                             Token exchange
 *   POST /mcp                                     MCP (StreamableHTTP)
 *   GET  /mcp                                     MCP SSE probe
 *   DELETE /mcp                                   MCP session teardown
 *   GET  /health                                  Liveness check
 */
import 'dotenv/config';
import express from 'express';
import helmet  from 'helmet';
import cors    from 'cors';
import morgan  from 'morgan';
import { config }       from './config.js';
import { oauthRouter }  from './auth/oauth.js';
import { mcpHandler }   from './mcp/server.js';
import { closeAllPools } from './oracle/pool.js';
import { logger }       from './logger.js';

const app = express();

// ── Middleware ───────────────────────────────────────────────────────────────

app.use(helmet({ contentSecurityPolicy: false })); // CSP off so OAuth form renders
app.use(cors());
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── OAuth discovery (RFC 8414) ───────────────────────────────────────────────
// Claude.ai fetches this document to auto-discover the OAuth endpoints.

app.get('/.well-known/oauth-authorization-server', (_req, res) => {
  const base = config.server.baseUrl;
  res.json({
    issuer:                                base,
    authorization_endpoint:                `${base}/oauth/authorize`,
    token_endpoint:                        `${base}/oauth/token`,
    response_types_supported:              ['code'],
    grant_types_supported:                 ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['client_secret_post'],
    scopes_supported:                      ['oracle:read', 'oracle:write'],
    code_challenge_methods_supported:      ['S256'],
  });
});

// ── OAuth routes ───────────────────────────────────────────────────────────────

app.use('/oauth', oauthRouter);

// ── MCP endpoint ───────────────────────────────────────────────────────────────

app.post(  '/mcp', mcpHandler);
app.get(   '/mcp', mcpHandler); // SSE capability probe
app.delete('/mcp', mcpHandler); // Session teardown

// ── Health ────────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'oralink-mcp', version: '0.1.0' });
});

// ── Graceful shutdown ────────────────────────────────────────────────────────────

async function shutdown(signal: string) {
  logger.info(`${signal} received — closing Oracle pools...`);
  await closeAllPools();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT',  () => void shutdown('SIGINT'));

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(config.server.port, config.server.host, () => {
  logger.info(`OraLink MCP ready`);
  logger.info(`  MCP   → ${config.server.baseUrl}/mcp`);
  logger.info(`  OAuth → ${config.server.baseUrl}/oauth/authorize`);
  logger.info(`  OIDC  → ${config.server.baseUrl}/.well-known/oauth-authorization-server`);
});

export { app };
