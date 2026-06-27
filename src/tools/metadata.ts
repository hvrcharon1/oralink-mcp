/**
 * MCP tools: database object metadata
 *   - get_ddl
 *   - list_procedures
 *   - list_connections
 */
import { runQuery } from '../oracle/client.js';
import type { McpToolResult } from '../types.js';

type GetConnNames = (userId: string) => string[];

export async function handleMetadataTools(
  toolName:        string,
  args:            Record<string, string | undefined>,
  userId:          string,
  getConnNames:    GetConnNames,
): Promise<McpToolResult> {

  if (toolName === 'list_connections') {
    const names = getConnNames(userId);
    if (names.length === 0)
      return ok('No connections registered.\nUse the OAuth setup flow to add an Oracle ADB connection.');
    return ok(`Registered connections (${names.length}):\n${names.map(n => `  • ${n}`).join('\n')}`);
  }

  const connectionName = args.connection!;

  if (toolName === 'get_ddl') {
    const objectType = args.object_type!.toUpperCase();
    const objectName = args.object_name!.toUpperCase();
    const schema     = args.schema?.toUpperCase();
    const schemaArg  = schema ? `, '${schema}'` : '';

    const result = await runQuery({ userId, connectionName, sql:
      `SELECT DBMS_METADATA.GET_DDL('${objectType}','${objectName}'${schemaArg}) AS DDL FROM DUAL`,
    });

    const ddl = result.rows[0]?.['DDL'];
    return ok(ddl ? String(ddl) : `No DDL found for ${objectType} ${objectName}.`);
  }

  if (toolName === 'list_procedures') {
    const owner    = args.schema?.toUpperCase();
    const type     = (args.type ?? 'ALL').toUpperCase();
    const typeClause = type === 'ALL'
      ? `OBJECT_TYPE IN ('PROCEDURE','FUNCTION','PACKAGE')`
      : `OBJECT_TYPE = '${type}'`;
    const ownerClause = owner ? `AND OWNER = '${owner}'` : '';

    const result = await runQuery({ userId, connectionName, sql:
      `SELECT OWNER, OBJECT_NAME, OBJECT_TYPE, STATUS, LAST_DDL_TIME
       FROM   ALL_OBJECTS
       WHERE  ${typeClause}
       ${ownerClause}
       ORDER  BY OWNER, OBJECT_TYPE, OBJECT_NAME`,
    });

    if (result.rows.length === 0) return ok('No procedures / functions / packages found.');

    const lines = result.rows.map(r =>
      `  [${r['OBJECT_TYPE']}] ${r['OWNER']}.${r['OBJECT_NAME']}  (${r['STATUS']})`
    );
    return ok(`Found ${result.rows.length} object(s):\n${lines.join('\n')}`);
  }

  throw new Error(`Unknown metadata tool: ${toolName}`);
}

function ok(text: string): McpToolResult {
  return { content: [{ type: 'text', text }] };
}
