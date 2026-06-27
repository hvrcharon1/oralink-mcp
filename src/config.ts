import 'dotenv/config';

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
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
} as const;
