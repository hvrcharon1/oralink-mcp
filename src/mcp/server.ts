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
import { verifyToken, extractBearerToken } from '../auth/tokens.js';
import { listConnections } from '../auth/store.js';
import { logger } from '../logger.js';

// ── Server factory (one per request) ─────────────────────────────────────────

function buildServer(userId: string): McpServer {
  const server = new McpServer({
    name:    'oralink-mcp',
    version: '0.1.0',
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
