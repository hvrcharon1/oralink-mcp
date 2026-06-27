// ── Oracle connection ─────────────────────────────────────────────────────

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
  content: McpTextContent[];
  isError?: boolean;
}

export type QueryRow = Record<string, unknown>;
