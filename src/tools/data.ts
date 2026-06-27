/**
 * MCP tools: data access and mutation
 *
 *   count_rows      — fast COUNT(*) with optional WHERE filter
 *   get_sample_data — SELECT * FETCH FIRST N ROWS with optional ORDER BY
 *   execute_dml     — INSERT / UPDATE / DELETE / MERGE (requires allowDml)
 *   execute_plsql   — anonymous PL/SQL block with DBMS_OUTPUT capture (requires allowDml)
 */
import { runQuery, runPlSql } from '../oracle/client.js';
import type { McpToolResult, QueryRow } from '../types.js';

export async function handleDataTools(
  toolName: string,
  args:     Record<string, unknown>,
  userId:   string,
): Promise<McpToolResult> {
  const connectionName = String(args.connection);

  // ── count_rows ──────────────────────────────────────────────────────────────

  if (toolName === 'count_rows') {
    const schema    = args.schema ? String(args.schema).toUpperCase() : undefined;
    const table     = String(args.table).toUpperCase();
    const where     = args.where_clause ? String(args.where_clause) : '';
    const tableFull = schema ? `${schema}.${table}` : table;
    const whereSQL  = where ? `WHERE ${where}` : '';

    const result = await runQuery({ userId, connectionName,
      sql: `SELECT COUNT(*) AS ROW_COUNT FROM ${tableFull} ${whereSQL}`,
    });
    const count = result.rows[0]?.['ROW_COUNT'] ?? '?';
    return ok(`Row count for ${tableFull}${where ? ` (WHERE ${where})` : ''}: **${count}**`);
  }

  // ── get_sample_data ─────────────────────────────────────────────────────

  if (toolName === 'get_sample_data') {
    const schema    = args.schema ? String(args.schema).toUpperCase() : undefined;
    const table     = String(args.table).toUpperCase();
    const limit     = Math.min(Number(args.limit ?? 20), 100);
    const orderBy   = args.order_by ? String(args.order_by) : '';
    const where     = args.where_clause ? String(args.where_clause) : '';
    const tableFull = schema ? `${schema}.${table}` : table;
    const orderSQL  = orderBy ? `ORDER BY ${orderBy}` : '';
    const whereSQL  = where   ? `WHERE ${where}` : '';

    const result = await runQuery({ userId, connectionName,
      sql:     `SELECT * FROM ${tableFull} ${whereSQL} ${orderSQL} FETCH FIRST ${limit} ROWS ONLY`,
      maxRows: limit,
    });
    return ok(fmtTable(result.rows, result.columns));
  }

  // ── execute_dml ─────────────────────────────────────────────────────────────

  if (toolName === 'execute_dml') {
    const sql    = String(args.sql);
    const result = await runQuery({ userId, connectionName, sql });
    return ok(`DML executed successfully.\nRows affected: ${result.rowsAffected ?? 0}`);
  }

  // ── execute_plsql ─────────────────────────────────────────────────────────

  if (toolName === 'execute_plsql') {
    const sql          = String(args.sql);
    const { output }   = await runPlSql({ userId, connectionName, sql });
    return ok(output);
  }

  throw new Error(`Unknown data tool: ${toolName}`);
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
