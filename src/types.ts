// ── Oracle connection ─────────────────────────────────────────────────────

/**
 * How this connection entry was created:
 *  - 'oauth'  — registered via the OAuth 2.0 consent form
 *  - 'apikey' — registered via the add_connection MCP tool using the
 *               no-OAuth / static API key path (OCI ADB public endpoint)
 */
export type ConnectionType = 'oauth' | 'apikey';

export interface OracleConnectionConfig {
  /** Friendly label for this connection */
  name: string;
  /** TNS connect string or host:port/service */
  connectString: string;
  /** Database username */
  user: string;
  /** Database password — stored encrypted */
  password: string;
  /** Whether DML (INSERT/UPDATE/DELETE/MERGE) is permitted via MCP tools */
  allowDml: boolean;
  /** Wallet .zip as base64 (mTLS) — kept in memory only, never on disk */
  walletContent?: string;
  /** Wallet password */
  walletPassword?: string;
  /**
   * How this connection was registered.
   * Defaults to 'oauth' for backwards compatibility with existing entries.
   */
  connectionType?: ConnectionType;
}

export interface StoredUser {
  userId: string;
  connections: Record<string, OracleConnectionConfig>;
  createdAt: number;
  updatedAt: number;
}

// ── OAuth ─────────────────────────────────────────────────────────────────

export interface OAuthTokenPayload {
  sub: string;            // userId
  iat: number;
  exp: number;
  type: 'access' | 'refresh';
}

// ── MCP ───────────────────────────────────────────────────────────────────

export interface McpTextContent {
  type: 'text';
  text: string;
}

export interface McpToolResult {
  [x: string]: unknown;
  content: McpTextContent[];
  isError?: boolean;
}

export type QueryRow = Record<string, unknown>;
