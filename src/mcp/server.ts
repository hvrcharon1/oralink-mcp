/**
 * MCP Server — StreamableHTTP transport.
 *
 * A fresh McpServer is instantiated per request with the authenticated
 * userId in closure scope. This keeps the auth model simple and stateless:
 * no session registry, no shared mutable state between users.
 *
 * Transport: StreamableHTTP — the transport required for cloud-hosted,
 * OAuth-authenticated MCP connectors listed on Claude.ai marketplace.
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
import { listConnections } from '../auth/store.js';
import { logger } from '../logger.js';

// ── Server factory (one per request) ─────────────────────────────────────────

function buildServer(userId: string): McpServer {
  const server = new McpServer({
    name:    'oralink-mcp',
    version: '0.2.0',
  });

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
  // Auth
  const token = extractBearerToken(req.headers.authorization);
  if (!token) {
    res.status(401).json({
      error:   'unauthorized',
      message: 'Missing Bearer token. Complete the OAuth setup flow first.',
    });
    return;
  }

  let userId: string;
  try {
    const payload = verifyToken(token);
    if (payload.type !== 'access') throw new Error('Not an access token');
    userId = payload.sub;
  } catch {
    res.status(401).json({ error: 'unauthorized', message: 'Invalid or expired access token.' });
    return;
  }

  logger.info('MCP request', { userId, method: req.method });

  const server    = buildServer(userId);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
