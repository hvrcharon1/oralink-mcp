/**
 * API key authentication for the no-OAuth path.
 *
 * OCI Oracle Autonomous Database does NOT provide its own OAuth server.
 * When a team connects via a public endpoint (OCI network ACL / resource-tag
 * based access control), they can skip the OAuth consent flow entirely and
 * instead authenticate to OraLink MCP with a static pre-shared API key.
 *
 * Flow:
 *   1. Admin generates a key (e.g. openssl rand -hex 32) and a stable userId
 *      (e.g. a UUID), then sets:
 *         ORALINK_API_KEYS=<key>:<userId>[,<key2>:<userId2>]
 *   2. Client sends:  Authorization: ApiKey <key>
 *   3. resolveApiKeyUserId() maps the key → userId
 *   4. The rest of the system (store, oracle pool, MCP tools) is identical to
 *      the OAuth path — it only ever sees a userId string.
 *
 * Clients using this path can then call the `add_connection` MCP tool to
 * register their ADB public-endpoint connect string in-session, without
 * ever visiting the OAuth consent form.
 */
import { config } from '../config.js';

const SCHEME = 'ApiKey ';

/**
 * Extract the raw key from an Authorization header.
 * Returns null if the header is missing or not in ApiKey scheme.
 */
export function extractApiKey(authHeader?: string): string | null {
  if (!authHeader?.startsWith(SCHEME)) return null;
  return authHeader.slice(SCHEME.length).trim() || null;
}

/**
 * Resolve a raw API key to the userId it is bound to.
 * Returns null if the key is unknown (caller should respond 401).
 */
export function resolveApiKeyUserId(key: string): string | null {
  return config.apiKeys.get(key) ?? null;
}

/**
 * True when at least one API key is configured — used to expose
 * the /api-key-info endpoint only when the feature is enabled.
 */
export function apiKeyAuthEnabled(): boolean {
  return config.apiKeys.size > 0;
}
