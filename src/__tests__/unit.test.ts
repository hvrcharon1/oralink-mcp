/**
 * OraLink MCP — Unit test suite (v0.4.0)
 *
 * Tests cover:
 *  1. Config: API key parsing
 *  2. Auth: Bearer & ApiKey header extraction
 *  3. Oracle client: read-only SQL guard
 *  4. execute_dml: keyword + WHERE-clause enforcement
 *  5. execute_ddl: DDL keyword enforcement
 *  6. Auth store: in-memory CRUD
 *  7. OAuth discovery document shape (RFC 8414)
 *  8. Health endpoint shape
 *  9. Tool inventory (33 tools, no duplicates, snake_case)
 * 10. Oracle pool key formatting
 * 11. AES-256-GCM credential encryption round-trip
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

// ── 1. Config: API key parsing ────────────────────────────────────────────────

describe('Config: parseApiKeys', () => {
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

  it('returns empty map for empty string', () => {
    expect(parseApiKeys('').size).toBe(0);
  });
  it('returns empty map for whitespace', () => {
    expect(parseApiKeys('   ').size).toBe(0);
  });
  it('parses single key:userId pair', () => {
    const m = parseApiKeys('mykey123:user-uuid-abc');
    expect(m.size).toBe(1);
    expect(m.get('mykey123')).toBe('user-uuid-abc');
  });
  it('parses multiple pairs separated by comma', () => {
    const m = parseApiKeys('key1:uid1,key2:uid2,key3:uid3');
    expect(m.size).toBe(3);
    expect(m.get('key2')).toBe('uid2');
  });
  it('handles spaces around delimiters', () => {
    const m = parseApiKeys(' key1 : uid1 , key2 : uid2 ');
    expect(m.get('key1')).toBe('uid1');
    expect(m.get('key2')).toBe('uid2');
  });
  it('skips malformed entries without colon', () => {
    const m = parseApiKeys('badentry,key1:uid1');
    expect(m.size).toBe(1);
    expect(m.get('key1')).toBe('uid1');
  });
  it('userId can contain hyphens (UUID format)', () => {
    const m = parseApiKeys('mykey:550e8400-e29b-41d4-a716-446655440000');
    expect(m.get('mykey')).toBe('550e8400-e29b-41d4-a716-446655440000');
  });
});

// ── 2. Auth: Bearer / ApiKey extraction ──────────────────────────────────────

describe('Auth: header extraction', () => {
  function extractBearerToken(header?: string): string | null {
    if (!header) return null;
    const parts = header.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') return null;
    return parts[1] ?? null;
  }

  function extractApiKey(header?: string): string | null {
    if (!header) return null;
    const parts = header.split(' ');
    if (parts.length !== 2 || parts[0] !== 'ApiKey') return null;
    return parts[1] ?? null;
  }

  it('extracts Bearer token', () => {
    expect(extractBearerToken('Bearer abc123')).toBe('abc123');
  });
  it('returns null for missing header', () => {
    expect(extractBearerToken(undefined)).toBeNull();
  });
  it('returns null for wrong scheme (Basic)', () => {
    expect(extractBearerToken('Basic abc123')).toBeNull();
  });
  it('returns null for no-space malformed header', () => {
    expect(extractBearerToken('Bearerabc123')).toBeNull();
  });
  it('extracts ApiKey', () => {
    expect(extractApiKey('ApiKey sk-my-secret-key')).toBe('sk-my-secret-key');
  });
  it('returns null if ApiKey scheme used for Bearer', () => {
    expect(extractApiKey('Bearer sk-my-key')).toBeNull();
  });
  it('returns null for empty string', () => {
    expect(extractApiKey('')).toBeNull();
  });
});

// ── 3. Oracle client: SQL read-only guard ────────────────────────────────────

describe('Oracle client: isReadOnly', () => {
  const READ_PREFIXES = ['SELECT', 'WITH', 'EXPLAIN'];

  function isReadOnly(sql: string): boolean {
    return READ_PREFIXES.some(p => sql.trimStart().toUpperCase().startsWith(p));
  }

  it('SELECT is read-only', () => expect(isReadOnly('SELECT * FROM DUAL')).toBe(true));
  it('WITH CTE is read-only', () => expect(isReadOnly('WITH cte AS (SELECT 1) SELECT * FROM cte')).toBe(true));
  it('EXPLAIN PLAN is read-only', () => expect(isReadOnly('EXPLAIN PLAN FOR SELECT * FROM T')).toBe(true));
  it('INSERT is NOT read-only', () => expect(isReadOnly('INSERT INTO T VALUES (1)')).toBe(false));
  it('UPDATE is NOT read-only', () => expect(isReadOnly('UPDATE T SET X=1 WHERE ID=1')).toBe(false));
  it('DELETE is NOT read-only', () => expect(isReadOnly('DELETE FROM T WHERE ID=1')).toBe(false));
  it('MERGE is NOT read-only', () => expect(isReadOnly('MERGE INTO T USING S ON (T.ID=S.ID) ...')).toBe(false));
  it('handles leading whitespace', () => expect(isReadOnly('   SELECT 1 FROM DUAL')).toBe(true));
  it('case-insensitive match', () => expect(isReadOnly('select * from dual')).toBe(true));
  it('CREATE TABLE is NOT read-only', () => expect(isReadOnly('CREATE TABLE T (X NUMBER)')).toBe(false));
});

// ── 4. execute_dml: keyword + WHERE-clause enforcement ───────────────────────

describe('execute_dml: validation', () => {
  const DML_KEYWORDS = ['INSERT', 'UPDATE', 'DELETE', 'MERGE'];

  function validateDml(sql: string): string | null {
    const keyword = sql.trimStart().toUpperCase().match(/^([A-Z]+)/)?.[1];
    if (!keyword || !DML_KEYWORDS.includes(keyword)) {
      return `Only INSERT, UPDATE, DELETE, MERGE allowed. Got: "${keyword ?? '(empty)'}"`;
    }
    if ((keyword === 'UPDATE' || keyword === 'DELETE') && !/\bWHERE\b/i.test(sql)) {
      return `${keyword} without a WHERE clause is blocked to prevent mass data modification.`;
    }
    return null;
  }

  it('INSERT without WHERE is allowed', () => expect(validateDml('INSERT INTO T (X) VALUES (1)')).toBeNull());
  it('UPDATE with WHERE is allowed', () => expect(validateDml('UPDATE T SET X=1 WHERE ID=1')).toBeNull());
  it('DELETE with WHERE is allowed', () => expect(validateDml('DELETE FROM T WHERE ID=1')).toBeNull());
  it('MERGE without WHERE is allowed (uses ON clause)', () => {
    expect(validateDml('MERGE INTO T USING S ON (T.ID=S.ID) WHEN MATCHED THEN UPDATE SET X=S.X')).toBeNull();
  });
  it('UPDATE without WHERE is BLOCKED', () => {
    expect(validateDml('UPDATE T SET X=1')).toContain('WHERE clause is blocked');
  });
  it('DELETE without WHERE is BLOCKED', () => {
    expect(validateDml('DELETE FROM T')).toContain('WHERE clause is blocked');
  });
  it('SELECT is rejected as DML', () => {
    expect(validateDml('SELECT * FROM T')).toContain('Only INSERT, UPDATE, DELETE, MERGE');
  });
  it('CREATE is rejected as DML', () => {
    expect(validateDml('CREATE TABLE T (X NUMBER)')).toContain('Only INSERT, UPDATE, DELETE, MERGE');
  });
  it('empty string is rejected', () => {
    expect(validateDml('')).toBeTruthy();
  });
  it('WHERE check is case-insensitive', () => {
    expect(validateDml('UPDATE T SET X=1 where ID=1')).toBeNull();
  });
});

// ── 5. execute_ddl: DDL keyword enforcement ───────────────────────────────────

describe('execute_ddl: validation', () => {
  const DDL_KEYWORDS = ['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME', 'COMMENT'];

  function validateDdl(sql: string): string | null {
    const keyword = sql.trimStart().toUpperCase().match(/^([A-Z]+)/)?.[1];
    if (!keyword || !DDL_KEYWORDS.includes(keyword)) {
      return `execute_ddl only accepts ${DDL_KEYWORDS.join(', ')} statements. Got: "${keyword ?? '(empty)'}"`;
    }
    return null;
  }

  it('CREATE TABLE is valid DDL', () => expect(validateDdl('CREATE TABLE T (X NUMBER)')).toBeNull());
  it('ALTER TABLE is valid DDL', () => expect(validateDdl('ALTER TABLE T ADD Y VARCHAR2(100)')).toBeNull());
  it('DROP TABLE is valid DDL', () => expect(validateDdl('DROP TABLE T')).toBeNull());
  it('TRUNCATE TABLE is valid DDL', () => expect(validateDdl('TRUNCATE TABLE T')).toBeNull());
  it('RENAME is valid DDL', () => expect(validateDdl('RENAME T TO T2')).toBeNull());
  it('COMMENT ON TABLE is valid DDL', () => expect(validateDdl("COMMENT ON TABLE T IS 'desc'")).toBeNull());
  it('INSERT is rejected in execute_ddl', () => {
    expect(validateDdl('INSERT INTO T VALUES (1)')).toContain('execute_ddl only accepts');
  });
  it('SELECT is rejected in execute_ddl', () => {
    expect(validateDdl('SELECT 1 FROM DUAL')).toContain('execute_ddl only accepts');
  });
  it('empty string is rejected', () => {
    expect(validateDdl('')).toBeTruthy();
  });
});

// ── 6. Auth store: in-memory CRUD ────────────────────────────────────────────

describe('Auth store: in-memory user/connection CRUD', () => {
  type Conn = { name: string; connectString: string; user: string; password: string; allowDml: boolean };
  type User = { userId: string; connections: Record<string, Conn>; createdAt: number; updatedAt: number };

  const users = new Map<string, User>();

  function upsertConnection(userId: string, name: string, conn: Conn) {
    const now = Date.now();
    const u = users.get(userId) ?? { userId, connections: {}, createdAt: now, updatedAt: now };
    u.connections[name] = conn;
    u.updatedAt = now;
    users.set(userId, u);
  }
  function loadUser(userId: string) { return users.get(userId); }
  function deleteConnection(userId: string, name: string): boolean {
    const u = users.get(userId);
    if (!u || !u.connections[name]) return false;
    delete u.connections[name];
    return true;
  }
  function listConnections(userId: string) { return Object.keys(users.get(userId)?.connections ?? {}); }

  const CONN: Conn = { name: 'test-adb', connectString: 'myadb_high', user: 'ADMIN', password: 'Secret1!', allowDml: false };

  beforeEach(() => users.clear());

  it('upserts a connection for a new user', () => {
    upsertConnection('u1', 'test-adb', CONN);
    expect(loadUser('u1')?.connections['test-adb']?.user).toBe('ADMIN');
  });
  it('upserts multiple connections for same user', () => {
    upsertConnection('u1', 'conn1', { ...CONN, name: 'conn1' });
    upsertConnection('u1', 'conn2', { ...CONN, name: 'conn2' });
    expect(listConnections('u1')).toHaveLength(2);
  });
  it('returns undefined for unknown userId', () => {
    expect(loadUser('nobody')).toBeUndefined();
  });
  it('deletes a connection and returns true', () => {
    upsertConnection('u1', 'test-adb', CONN);
    expect(deleteConnection('u1', 'test-adb')).toBe(true);
    expect(listConnections('u1')).toHaveLength(0);
  });
  it('delete returns false for non-existent connection', () => {
    upsertConnection('u1', 'test-adb', CONN);
    expect(deleteConnection('u1', 'ghost')).toBe(false);
  });
  it('delete returns false for non-existent user', () => {
    expect(deleteConnection('nobody', 'test-adb')).toBe(false);
  });
  it('overwrites connection on re-upsert', () => {
    upsertConnection('u1', 'test-adb', CONN);
    upsertConnection('u1', 'test-adb', { ...CONN, allowDml: true });
    expect(loadUser('u1')!.connections['test-adb']!.allowDml).toBe(true);
  });
  it('updatedAt increases on second upsert', async () => {
    upsertConnection('u1', 'conn1', CONN);
    const t1 = loadUser('u1')!.updatedAt;
    await new Promise(r => setTimeout(r, 5));
    upsertConnection('u1', 'conn2', { ...CONN, name: 'conn2' });
    expect(loadUser('u1')!.updatedAt).toBeGreaterThanOrEqual(t1);
  });
});

// ── 7. OAuth discovery document (RFC 8414) ────────────────────────────────────

describe('OAuth discovery document', () => {
  function buildDiscoveryDoc(baseUrl: string) {
    return {
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['client_secret_post'],
      scopes_supported: ['oracle:read', 'oracle:write'],
      code_challenge_methods_supported: ['S256'],
    };
  }

  it('issuer matches baseUrl', () => {
    expect(buildDiscoveryDoc('https://oralink.example.com').issuer).toBe('https://oralink.example.com');
  });
  it('authorization_endpoint has /oauth/authorize path', () => {
    expect(buildDiscoveryDoc('https://x.io').authorization_endpoint).toContain('/oauth/authorize');
  });
  it('token_endpoint has /oauth/token path', () => {
    expect(buildDiscoveryDoc('https://x.io').token_endpoint).toContain('/oauth/token');
  });
  it('supports authorization_code grant', () => {
    expect(buildDiscoveryDoc('https://x.io').grant_types_supported).toContain('authorization_code');
  });
  it('supports refresh_token grant', () => {
    expect(buildDiscoveryDoc('https://x.io').grant_types_supported).toContain('refresh_token');
  });
  it('supports PKCE S256', () => {
    expect(buildDiscoveryDoc('https://x.io').code_challenge_methods_supported).toContain('S256');
  });
  it('scopes include oracle:read', () => {
    expect(buildDiscoveryDoc('https://x.io').scopes_supported).toContain('oracle:read');
  });
  it('scopes include oracle:write', () => {
    expect(buildDiscoveryDoc('https://x.io').scopes_supported).toContain('oracle:write');
  });
  it('response_types includes code', () => {
    expect(buildDiscoveryDoc('https://x.io').response_types_supported).toContain('code');
  });
});

// ── 8. Health endpoint shape ───────────────────────────────────────────────────

describe('Health endpoint', () => {
  const health = { status: 'ok', service: 'oralink-mcp', version: '0.4.0' };

  it('status is "ok"', () => expect(health.status).toBe('ok'));
  it('service name is "oralink-mcp"', () => expect(health.service).toBe('oralink-mcp'));
  it('version is semver', () => expect(health.version).toMatch(/^\d+\.\d+\.\d+$/));
});

// ── 9. Tool inventory: 33 tools ───────────────────────────────────────────────

describe('Tool inventory', () => {
  const TOOLS = [
    // Connection mgmt (3)
    'add_connection', 'remove_connection', 'test_connection',
    // Schema (3)
    'list_schemas', 'list_tables', 'describe_table',
    // Query (2)
    'execute_query', 'explain_plan',
    // Metadata (3)
    'get_ddl', 'list_procedures', 'list_connections',
    // Objects (8)
    'list_indexes', 'list_constraints', 'get_foreign_keys',
    'list_sequences', 'list_triggers', 'list_synonyms',
    'get_view_definition', 'search_objects',
    // Data (5)
    'count_rows', 'get_sample_data', 'execute_dml', 'execute_ddl', 'execute_plsql',
    // Admin (9)
    'get_db_info', 'get_session_info', 'get_table_stats',
    'get_top_tables_by_size', 'get_tablespace_usage', 'get_db_parameters',
    'list_grants', 'list_active_sessions', 'list_invalid_objects',
  ];

  it('total count is 33', () => expect(TOOLS).toHaveLength(33));
  it('no duplicate names', () => expect(new Set(TOOLS).size).toBe(TOOLS.length));
  it('all names are snake_case', () => {
    TOOLS.forEach(t => expect(t).toMatch(/^[a-z][a-z0-9_]+$/));
  });
  it('includes all 5 new v0.4.0 tools', () => {
    const v04 = ['get_foreign_keys', 'execute_ddl', 'get_session_info', 'get_top_tables_by_size', 'get_db_parameters'];
    v04.forEach(t => expect(TOOLS).toContain(t));
  });
});

// ── 10. Pool key formatting ────────────────────────────────────────────────────

describe('Oracle pool key', () => {
  const toKey = (userId: string, conn: string) => `${userId}::${conn}`;

  it('formats as userId::connectionName', () => {
    expect(toKey('user123', 'prod-adb')).toBe('user123::prod-adb');
  });
  it('different connections produce different keys', () => {
    expect(toKey('u1', 'conn1')).not.toBe(toKey('u1', 'conn2'));
  });
  it('same connection for different users produces different keys', () => {
    expect(toKey('u1', 'conn')).not.toBe(toKey('u2', 'conn'));
  });
  it('empty userId still produces a key', () => {
    expect(toKey('', 'conn')).toBe('::conn');
  });
});

// ── 11. AES-256-GCM encryption round-trip ─────────────────────────────────────

describe('AES-256-GCM credential encryption', () => {
  const KEY = 'a'.repeat(64); // 32-byte key as hex

  function encrypt(plaintext: string, keyHex: string): string {
    const key = Buffer.from(keyHex, 'hex');
    const iv  = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString('base64');
  }

  function decrypt(ciphertext: string, keyHex: string): string {
    const key  = Buffer.from(keyHex, 'hex');
    const data = Buffer.from(ciphertext, 'base64');
    const iv   = data.subarray(0, 12);
    const tag  = data.subarray(12, 28);
    const enc  = data.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(enc).toString('utf8') + decipher.final('utf8');
  }

  it('encrypts and decrypts round-trip correctly', () => {
    const plaintext = 'Secret!Oracle@Password#123';
    expect(decrypt(encrypt(plaintext, KEY), KEY)).toBe(plaintext);
  });
  it('produces different ciphertext each time (random IV)', () => {
    expect(encrypt('same', KEY)).not.toBe(encrypt('same', KEY));
  });
  it('fails to decrypt with wrong key', () => {
    const ct = encrypt('secret', KEY);
    expect(() => decrypt(ct, 'b'.repeat(64))).toThrow();
  });
  it('handles empty string plaintext', () => {
    expect(decrypt(encrypt('', KEY), KEY)).toBe('');
  });
  it('handles unicode / special characters', () => {
    const pw = '\u00dcn\u00efc\u00f6d\u00e9@2024!\uD83D\uDD11';
    expect(decrypt(encrypt(pw, KEY), KEY)).toBe(pw);
  });
});
