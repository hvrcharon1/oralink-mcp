/**
 * MCP tools: database object inspection
 *
 *   list_indexes        — indexes on a table / across a schema
 *   list_constraints    — PK, FK, UK, CHECK on a table
 *   list_sequences      — sequences in a schema
 *   list_triggers       — triggers on a table or in a schema
 *   list_synonyms       — synonyms accessible to the user
 *   get_view_definition — full SQL text behind a view
 *   search_objects      — search any object by name pattern (LIKE)
 */
import { runQuery } from '../oracle/client.js';
import type { McpToolResult, QueryRow } from '../types.js';

export async function handleObjectTools(
  toolName: string,
  args:     Record<string, string | undefined>,
  userId:   string,
): Promise<McpToolResult> {
  const connectionName = args.connection!;

  // ── list_indexes ─────────────────────────────────────────────────────────

  if (toolName === 'list_indexes') {
    const owner = args.schema?.toUpperCase();
    const table = args.table?.toUpperCase();
    const ownerClause = owner ? `AND i.TABLE_OWNER = '${owner}'` : '';
    const tableClause = table ? `AND i.TABLE_NAME  = '${table}'` : '';

    const result = await runQuery({ userId, connectionName, sql:
      `SELECT i.TABLE_OWNER, i.TABLE_NAME, i.INDEX_NAME,
              i.INDEX_TYPE, i.UNIQUENESS, i.STATUS,
              LISTAGG(ic.COLUMN_NAME, ', ')
                WITHIN GROUP (ORDER BY ic.COLUMN_POSITION) AS COLUMNS
       FROM   ALL_INDEXES i
       JOIN   ALL_IND_COLUMNS ic
              ON  ic.INDEX_OWNER = i.OWNER
              AND ic.INDEX_NAME  = i.INDEX_NAME
       WHERE  1 = 1
       ${ownerClause}
       ${tableClause}
       GROUP BY i.TABLE_OWNER, i.TABLE_NAME, i.INDEX_NAME,
                i.INDEX_TYPE, i.UNIQUENESS, i.STATUS
       ORDER BY i.TABLE_OWNER, i.TABLE_NAME, i.INDEX_NAME`,
    });
    return ok(fmtTable(result.rows, result.columns));
  }

  // ── list_constraints ───────────────────────────────────────────────────

  if (toolName === 'list_constraints') {
    const owner = args.schema?.toUpperCase();
    const table = args.table!.toUpperCase();
    const ownerClause = owner ? `AND c.OWNER = '${owner}'` : '';

    const result = await runQuery({ userId, connectionName, sql:
      `SELECT c.CONSTRAINT_NAME,
              DECODE(c.CONSTRAINT_TYPE,
                'P','PRIMARY KEY','U','UNIQUE',
                'C','CHECK','R','FOREIGN KEY', c.CONSTRAINT_TYPE) AS TYPE,
              c.STATUS, c.VALIDATED,
              c.SEARCH_CONDITION,
              r.OWNER AS REF_OWNER, r.TABLE_NAME AS REF_TABLE
       FROM   ALL_CONSTRAINTS c
       LEFT JOIN ALL_CONSTRAINTS r
              ON  c.R_CONSTRAINT_NAME = r.CONSTRAINT_NAME
              AND c.R_OWNER = r.OWNER
       WHERE  c.TABLE_NAME = '${table}'
       ${ownerClause}
       ORDER BY c.CONSTRAINT_TYPE, c.CONSTRAINT_NAME`,
    });
    return ok(result.rows.length === 0
      ? `No constraints found on ${owner ? owner + '.' : ''}${table}.`
      : fmtTable(result.rows, result.columns));
  }

  // ── list_sequences ─────────────────────────────────────────────────────

  if (toolName === 'list_sequences') {
    const owner = args.schema?.toUpperCase();
    const ownerClause = owner ? `SEQUENCE_OWNER = '${owner}'` : `SEQUENCE_OWNER NOT IN ('SYS','SYSTEM')`;

    const result = await runQuery({ userId, connectionName, sql:
      `SELECT SEQUENCE_OWNER, SEQUENCE_NAME,
              MIN_VALUE, MAX_VALUE, INCREMENT_BY,
              CYCLE_FLAG, ORDER_FLAG, CACHE_SIZE, LAST_NUMBER
       FROM   ALL_SEQUENCES
       WHERE  ${ownerClause}
       ORDER BY SEQUENCE_OWNER, SEQUENCE_NAME`,
    });
    return ok(result.rows.length === 0
      ? `No sequences found${owner ? ` in schema ${owner}` : ''}.`
      : fmtTable(result.rows, result.columns));
  }

  // ── list_triggers ──────────────────────────────────────────────────────

  if (toolName === 'list_triggers') {
    const owner = args.schema?.toUpperCase();
    const table = args.table?.toUpperCase();
    const ownerClause = owner ? `AND OWNER = '${owner}'` : '';
    const tableClause = table ? `AND TABLE_NAME = '${table}'` : '';

    const result = await runQuery({ userId, connectionName, sql:
      `SELECT OWNER, TRIGGER_NAME, TRIGGER_TYPE, TRIGGERING_EVENT,
              TABLE_OWNER, TABLE_NAME, STATUS, ACTION_TYPE
       FROM   ALL_TRIGGERS
       WHERE  1 = 1
       ${ownerClause}
       ${tableClause}
       ORDER BY OWNER, TABLE_NAME, TRIGGER_NAME`,
    });
    return ok(result.rows.length === 0
      ? 'No triggers found.'
      : fmtTable(result.rows, result.columns));
  }

  // ── list_synonyms ─────────────────────────────────────────────────────

  if (toolName === 'list_synonyms') {
    const owner = args.schema?.toUpperCase();
    const ownerClause = owner
      ? `OWNER = '${owner}'`
      : `OWNER NOT IN ('SYS','SYSTEM','PUBLIC')`;

    const result = await runQuery({ userId, connectionName, sql:
      `SELECT OWNER, SYNONYM_NAME, TABLE_OWNER, TABLE_NAME, DB_LINK
       FROM   ALL_SYNONYMS
       WHERE  ${ownerClause}
       ORDER BY OWNER, SYNONYM_NAME`,
    });
    return ok(result.rows.length === 0
      ? 'No synonyms found.'
      : fmtTable(result.rows, result.columns));
  }

  // ── get_view_definition ───────────────────────────────────────────────

  if (toolName === 'get_view_definition') {
    const owner = args.schema?.toUpperCase();
    const view  = args.view!.toUpperCase();
    const ownerClause = owner ? `AND OWNER = '${owner}'` : '';

    const result = await runQuery({ userId, connectionName, sql:
      `SELECT OWNER, VIEW_NAME, TEXT
       FROM   ALL_VIEWS
       WHERE  VIEW_NAME = '${view}'
       ${ownerClause}
       FETCH FIRST 1 ROWS ONLY`,
    });

    if (result.rows.length === 0)
      return ok(`View not found: ${owner ? owner + '.' : ''}${view}`);

    const row = result.rows[0]!;
    const fullName = `${row['OWNER']}.${row['VIEW_NAME']}`;
    const text     = String(row['TEXT'] ?? '(text unavailable)');
    return ok(`-- View: ${fullName}\nCREATE OR REPLACE VIEW ${fullName} AS\n${text}`);
  }

  // ── search_objects ─────────────────────────────────────────────────────

  if (toolName === 'search_objects') {
    const raw     = args.pattern ?? '%';
    const pattern = raw.toUpperCase().replace(/'/g, "''");
    const type    = args.type?.toUpperCase();
    const owner   = args.schema?.toUpperCase();
    const typeClause  = type  ? `AND OBJECT_TYPE = '${type}'`  : '';
    const ownerClause = owner ? `AND OWNER = '${owner}'` : '';

    const result = await runQuery({ userId, connectionName, sql:
      `SELECT OWNER, OBJECT_NAME, OBJECT_TYPE, STATUS, LAST_DDL_TIME
       FROM   ALL_OBJECTS
       WHERE  OBJECT_NAME LIKE '${pattern}'
       ${typeClause}
       ${ownerClause}
       ORDER BY OWNER, OBJECT_TYPE, OBJECT_NAME
       FETCH FIRST 100 ROWS ONLY`,
    });
    return ok(result.rows.length === 0
      ? `No objects found matching: ${raw}`
      : fmtTable(result.rows, result.columns));
  }

  throw new Error(`Unknown object tool: ${toolName}`);
}

// ── shared helpers ─────────────────────────────────────────────────────────────

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
