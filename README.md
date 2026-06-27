# OraLink MCP

**Oracle Autonomous Database MCP Server** — an OAuth-compatible, cloud-hosted [Model Context Protocol](https://modelcontextprotocol.io) connector that lets Claude (and any MCP client) query, inspect, and manage Oracle ADB databases using natural language.

[![CI](https://github.com/hvrcharon1/oralink-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/hvrcharon1/oralink-mcp/actions/workflows/ci.yml)
![Version](https://img.shields.io/badge/version-0.2.0-blue)
![License](https://img.shields.io/badge/license-Proprietary-red)

---

## Why OraLink?

Oracle does not publish an official MCP connector for Claude.ai. OraLink fills that gap: it wraps Oracle's `oracledb` Node.js driver behind a StreamableHTTP MCP server with full OAuth 2.0 authorization code flow, so you can connect Claude directly to your Autonomous Database — ATP, ADW, or JSON — without exposing credentials.

---

## Architecture

```
Claude.ai / MCP Client
        │  Bearer token (JWT)
        ▼
┌─────────────────────────────┐
│   OraLink MCP Server        │  Express + StreamableHTTP
│                             │
│  ┌──────────┐  ┌─────────┐  │
│  │  OAuth   │  │  MCP    │  │
│  │  Layer   │  │  Tools  │  │  25 tools across 5 categories
│  └──────────┘  └─────────┘  │
│         │            │       │
│         └────────────┘       │
│              │               │
│        ┌─────────┐           │
│        │ Oracle  │           │
│        │ Client  │           │  oracledb + connection pool
│        └─────────┘           │
└─────────────────────────────┘
              │
     Oracle Autonomous DB
     (ATP / ADW / JSON)
```

---

## Tool Reference (25 tools)

### 🔗 Schema Tools

| Tool | Description |
|------|-------------|
| `list_connections` | List all Oracle ADB connections registered to this account |
| `list_schemas` | List all schemas (users) accessible to the connected user |
| `list_tables` | List tables and views in a schema (filter by TABLE / VIEW / ALL) |
| `describe_table` | Get column definitions, data types, nullable flags, and defaults |

### 🔍 Query Tools

| Tool | Description |
|------|-------------|
| `execute_query` | Execute a SQL SELECT — returns up to 200 rows (max 1000) |
| `explain_plan` | Get the Oracle execution plan via `DBMS_XPLAN.DISPLAY()` |

### 📋 Metadata Tools

| Tool | Description |
|------|-------------|
| `get_ddl` | Get the `CREATE` statement for any object (TABLE, VIEW, PROCEDURE, PACKAGE, …) |
| `list_procedures` | List stored procedures, functions, and packages in a schema |

### 🗂️ Object Tools

| Tool | Description |
|------|-------------|
| `list_indexes` | List indexes on a table or across a schema with column lists |
| `list_constraints` | List PK, FK, UNIQUE, and CHECK constraints on a table |
| `list_sequences` | List sequences with min/max, increment, cache, and last value |
| `list_triggers` | List triggers in a schema or on a specific table |
| `list_synonyms` | List synonyms accessible to the connected user |
| `get_view_definition` | Get the full SQL text behind a view |
| `search_objects` | Search any object by name pattern (SQL `LIKE` syntax) |

### 📊 Data Tools

| Tool | Description |
|------|-------------|
| `count_rows` | Fast `COUNT(*)` with optional `WHERE` clause |
| `get_sample_data` | `SELECT *` with optional `WHERE`, `ORDER BY`, and row limit |
| `execute_dml` | Run `INSERT` / `UPDATE` / `DELETE` / `MERGE` (requires `allowDml`) |
| `execute_plsql` | Run an anonymous PL/SQL block and capture `DBMS_OUTPUT` |

### 🛡️ Admin Tools

| Tool | Description |
|------|-------------|
| `get_db_info` | Database version, name, open mode, and platform |
| `get_table_stats` | Optimizer statistics: rows, blocks, size, last analyzed |
| `get_tablespace_usage` | Tablespace used / total GB and percent used |
| `list_grants` | Object-level privileges — filter by object, schema, or grantee |
| `list_active_sessions` | Active user sessions from `V$SESSION` (top 50 by idle time) |
| `list_invalid_objects` | All objects with `STATUS != VALID` (broken packages, views, etc.) |

---

## Getting Started

### Prerequisites

- Node.js ≥ 18
- Oracle Autonomous Database instance (ATP, ADW, or JSON)
- Oracle Wallet / TLS connection string (mTLS or TLS)

### 1. Clone & install

```bash
git clone https://github.com/hvrcharon1/oralink-mcp.git
cd oralink-mcp
npm install
```

### 2. Configure

```bash
cp .env.example .env
# Edit .env with your Oracle connection details and JWT secret
```

Key variables:

```env
JWT_SECRET=your-32-char-secret
ORACLE_WALLET_DIR=/path/to/wallet
PORT=3000
```

### 3. Run

```bash
npm run dev          # development (tsx watch)
npm run build && npm start   # production
```

### 4. Connect to Claude

Set your MCP server URL in Claude.ai settings:

```
https://your-server.example.com/mcp
```

Complete the OAuth flow to authorize Claude, then start querying your Oracle database with natural language.

---

## Registering a Connection

Connections are registered via the REST API (see `MANUAL_STEPS.md` for the full setup flow):

```bash
curl -X POST https://your-server/connections \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "my-atp",
    "connectString": "(description=...)",
    "username": "ADMIN",
    "password": "...",
    "walletDir": "/wallets/my-atp"
  }'
```

---

## Security Notes

- All connections are stored encrypted per-user and never exposed through MCP tools
- DML tools (`execute_dml`, `execute_plsql`) require the connection to be registered with `allowDml: true`
- Access tokens are short-lived JWTs; refresh tokens are stored server-side
- TLS is required in production (set `TRUST_PROXY=true` behind a reverse proxy)

---

## License

Proprietary — see [LICENSE](LICENSE) for terms.
