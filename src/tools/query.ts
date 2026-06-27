/**
 * MCP tools: SQL execution
 *   - execute_query
 *   - explain_plan
 */
import { runQuery, getExplainPlan } from '../oracle/client.js';
import type { McpToolResult, QueryRow } from '../types.js';

export async function handleQueryTools(
  toolName: string,
  args:     Record<string, unknown>,
  userId:   string,
): Promise<McpToolResult> {
  const connectionName = String(args.connection);
  const sql            = String(args.sql);

  if (toolName === 'execute_query') {
    const maxRows = Math.min(Number(args.max_rows ?? 200), 1000);
    const result  = await runQuery({ userId, connectionName, sql, maxRows });
    return ok(fmtResult(result.rows, result.columns, result.rowsAffected));
  }

  if (toolName === 'explain_plan') {
    const plan = await getExplainPlan({ userId, connectionName, sql });
    return ok(plan);
  }

  throw new Error(`Unknown query tool: ${toolName}`);
}

// ── helpers ──────────────────────────────────────────────────────────────

function fmtResult(rows: QueryRow[], columns: string[], rowsAffected?: number): string {
  if (rows.length === 0 && rowsAffected !== undefined)
    return `Statement executed. Rows affected: ${rowsAffected}`;
  if (rows.length === 0)
    return 'No results.';

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
