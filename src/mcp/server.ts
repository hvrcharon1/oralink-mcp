/**
 * MCP Server — StreamableHTTP transport.
 *
 * A fresh McpServer is instantiated per request with the authenticated
 * userId in closure scope. This keeps the auth model simple and stateless:
 * no session registry, no shared mutable state between users.
 *
 * Transport: StreamableHTTP — the transport required for cloud-hosted,
 * OAuth-authenticated MCP connectors listed on Claude.ai marketplace.
 *
 * Auth schemes supported:
 *   1. Bearer <jwt>   — standard OAuth 2.0 access token (Claude.ai marketplace)
 *   2. ApiKey <key>   — static pre-shared key mapped to a userId in
 *                       ORALINK_API_KEYS env var (OCI ADB public-endpoint path)
 *
 * Tool inventory (28 total):
 *   Connection mgmt : add_connection, remove_connection, test_connection
 *   Schema          : list_connections, list_schemas, list_tables, describe_table
 *   Query           : execute_query, explain_plan
 *   Metadata        : get_ddl, list_procedures
 *   Objects         : list_indexes, list_constraints, list_sequences, list_triggers,
 *                     list_synonyms, get_view_definition, search_objects
 *   Data            : count_rows, get_sample_data, execute_dml, execute_plsql
 *   Admin           : get_db_info, get_table_stats, get_tablespace_usage,
 *                     list_grants, list_active_sessions, list_invalid_objects
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { Request, Response } from 'express';
import { handleSchemaTools }   from '../tools/schema.js';
import { handleQueryTools }    from '../tools/query.js';
import { handleMetadataTools } from '../tools/metadata.js';
import { handleObjectTools }   from '../tools/objects.js';
import { handleDataTools }     from '../tools/data.js';
import { handleAdminTools }    from '../tools/admin.js';
import { verifyToken, extractBearerToken } from '../auth/tokens.js';
import { extractApiKey, resolveApiKeyUserId } from '../auth/apikey.js';
import { listConnections, upsertConnection, deleteConnection, loadUser } from '../auth/store.js';
import { getOrCreatePool, closePool } from '../oracle/pool.js';
import { logger } from '../logger.js';
import type { OracleConnectionConfig } from '../types.js';
import oracledb from 'oracledb';

// ── Resolve userId from any supported auth scheme ─────────────────────────

function resolveUserId(authHeader?: string): string | null {
  // Try OAuth Bearer first
  const bearer = extractBearerToken(authHeader);
  if (bearer) {
    try {
      const payload = verifyToken(bearer);
      if (payload.type !== 'access') return null;
      return payload.sub;
    } catch {
      return null;
    }
  }

  // Try static API key
  const apiKey = extractApiKey(authHeader);
  if (apiKey) {
    return resolveApiKeyUserId(apiKey);
  }

  return null;
}

// ── Server factory (one per request) ─────────────────────────────────────────

function buildServer(userId: string): McpServer {
  const server = new McpServer({
    name:    'oralink-mcp',
    version: '0.3.0',
  });

  // ── Connection management tools ────────────────────────────────────────
  //
  // These tools are the primary entry point for the no-OAuth / API-key path.
  // A user authenticates with a static API key (Authorization: ApiKey <key>)
  // and then calls add_connection to register their OCI ADB public-endpoint
  // connect string without ever visiting the OAuth consent form.
  //
  // OCI ADB public-endpoint setup (no wallet needed since ADB-S TLS became
  // one-way by default in 2023):
  //   1. In OCI Console → ADB → Network → set "Access Control" to allow your
  //      server's IP (or tag the network with your VCN/IP CIDR).
  //   2. Copy the TLS connect string from "DB Connection" (the one that does
  //      NOT require a wallet — e.g. "myadb_high.adb.us-chicago-1.oraclecloud.com").
  //   3. Call add_connection with that string. No wallet required.

  server.tool(
    'add_connection',
    [
      'Register a new Oracle ADB connection for this account.',
      '',
      'For OCI Autonomous Database public-endpoint connections (no OAuth required):',
      '  1. In OCI Console → your ADB → Network → Access Control List, add the IP of this',
      '     OraLink server (or set a network tag that includes it).',
      '  2. Under DB Connection, download the public TLS connect string (NOT the wallet',
      '     download — the plain TLS string that works without a wallet).',
      '  3. Call this tool with connect_string = that TLS string, db_user = ADMIN (or your',
      '     user), and db_password = your ADB password. No wallet needed for public TLS.',
      '',
      'For mTLS (private endpoint or legacy ADB): also provide wallet_b64 (base64 of',
      'wallet.zip) and wallet_password.',
    ].join('\n'),
    {
      connection_name:  z.string().min(1).max(64)
                          .describe('Friendly label for this connection (e.g. "prod-adb", "dev").'),
      connect_string:   z.string().min(1)
                          .describe(
                            'Oracle TLS connect string or host:port/service. '
                            + 'For OCI ADB public endpoint: copy from OCI Console → ADB → DB Connection '
                            + '→ "TLS" tab (no wallet required). '
                            + 'Example: "(description=(retry_count=20)(retry_delay=3)(address=(protocol=tcps)'
                            + '(port=1522)(host=adb.us-ashburn-1.oraclecloud.com))(connect_data=(service_name='
                            + 'g123abc456_mydb_high.adb.oraclecloud.com))(security=(ssl_server_dn_match=yes)))"'
                          ),
      db_user:          z.string().min(1).describe('Database username (e.g. ADMIN).'),
      db_password:      z.string().min(1).describe('Database password.'),
      allow_dml:        z.boolean().default(false)
                          .describe('Allow INSERT / UPDATE / DELETE / MERGE via MCP tools. Default: false (read-only).'),
      wallet_b64:       z.string().optional()
                          .describe('Base64-encoded wallet.zip for mTLS. Not needed for ADB public-endpoint TLS connections.'),
      wallet_password:  z.string().optional()
                          .describe('Wallet password (only needed when wallet_b64 is provided).'),
    },
    async (args) => {
      const conn: OracleConnectionConfig = {
        name:           args.connection_name,
        connectString:  args.connect_string,
        user:           args.db_user,
        password:       args.db_password,
        allowDml:       args.allow_dml,
        walletContent:  args.wallet_b64,
        walletPassword: args.wallet_password,
        connectionType: 'apikey',
      };
      try {
        upsertConnection(userId, args.connection_name, conn);
        logger.info('Connection added via MCP tool', { userId, name: args.connection_name });
        return {
          content: [{
            type: 'text' as const,
            text: [
              `✅ Connection "${args.connection_name}" registered successfully.`,
              ``,
              `Details:`,
              `  Connect string : ${args.connect_string}`,
              `  User           : ${args.db_user}`,
              `  DML allowed    : ${args.allow_dml}`,
              `  Wallet         : ${args.wallet_b64 ? 'provided (mTLS)' : 'none (TLS — public endpoint)'}`,
              ``,
              `Use list_connections to see all connections, or test_connection to verify it works.`,
            ].join('\n'),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `❌ Failed to save connection: ${String(err)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'remove_connection',
    'Remove a registered Oracle ADB connection from this account. This does not affect the database itself.',
    {
      connection_name: z.string().describe('Name of the connection to remove.'),
    },
    async ({ connection_name }) => {
      const removed = deleteConnection(userId, connection_name);
      // Also tear down the pool if one exists
      await closePool({ userId, connectionName: connection_name }).catch(() => {});
      return {
        content: [{
          type: 'text' as const,
          text: removed
            ? `✅ Connection "${connection_name}" removed.`
            : `⚠️ Connection "${connection_name}" not found — nothing removed.`,
        }],
      };
    },
  );

  server.tool(
    'test_connection',
    [
      'Test an Oracle ADB connection by running SELECT 1 FROM DUAL.',
      'Returns the Oracle banner (version string) on success.',
      '',
      'Use this immediately after add_connection to verify the connect string,',
      'credentials, and network path (ACL/tag) are all correct.',
    ].join('\n'),
    {
      connection: z.string().describe('Connection name to test.'),
    },
    async ({ connection }) => {
      const user = loadUser(userId);
      if (!user) {
        return { content: [{ type: 'text' as const, text: '❌ No connections registered for this account.' }], isError: true };
      }
      const conn = user.connections[connection];
      if (!conn) {
        return { content: [{ type: 'text' as const, text: `❌ Connection "${connection}" not found. Call list_connections to see registered names.` }], isError: true };
      }

      try {
        const pool   = await getOrCreatePool({ userId, connectionName: connection }, conn);
        const dbConn = await pool.getConnection();
        try {
          // Ping: SELECT banner from V$VERSION to get Oracle version string
          const result = await dbConn.execute<{ BANNER: string }>(
            `SELECT BANNER FROM V$VERSION WHERE ROWNUM = 1`,
            [],
            { outFormat: oracledb.OUT_FORMAT_OBJECT },
          );
          const banner = result.rows?.[0]?.BANNER ?? 'Connected (banner unavailable)';
          return {
            content: [{
              type: 'text' as const,
              text: [
                `✅ Connection "${connection}" is working.`,
                ``,
                `Oracle version: ${banner}`,
                `Connect string: ${conn.connectString}`,
                `User          : ${conn.user}`,
                `Auth path     : ${conn.connectionType ?? 'oauth'}`,
              ].join('\n'),
            }],
          };
        } finally {
          await dbConn.close().catch(() => {});
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{
            type: 'text' as const,
            text: [
              `❌ Connection "${connection}" FAILED.`,
              ``,
              `Error: ${msg}`,
              ``,
              `Troubleshooting:`,
              `  • OCI ADB public endpoint: check that this server's IP is in the Access Control List`,
              `    (OCI Console → ADB → Network → Access Control).`,
              `  • Verify the connect string is the TLS version (not mTLS — no wallet needed for`,
              `    public endpoints since ADB-S 2023).`,
              `  • Double-check db_user and db_password.`,
              `  • For mTLS connections: ensure wallet_b64 and wallet_password are correct.`,
            ].join('\n'),
          }],
          isError: true,
        };
      }
    },
  );

  // ── Schema tools ───────────────────────────────────────────────────────

  server.tool(
    'list_schemas',
    'List all schemas (users) accessible to the connected Oracle ADB user.',
    { connection: z.string().describe('Connection name to use.') },
    ({ connection }) =>
      handleSchemaTools('list_schemas', { connection }, userId),
  );

  server.tool(
    'list_tables',
    'List all tables and views in a schema.',
    {
      connection: z.string().describe('Connection name.'),
      schema:     z.string().optional().describe('Schema/owner. Defaults to the connected user.'),
      type:       z.enum(['TABLE', 'VIEW', 'ALL']).default('ALL').describe('Filter by object type.'),
    },
    (args) => handleSchemaTools('list_tables', args as Record<string, string>, userId),
  );

  server.tool(
    'describe_table',
    'Get column definitions, data types, nullable flags, and defaults for a table or view.',
    {
      connection: z.string().describe('Connection name.'),
      table:      z.string().describe('Table or view name.'),
      schema:     z.string().optional().describe('Schema/owner name.'),
    },
    (args) => handleSchemaTools('describe_table', args as Record<string, string>, userId),
  );

  // ── Query tools ───────────────────────────────────────────────────────

  server.tool(
    'execute_query',
    'Execute a SQL SELECT statement against Oracle Autonomous Database. Returns up to 200 rows by default (max 1000).',
    {
      connection: z.string().describe('Connection name.'),
      sql:        z.string().describe('SQL SELECT statement to execute.'),
      max_rows:   z.number().int().min(1).max(1000).default(200).optional()
                    .describe('Max rows to return (default 200).'),
    },
    (args) => handleQueryTools('execute_query', args as Record<string, unknown>, userId),
  );

  server.tool(
    'explain_plan',
    'Get the Oracle execution plan for a SQL statement using DBMS_XPLAN.DISPLAY().',
    {
      connection: z.string().describe('Connection name.'),
      sql:        z.string().describe('SQL statement to explain.'),
    },
    (args) => handleQueryTools('explain_plan', args as Record<string, unknown>, userId),
  );

  // ── Metadata tools ─────────────────────────────────────────────────────

  server.tool(
    'get_ddl',
    'Get the DDL (CREATE statement) for any Oracle database object — TABLE, VIEW, PROCEDURE, FUNCTION, PACKAGE, TRIGGER, INDEX, SEQUENCE.',
    {
      connection:   z.string().describe('Connection name.'),
      object_type:  z.string().describe('Object type (TABLE, VIEW, PROCEDURE, etc.).'),
      object_name:  z.string().describe('Object name.'),
      schema:       z.string().optional().describe('Owner schema.'),
    },
    (args) => handleMetadataTools('get_ddl', args as Record<string, string>, userId, listConnections),
  );

  server.tool(
    'list_procedures',
    'List stored procedures, functions, and packages in a schema.',
    {
      connection: z.string().describe('Connection name.'),
      schema:     z.string().optional().describe('Schema/owner name.'),
      type:       z.enum(['PROCEDURE', 'FUNCTION', 'PACKAGE', 'ALL']).default('ALL').optional(),
    },
    (args) => handleMetadataTools('list_procedures', args as Record<string, string>, userId, listConnections),
  );

  server.tool(
    'list_connections',
    'List all Oracle ADB connections registered to this account.',
    {},
    () => handleMetadataTools('list_connections', {}, userId, listConnections),
  );

  // ── Object tools ──────────────────────────────────────────────────────

  server.tool(
    'list_indexes',
    'List indexes on a table or across an entire schema, including column list, uniqueness, and status.',
    {
      connection: z.string().describe('Connection name.'),
      schema:     z.string().optional().describe('Schema/owner to filter by.'),
      table:      z.string().optional().describe('Table name to filter by. Omit to list indexes across the whole schema.'),
    },
    (args) => handleObjectTools('list_indexes', args as Record<string, string | undefined>, userId),
  );

  server.tool(
    'list_constraints',
    'List all constraints on a table — PRIMARY KEY, FOREIGN KEY, UNIQUE, and CHECK constraints.',
    {
      connection: z.string().describe('Connection name.'),
      table:      z.string().describe('Table name.'),
      schema:     z.string().optional().describe('Schema/owner of the table.'),
    },
    (args) => handleObjectTools('list_constraints', args as Record<string, string | undefined>, userId),
  );

  server.tool(
    'list_sequences',
    'List sequences in a schema, including current value, increment, min/max, and cache settings.',
    {
      connection: z.string().describe('Connection name.'),
      schema:     z.string().optional().describe('Schema/owner. Omit to list all non-system sequences.'),
    },
    (args) => handleObjectTools('list_sequences', args as Record<string, string | undefined>, userId),
  );

  server.tool(
    'list_triggers',
    'List triggers on a specific table or across a schema, including trigger type, event, and status.',
    {
      connection: z.string().describe('Connection name.'),
      schema:     z.string().optional().describe('Schema/owner.'),
      table:      z.string().optional().describe('Table name. Omit to list all triggers in the schema.'),
    },
    (args) => handleObjectTools('list_triggers', args as Record<string, string | undefined>, userId),
  );

  server.tool(
    'list_synonyms',
    'List synonyms accessible to the user, optionally filtered by schema.',
    {
      connection: z.string().describe('Connection name.'),
      schema:     z.string().optional().describe('Owner of the synonyms.'),
    },
    (args) => handleObjectTools('list_synonyms', args as Record<string, string | undefined>, userId),
  );

  server.tool(
    'get_view_definition',
    'Get the full SQL text (SELECT statement) behind an Oracle view.',
    {
      connection: z.string().describe('Connection name.'),
      view:       z.string().describe('View name.'),
      schema:     z.string().optional().describe('Schema/owner of the view.'),
    },
    (args) => handleObjectTools('get_view_definition', args as Record<string, string | undefined>, userId),
  );

  server.tool(
    'search_objects',
    'Search for any database object by name pattern (SQL LIKE syntax, e.g. "EMP%"). Returns up to 100 matches.',
    {
      connection: z.string().describe('Connection name.'),
      pattern:    z.string().optional().describe('Name pattern using SQL LIKE syntax (e.g. "EMP%"). Defaults to "%" (all).'),
      type:       z.string().optional().describe('Object type filter: TABLE, VIEW, PROCEDURE, FUNCTION, INDEX, SEQUENCE, etc.'),
      schema:     z.string().optional().describe('Schema/owner to search within.'),
    },
    (args) => handleObjectTools('search_objects', args as Record<string, string | undefined>, userId),
  );

  // ── Data tools ────────────────────────────────────────────────────────

  server.tool(
    'count_rows',
    'Get a fast COUNT(*) for a table, optionally with a WHERE filter.',
    {
      connection:   z.string().describe('Connection name.'),
      table:        z.string().describe('Table name.'),
      schema:       z.string().optional().describe('Schema/owner.'),
      where_clause: z.string().optional().describe('Optional WHERE clause (without the WHERE keyword).'),
    },
    (args) => handleDataTools('count_rows', args as Record<string, unknown>, userId),
  );

  server.tool(
    'get_sample_data',
    'SELECT * from a table with optional WHERE / ORDER BY and a row limit (default 20, max 100).',
    {
      connection:   z.string().describe('Connection name.'),
      table:        z.string().describe('Table name.'),
      schema:       z.string().optional().describe('Schema/owner.'),
      limit:        z.number().int().min(1).max(100).default(20).optional().describe('Number of rows to return (default 20).'),
      order_by:     z.string().optional().describe('ORDER BY expression (e.g. "CREATED_AT DESC").'),
      where_clause: z.string().optional().describe('Optional WHERE clause (without the WHERE keyword).'),
    },
    (args) => handleDataTools('get_sample_data', args as Record<string, unknown>, userId),
  );

  server.tool(
    'execute_dml',
    'Execute an INSERT, UPDATE, DELETE, or MERGE statement. Requires the connection to have allowDml enabled.',
    {
      connection: z.string().describe('Connection name (must have DML enabled).'),
      sql:        z.string().describe('DML statement to execute.'),
    },
    (args) => handleDataTools('execute_dml', args as Record<string, unknown>, userId),
  );

  server.tool(
    'execute_plsql',
    'Execute an anonymous PL/SQL block and capture DBMS_OUTPUT. Requires the connection to have allowDml enabled.',
    {
      connection: z.string().describe('Connection name (must have DML enabled).'),
      sql:        z.string().describe('Anonymous PL/SQL block (BEGIN...END;).'),
    },
    (args) => handleDataTools('execute_plsql', args as Record<string, unknown>, userId),
  );

  // ── Admin tools ───────────────────────────────────────────────────────

  server.tool(
    'get_db_info',
    'Get Oracle database version, name, open mode, log mode, role, and platform from V$DATABASE / V$VERSION.',
    {
      connection: z.string().describe('Connection name.'),
    },
    (args) => handleAdminTools('get_db_info', args as Record<string, string | undefined>, userId),
  );

  server.tool(
    'get_table_stats',
    'Get optimizer statistics for a table: row count, block count, average row length, and estimated size in MB.',
    {
      connection: z.string().describe('Connection name.'),
      table:      z.string().describe('Table name.'),
      schema:     z.string().optional().describe('Schema/owner.'),
    },
    (args) => handleAdminTools('get_table_stats', args as Record<string, string | undefined>, userId),
  );

  server.tool(
    'get_tablespace_usage',
    'Show tablespace usage: used GB, total GB, and percent used. Uses DBA_TABLESPACE_USAGE_METRICS when available.',
    {
      connection: z.string().describe('Connection name.'),
    },
    (args) => handleAdminTools('get_tablespace_usage', args as Record<string, string | undefined>, userId),
  );

  server.tool(
    'list_grants',
    'List object-level privileges (grants) on Oracle objects, filterable by owner, object, or grantee.',
    {
      connection:  z.string().describe('Connection name.'),
      schema:      z.string().optional().describe('Owner/schema of the object.'),
      object_name: z.string().optional().describe('Specific object to show grants for.'),
      grantee:     z.string().optional().describe('Filter by grantee (user/role receiving the grant).'),
    },
    (args) => handleAdminTools('list_grants', args as Record<string, string | undefined>, userId),
  );

  server.tool(
    'list_active_sessions',
    'List active user sessions from V$SESSION: SID, username, status, machine, module, and idle time.',
    {
      connection: z.string().describe('Connection name.'),
    },
    (args) => handleAdminTools('list_active_sessions', args as Record<string, string | undefined>, userId),
  );

  server.tool(
    'list_invalid_objects',
    'List all database objects with STATUS != VALID (invalid procedures, views, packages, etc.).',
    {
      connection: z.string().describe('Connection name.'),
      schema:     z.string().optional().describe('Filter by schema/owner.'),
    },
    (args) => handleAdminTools('list_invalid_objects', args as Record<string, string | undefined>, userId),
  );

  return server;
}

// ── Express handler: POST /mcp ──────────────────────────────────────────

export async function mcpHandler(req: Request, res: Response): Promise<void> {
  const authHeader = req.headers.authorization;

  const userId = resolveUserId(authHeader);

  if (!userId) {
    res.status(401).json({
      error:   'unauthorized',
      message:
        'Missing or invalid Authorization header. ' +
        'Use "Bearer <jwt>" (OAuth flow) or "ApiKey <key>" (static API key for OCI ADB public-endpoint connections). ' +
        'See README for setup instructions.',
    });
    return;
  }

  logger.info('MCP request', { userId, method: req.method, authScheme: authHeader?.split(' ')[0] });

  const server    = buildServer(userId);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
