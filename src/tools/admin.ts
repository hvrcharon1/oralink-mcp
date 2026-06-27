/**
 * MCP tools: DBA / performance / administration
 *
 *   get_db_info           — database version, name, mode, platform
 *   get_table_stats       — optimizer statistics (rows, blocks, size)
 *   get_tablespace_usage  — tablespace used/total/percent
 *   list_grants           — object-level grants to/from users
 *   list_active_sessions  — active user sessions from V$SESSION
 *   list_invalid_objects  — objects with STATUS != VALID
 */
import { runQuery } from '../oracle/client.js';
import type { McpToolResult, QueryRow } from '../types.js';

export async function handleAdminTools(
  toolName: string,
  args:     Record<string, string | undefined>,
  userId:   string,
): Promise<McpToolResult> {
  const connectionName = args.connection!;

  // ── get_db_info ────────────────────────────────────────────────────────────

  if (toolName === 'get_db_info') {
    // Primary: V$DATABASE (needs SELECT privilege on V_$DATABASE)
    // Fallback: select version from DUAL
    const [dbResult, verResult] = await Promise.all([
      runQuery({ userId, connectionName, sql:
        `SELECT NAME, DB_UNIQUE_NAME, CREATED, LOG_MODE,
                OPEN_MODE, DATABASE_ROLE, PLATFORM_NAME
         FROM   V$DATABASE`,
      }).catch(() => ({ rows: [], columns: [] as string[] })),

      runQuery({ userId, connectionName, sql:
        `SELECT BANNER FROM V$VERSION WHERE ROWNUM = 1`,
      }).catch(() => runQuery({ userId, connectionName, sql:
        `SELECT VERSION FROM PRODUCT_COMPONENT_VERSION
         WHERE PRODUCT LIKE 'Oracle Database%'
         AND ROWNUM = 1`,
      })).catch(() => ({ rows: [], columns: [] as string[] })),
    ]);

    const parts: string[] = [];
    if (verResult.rows.length > 0) {
      parts.push(String(Object.values(verResult.rows[0]!)[0]));
    }
    if (dbResult.rows.length > 0) {
      parts.push('\n' + fmtTable(dbResult.rows, dbResult.columns));
    }
    return ok(parts.length > 0 ? parts.join('\n') : 'Database info unavailable (insufficient privileges).');
  }

  // ── get_table_stats ────────────────────────────────────────────────────

  if (toolName === 'get_table_stats') {
    const owner = args.schema?.toUpperCase();
    const table = args.table!.toUpperCase();
    const ownerClause = owner ? `AND OWNER = '${owner}'` : '';

    const result = await runQuery({ userId, connectionName, sql:
      `SELECT OWNER, TABLE_NAME, NUM_ROWS, BLOCKS,
              AVG_ROW_LEN, CHAIN_CNT,
              ROUND(BLOCKS * 8 / 1024, 3) AS EST_SIZE_MB,
              LAST_ANALYZED
       FROM   ALL_TAB_STATISTICS
       WHERE  TABLE_NAME = '${table}'
       AND    PARTITION_NAME IS NULL
       ${ownerClause}`,
    });

    if (result.rows.length === 0)
      return ok(
        `No optimizer statistics for ${owner ? owner + '.' : ''}${table}.\n` +
        `Run: EXEC DBMS_STATS.GATHER_TABLE_STATS('${owner ?? 'OWNER'}','${table}');`,
      );
    return ok(fmtTable(result.rows, result.columns));
  }

  // ── get_tablespace_usage ───────────────────────────────────────────────

  if (toolName === 'get_tablespace_usage') {
    // Try DBA_TABLESPACE_USAGE_METRICS (ADB exposes this to ADMIN)
    const result = await runQuery({ userId, connectionName, sql:
      `SELECT TABLESPACE_NAME,
              ROUND(USED_SPACE       * 8192 / 1073741824, 2) AS USED_GB,
              ROUND(TABLESPACE_SIZE  * 8192 / 1073741824, 2) AS TOTAL_GB,
              ROUND(USED_PERCENT, 1)                          AS USED_PCT
       FROM   DBA_TABLESPACE_USAGE_METRICS
       ORDER BY USED_PCT DESC`,
    }).catch(() => runQuery({ userId, connectionName, sql:
      // Fallback: user-visible tablespaces only
      `SELECT TABLESPACE_NAME, STATUS, CONTENTS,
              EXTENT_MANAGEMENT, SEGMENT_SPACE_MANAGEMENT
       FROM   USER_TABLESPACES
       ORDER BY TABLESPACE_NAME`,
    }));
    return ok(fmtTable(result.rows, result.columns));
  }

  // ── list_grants ───────────────────────────────────────────────────────────

  if (toolName === 'list_grants') {
    const owner   = args.schema?.toUpperCase();
    const object  = args.object_name?.toUpperCase();
    const grantee = args.grantee?.toUpperCase();
    const ownerClause   = owner   ? `AND OWNER      = '${owner}'`   : '';
    const objectClause  = object  ? `AND TABLE_NAME = '${object}'`  : '';
    const granteeClause = grantee ? `AND GRANTEE    = '${grantee}'` : '';

    const result = await runQuery({ userId, connectionName, sql:
      `SELECT GRANTEE, OWNER, TABLE_NAME, PRIVILEGE,
              GRANTABLE, HIERARCHY
       FROM   ALL_TAB_PRIVS
       WHERE  1 = 1
       ${ownerClause}
       ${objectClause}
       ${granteeClause}
       ORDER BY OWNER, TABLE_NAME, GRANTEE, PRIVILEGE`,
    });
    return ok(result.rows.length === 0 ? 'No matching grants found.' : fmtTable(result.rows, result.columns));
  }

  // ── list_active_sessions ───────────────────────────────────────────────

  if (toolName === 'list_active_sessions') {
    const result = await runQuery({ userId, connectionName, sql:
      `SELECT SID, SERIAL#, USERNAME, STATUS,
              OSUSER, MACHINE, MODULE, PROGRAM,
              TO_CHAR(LOGON_TIME,'YYYY-MM-DD HH24:MI:SS') AS LOGON_TIME,
              LAST_CALL_ET AS IDLE_SECS
       FROM   V$SESSION
       WHERE  TYPE     = 'USER'
       AND    USERNAME IS NOT NULL
       ORDER BY LAST_CALL_ET DESC
       FETCH FIRST 50 ROWS ONLY`,
    });
    return ok(result.rows.length === 0
      ? 'No active user sessions (or SELECT privilege on V$SESSION not granted).'
      : fmtTable(result.rows, result.columns));
  }

  // ── list_invalid_objects ──────────────────────────────────────────────

  if (toolName === 'list_invalid_objects') {
    const owner = args.schema?.toUpperCase();
    const ownerClause = owner ? `AND OWNER = '${owner}'` : '';

    const result = await runQuery({ userId, connectionName, sql:
      `SELECT OWNER, OBJECT_NAME, OBJECT_TYPE, STATUS, LAST_DDL_TIME
       FROM   ALL_OBJECTS
       WHERE  STATUS != 'VALID'
       ${ownerClause}
       ORDER BY OWNER, OBJECT_TYPE, OBJECT_NAME`,
    });
    return ok(result.rows.length === 0
      ? `✅ No invalid objects found${owner ? ` in schema ${owner}` : ''}.`
      : `Found ${result.rows.length} invalid object(s):\n\n` + fmtTable(result.rows, result.columns));
  }

  throw new Error(`Unknown admin tool: ${toolName}`);
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
