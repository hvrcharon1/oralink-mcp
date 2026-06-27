/**
 * Oracle query executor.
 *
 * All queries run through per-user connection pools (src/oracle/pool.ts).
 * DML is blocked by default; each connection carries an `allowDml` flag
 * that the user must explicitly enable at connection-setup time.
 *
 * CLOBs / NCLOBs are automatically fetched as strings via the module-level
 * fetchAsString setting, so view definitions, DDL text, and LONG columns
 * arrive as plain JavaScript strings rather than Lob stream objects.
 */
import oracledb from 'oracledb';
import { getOrCreatePool } from './pool.js';
import { loadUser } from '../auth/store.js';
import { logger } from '../logger.js';
import type { QueryRow } from '../types.js';

// Auto-convert CLOB / NCLOB to JS strings for all queries
oracledb.fetchAsString = [oracledb.CLOB, oracledb.NCLOB];

const READ_PREFIXES = ['SELECT', 'WITH', 'EXPLAIN'];

function isReadOnly(sql: string): boolean {
  return READ_PREFIXES.some(p => sql.trimStart().toUpperCase().startsWith(p));
}

export interface QueryOptions {
  userId:         string;
  connectionName: string;
  sql:            string;
  binds?:         oracledb.BindParameters;
  maxRows?:       number;
}

export interface QueryResult {
  rows:          QueryRow[];
  columns:       string[];
  rowsAffected?: number;
}

export async function runQuery(opts: QueryOptions): Promise<QueryResult> {
  const user = loadUser(opts.userId);
  if (!user) throw new Error(`User not found: ${opts.userId}`);

  const conn = user.connections[opts.connectionName];
  if (!conn) throw new Error(`Connection not found: "${opts.connectionName}"`);

  if (!isReadOnly(opts.sql) && !conn.allowDml) {
    throw new Error(
      `DML is disabled on connection "${opts.connectionName}". ` +
      `Enable it in connection settings to allow INSERT / UPDATE / DELETE / MERGE / PL\/SQL.`,
    );
  }

  const pool   = await getOrCreatePool({ userId: opts.userId, connectionName: opts.connectionName }, conn);
  const dbConn = await pool.getConnection();

  try {
    logger.info('Executing SQL', {
      userId:     opts.userId,
      connection: opts.connectionName,
      preview:    opts.sql.slice(0, 200),
    });

    const result = await dbConn.execute<QueryRow>(opts.sql, opts.binds ?? [], {
      outFormat:      oracledb.OUT_FORMAT_OBJECT,
      maxRows:        Math.min(opts.maxRows ?? 200, 1000),
      fetchArraySize: 100,
    });

    return {
      rows:         (result.rows ?? []) as QueryRow[],
      columns:      result.metaData?.map((m: { name: string }) => m.name) ?? [],
      rowsAffected: result.rowsAffected,
    };
  } finally {
    await dbConn.close().catch(() => {});
  }
}

export async function getExplainPlan(opts: Omit<QueryOptions, 'binds'>): Promise<string> {
  // Step 1: populate PLAN_TABLE
  await runQuery({ ...opts, sql: `EXPLAIN PLAN FOR ${opts.sql}` });

  // Step 2: read formatted plan via DBMS_XPLAN
  const plan = await runQuery({
    ...opts,
    sql: `SELECT PLAN_TABLE_OUTPUT FROM TABLE(DBMS_XPLAN.DISPLAY())`,
  });

  return plan.rows
    .map(r => String(Object.values(r)[0] ?? ''))
    .join('\n');
}

/**
 * Execute an anonymous PL/SQL block and capture DBMS_OUTPUT lines.
 *
 * Requires allowDml = true on the connection (because PL/SQL can mutate data).
 * Three round-trips on the same connection:
 *   1. DBMS_OUTPUT.ENABLE
 *   2. User's PL/SQL block
 *   3. Loop DBMS_OUTPUT.GET_LINE until status != 0
 */
export interface PlSqlResult {
  success: boolean;
  output:  string;
}

export async function runPlSql(
  opts: Omit<QueryOptions, 'binds' | 'maxRows'>,
): Promise<PlSqlResult> {
  const user = loadUser(opts.userId);
  if (!user) throw new Error(`User not found: ${opts.userId}`);

  const conn = user.connections[opts.connectionName];
  if (!conn) throw new Error(`Connection not found: "${opts.connectionName}"`);

  if (!conn.allowDml) {
    throw new Error(
      `PL/SQL execution is disabled on connection "${opts.connectionName}". ` +
      `Enable DML in connection settings.`,
    );
  }

  const pool   = await getOrCreatePool({ userId: opts.userId, connectionName: opts.connectionName }, conn);
  const dbConn = await pool.getConnection();

  try {
    // 1. Enable server-side output buffer (1 MB)
    await dbConn.execute(`BEGIN DBMS_OUTPUT.ENABLE(1000000); END;`);

    // 2. Execute the user's block
    logger.info('Executing PL/SQL block', {
      userId:     opts.userId,
      connection: opts.connectionName,
      preview:    opts.sql.slice(0, 200),
    });
    await dbConn.execute(opts.sql);

    // 3. Drain DBMS_OUTPUT line by line
    const lines: string[] = [];
    while (true) {
      const out = await dbConn.execute<{ LINE: string; STATUS: number }>(
        `BEGIN DBMS_OUTPUT.GET_LINE(:line, :status); END;`,
        {
          line:   { dir: oracledb.BIND_OUT, type: oracledb.STRING, maxSize: 32767 },
          status: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
        },
      );
      const binds = out.outBinds as { line: string; status: number };
      if (binds.status !== 0) break;
      if (binds.line != null) lines.push(binds.line);
    }

    const output = lines.length > 0
      ? `PL/SQL block executed successfully.\n\nDBMS_OUTPUT:\n${lines.join('\n')}`
      : `PL/SQL block executed successfully.`;

    return { success: true, output };
  } finally {
    await dbConn.close().catch(() => {});
  }
}
