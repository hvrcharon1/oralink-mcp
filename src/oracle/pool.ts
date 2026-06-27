/**
 * Per-user Oracle connection pool manager.
 *
 * Uses node-oracledb v6 in THIN mode — no Oracle Instant Client required.
 * Each (userId, connectionName) pair gets its own pool so sessions are
 * fully isolated between accounts.
 *
 * Pool lifecycle:
 *   - Created on first query for a given user+connection
 *   - Reused for subsequent queries (poolMin=1 keeps one warm connection)
 *   - Closed on graceful shutdown via closeAllPools()
 */
import oracledb from 'oracledb';
import { logger } from '../logger.js';
import type { OracleConnectionConfig } from '../types.js';

// node-oracledb v6: thin mode is the default; do NOT call initOracleClient()
// Verify at startup
if (!oracledb.thin) {
  logger.warn('oracledb is NOT in thin mode — ensure Oracle Instant Client is absent or remove initOracleClient() calls');
}

export interface PoolKey {
  userId:         string;
  connectionName: string;
}

function toKey({ userId, connectionName }: PoolKey): string {
  return `${userId}::${connectionName}`;
}

const pools = new Map<string, oracledb.Pool>();

export async function getOrCreatePool(
  key:  PoolKey,
  conn: OracleConnectionConfig,
): Promise<oracledb.Pool> {
  const k = toKey(key);
  const existing = pools.get(k);
  if (existing) return existing;

  const attrs: oracledb.PoolAttributes = {
    user:          conn.user,
    password:      conn.password,
    connectString: conn.connectString,
    poolAlias:     k,
    poolMin:       1,
    poolMax:       5,
    poolIncrement: 1,
    poolTimeout:   120,
  };

  // mTLS wallet (base64 of wallet.zip — node-oracledb 6.x thin mode)
  if (conn.walletContent) {
    const walletBuffer = Buffer.from(conn.walletContent, 'base64');
    // Thin mode accepts walletContent as a Buffer
    (attrs as Record<string, unknown>).walletContent  = walletBuffer;
    if (conn.walletPassword)
      (attrs as Record<string, unknown>).walletPassword = conn.walletPassword;
  }

  logger.info('Creating Oracle pool', { userId: key.userId, conn: key.connectionName });
  const pool = await oracledb.createPool(attrs);
  pools.set(k, pool);
  return pool;
}

export async function closePool(key: PoolKey): Promise<void> {
  const k = toKey(key);
  const pool = pools.get(k);
  if (!pool) return;
  await pool.close(0).catch((err: unknown) => logger.warn('Pool close error', { err }));
  pools.delete(k);
  logger.info('Oracle pool closed', { key: k });
}

export async function closeAllPools(): Promise<void> {
  const keys = [...pools.keys()];
  await Promise.allSettled(keys.map(k => {
    const pool = pools.get(k)!;
    return pool.close(0).catch(() => {}).finally(() => pools.delete(k));
  }));
  logger.info(`Closed ${keys.length} Oracle pool(s)`);
}
