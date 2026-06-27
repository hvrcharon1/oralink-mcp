/**
 * MCP tools: schema inspection
 *   - list_schemas
 *   - list_tables
 *   - describe_table
 */
import { runQuery } from '../oracle/client.js';
import type { McpToolResult, QueryRow } from '../types.js';

export async function handleSchemaTools(
  toolName: string,
  args: Record<string, string | undefined>,
  userId: string,
): Promise<McpToolResult> {
  const connectionName = args.connection!;

  if (toolName === 'list_schemas') {
    // Try DBA_USERS first (requires SELECT ANY DICTIONARY), fall back to ALL_USERS
    const result = await runQuery({ userId, connectionName, sql:
      `SELECT USERNAME, ACCOUNT_STATUS, CREATED FROM DBA_USERS ORDER BY USERNAME`,
    }).catch(() => runQuery({ userId, connectionName, sql:
      `SELECT USERNAME, NULL AS ACCOUNT_STATUS, CREATED FROM ALL_USERS ORDER BY USERNAME`,
    }));
    return ok(fmtTable(result.rows, result.columns));
  }

  if (toolName === 'list_tables') {
    const owner = args.schema?.toUpperCase();
    const type  = args.type ?? 'ALL';
    const ownerClause = owner ? `AND OWNER = '${owner}'` : '';
    const typeClause  = type === 'ALL'
      ? `OBJECT_TYPE IN ('TABLE','VIEW')`
      : `OBJECT_TYPE = '${type}'`;

    const result = await runQuery({ userId, connectionName, sql:
      `SELECT OWNER, OBJECT_NAME, OBJECT_TYPE, STATUS, LAST_DDL_TIME
       FROM   ALL_OBJECTS
       WHERE  ${typeClause}
       ${ownerClause}
       ORDER  BY OWNER, OBJECT_TYPE, OBJECT_NAME`,
    });
    return ok(fmtTable(result.rows, result.columns));
  }

  if (toolName === 'describe_table') {
    const owner = args.schema?.toUpperCase();
    const table = args.table!.toUpperCase();
    const ownerClause = owner ? `AND OWNER = '${owner}'` : '';

    const result = await runQuery({ userId, connectionName, sql:
      `SELECT COLUMN_NAME, DATA_TYPE,
              DATA_LENGTH, DATA_PRECISION, DATA_SCALE,
              NULLABLE, DATA_DEFAULT, COLUMN_ID
       FROM   ALL_TAB_COLUMNS
       WHERE  TABLE_NAME = '${table}'
       ${ownerClause}
       ORDER  BY COLUMN_ID`,
    });

    if (result.rows.length === 0)
      return ok(`No table/view found: ${owner ? owner + '.' : ''}${table}`);

    return ok(fmtTable(result.rows, result.columns));
  }

  throw new Error(`Unknown schema tool: ${toolName}`);
}

// ── helpers ──────────────────────────────────────────────────────────────

function fmtTable(rows: QueryRow[], columns: string[]): string {
  if (rows.length === 0) return 'No results.';
  const widths = columns.map(c =>
    Math.max(c.length, ...rows.map(r => String(r[c] ?? '').length)),
  );
  const header = columns.map((c, i) => c.padEnd(widths[i]!)).join('  ');
  const sep    = widths.map(w => '-'.repeat(w)).join('  ');
  const body   = rows.map(r =>
    columns.map((c, i) => String(r[c] ?? '').padEnd(widths[i]!)).join('  '),
  ).join('\n');
  return `${header}\n${sep}\n${body}\n\n(${rows.length} row${rows.length !== 1 ? 's' : ''})`;
}

function ok(text: string): McpToolResult {
  return { content: [{ type: 'text', text }] };
}
