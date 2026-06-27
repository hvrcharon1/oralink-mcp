/**
 * Oracle query executor.
 *
 * All queries are run through a per-user connection pool (src/oracle/pool.ts).
 * DML is blocked by default; each connection has an `allowDml` flag that the
 * user must explicitly enable at connection-setup time.
 *
 * Results are returned as plain objects (OUT_FORMAT_OBJECT) with column names
 * uppercased (Oracle default behaviour).
 */
import oracledb from 'oracledb';
import { getOrCreatePool } from './pool.js';
import { loadUser } from '../auth/store.js';
import { logger } from '../logger.js';
import type { QueryRow } from '../types.js';

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
      `Enable it in connection settings to allow INSERT/UPDATE/DELETE.`,
    );
  }

  const pool  = await getOrCreatePool({ userId: opts.userId, connectionName: opts.connectionName }, conn);
  const dbConn = await pool.getConnection();

  try {
    logger.info('Executing SQL', {
      userId: opts.userId,
      connection: opts.connectionName,
      preview: opts.sql.slice(0, 200),
    });

    const result = await dbConn.execute<QueryRow>(opts.sql, opts.binds ?? [], {
      outFormat:     oracledb.OUT_FORMAT_OBJECT,
      maxRows:       Math.min(opts.maxRows ?? 200, 1000),
      fetchArraySize: 100,
    });

    return {
      rows:         (result.rows ?? []) as QueryRow[],
      columns:      result.metaData?.map(m => m.name) ?? [],
      rowsAffected: result.rowsAffected,
    };
  } finally {
    await dbConn.close().catch(() => {});
  }
}

export async function getExplainPlan(opts: Omit<QueryOptions, 'binds'>): Promise<string> {
  // Step 1: populate PLAN_TABLE
  await runQuery({ ...opts, sql: `EXPLAIN PLAN FOR ${opts.sql}` });

  // Step 2: read formatted plan
  const plan = await runQuery({
    ...opts,
    sql: `SELECT PLAN_TABLE_OUTPUT FROM TABLE(DBMS_XPLAN.DISPLAY())`,
  });

  return plan.rows
    .map(r => String(Object.values(r)[0] ?? ''))
    .join('\n');
}
