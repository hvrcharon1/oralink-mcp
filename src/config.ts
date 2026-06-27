import 'dotenv/config';

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

/**
 * Parse ORALINK_API_KEYS environment variable.
 *
 * Format: comma-separated list of  key:userId  pairs.
 * Example:
 *   ORALINK_API_KEYS=sk-alice-abc123:alice-uuid,sk-bob-xyz999:bob-uuid
 *
 * This enables the no-OAuth path for OCI ADB public-endpoint connections.
 * Each API key maps to a fixed userId so credential storage works identically
 * to the OAuth path — the rest of the system is unaware of how auth happened.
 */
function parseApiKeys(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw.trim()) return map;
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf(':');
    if (idx < 1) continue;
    const key    = pair.slice(0, idx).trim();
    const userId = pair.slice(idx + 1).trim();
    if (key && userId) map.set(key, userId);
  }
  return map;
}

export const config = {
  server: {
    port: parseInt(optional('PORT', '3000'), 10),
    host: optional('HOST', '0.0.0.0'),
    nodeEnv: optional('NODE_ENV', 'development'),
    get baseUrl() {
      const scheme = this.nodeEnv === 'production' ? 'https' : 'http';
      return optional('BASE_URL', `${scheme}://localhost:${this.port}`);
    },
  },
  oauth: {
    jwtSecret: optional('OAUTH_JWT_SECRET', 'dev_secret_CHANGE_IN_PRODUCTION'),
    tokenExpiry:        parseInt(optional('OAUTH_TOKEN_EXPIRY',         '3600'),    10),
    refreshTokenExpiry: parseInt(optional('OAUTH_REFRESH_TOKEN_EXPIRY', '2592000'), 10),
    clientId:     optional('OAUTH_CLIENT_ID',     'oralink-mcp-client'),
    clientSecret: optional('OAUTH_CLIENT_SECRET', 'dev_client_secret'),
    redirectUri:  optional('OAUTH_REDIRECT_URI',  'http://localhost:3000/oauth/callback'),
  },
  encryption: {
    // Must be 64 hex chars (32 bytes). Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
    key: optional('ENCRYPTION_KEY', '0'.repeat(64)),
  },
  logging: {
    level: optional('LOG_LEVEL', 'info'),
  },
  /**
   * Static API keys for the no-OAuth path (OCI ADB public endpoints).
   * Populated from ORALINK_API_KEYS env var at startup.
   * key → userId
   */
  apiKeys: parseApiKeys(optional('ORALINK_API_KEYS', '')),
} as const;
