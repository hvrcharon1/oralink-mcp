<p align="center">
  <img src="logo.svg" alt="OraLink MCP" width="460"/>
</p>

# OraLink MCP

> Oracle Autonomous Database MCP Server — an OAuth 2.0-compatible, hosted connector for Claude.ai and any MCP client.

[![License: Datacules LLC OSL](https://img.shields.io/badge/License-Datacules_OSL-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue.svg)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-1.x-green.svg)](https://modelcontextprotocol.io)
[![Node](https://img.shields.io/badge/Node.js-18%2B-brightgreen.svg)](https://nodejs.org)
[![Tools](https://img.shields.io/badge/Tools-28-orange.svg)](#mcp-tools)

## What is this?

OraLink MCP is a hosted, OAuth 2.0-compatible [Model Context Protocol](https://modelcontextprotocol.io) server that bridges **any MCP client** (Claude.ai, Claude Desktop, Cursor, VS Code Copilot, Cline, etc.) to **Oracle Autonomous Database on OCI** — with no SQLcl, no Oracle Instant Client, and no local tooling required.

Unlike Oracle's existing SQLcl MCP server (STDIO/local-only), OraLink MCP:

- Runs as an **HTTPS endpoint** reachable from the cloud
- Supports **two auth paths**: OAuth 2.0 (for Claude.ai marketplace) and static API keys (for OCI ADB public-endpoint / no-OAuth setups)
- Works from **any device including mobile**
- Connects to **any Oracle ADB instance** across regions
- Uses **node-oracledb Thin Mode** — no Oracle Client libraries needed
- Provides **28 MCP tools** across connection mgmt, schema, query, objects, data, and admin categories

## Architecture

```
Claude.ai / Cursor / Any MCP Client
        │  (MCP over HTTPS)
        │  Auth: Bearer <jwt>  — OAuth 2.0 flow
        │        ApiKey <key>  — static key (OCI public-endpoint path)
        ▼
┌──────────────────────────────────┐
│          OraLink MCP             │
│  ┌──────────────────────────┐   │
│  │   Auth layer             │   │
│  │  OAuth 2.0 /oauth/*      │   │
│  │  API Key  ORALINK_API_KEYS│  │
│  └───────────┬──────────────┘   │
│  ┌───────────▼──────────────┐   │
│  │   MCP Tools (28)         │   │
│  │ add/remove/test_conn /   │   │
│  │ schema / query / objects │   │
│  │ data / metadata / admin  │   │
│  └───────────┬──────────────┘   │
│  ┌───────────▼──────────────┐   │
│  │  node-oracledb (Thin v6) │   │
│  └───────────┬──────────────┘   │
└──────────────┼───────────────────┘
               │  (TLS / mTLS)
               ▼
     Oracle Autonomous Database
           (OCI Cloud)
```

## Authentication paths

### Path 1 — OAuth 2.0 (Claude.ai marketplace)

The standard OAuth 2.0 authorization code flow. Claude.ai handles the redirect;
the user fills in their ADB connection details on the OraLink consent form.

```
1. User clicks "Connect Oracle ADB" in Claude.ai
2. Redirected → GET /oauth/authorize
3. User enters ADB details (connect string, ADMIN username, ADMIN password, optional wallet)
4. POST /oauth/authorize → stores encrypted credentials, issues auth code
5. POST /oauth/token → returns access_token (JWT) + refresh_token
6. Claude.ai stores token, sends as Bearer on every MCP request
```

### Path 2 — Static API key (OCI ADB public endpoint, no OAuth)

OCI Autonomous Database does **not** provide its own OAuth server. When your ADB
instance is on a **public endpoint** (access controlled via OCI network ACL or
resource tag), you can skip the OAuth consent flow and connect with a static
pre-shared API key instead.

**OCI setup (one-time):**

1. In OCI Console → your ADB → **Network → Access Control List**: add the IP
   address of your OraLink server (or use a CIDR / VCN OCID tag).
2. Under **DB Connection**: copy the **TLS** connect string (not the mTLS/wallet
   download — public-endpoint ADB-S has supported one-way TLS without a wallet
   since 2023). It looks like:
   ```
   (description=(retry_count=20)(retry_delay=3)
     (address=(protocol=tcps)(port=1522)
       (host=adb.us-ashburn-1.oraclecloud.com))
     (connect_data=(service_name=g1abc2def_mydb_high.adb.oraclecloud.com))
     (security=(ssl_server_dn_match=yes)))
   ```

**OraLink server setup:**

```bash
# Generate a key and a userId
export MY_KEY=$(openssl rand -hex 32)
export MY_USER=$(node -e "console.log(require('crypto').randomUUID())")

# Add to .env
echo "ORALINK_API_KEYS=${MY_KEY}:${MY_USER}" >> .env
```

**MCP client config** (`~/.config/claude/claude_desktop_config.json` or `mcp.json`):

```json
{
  "mcpServers": {
    "oralink": {
      "type": "streamableHttp",
      "url": "https://your-oralink-server.example.com/mcp",
      "headers": {
        "Authorization": "ApiKey YOUR_KEY_HERE"
      }
    }
  }
}
```

**Register your ADB connection** (call from Claude / any MCP client):

```
Call tool: add_connection
  connection_name : "prod-adb"
  connect_string  : "(description=...paste TLS connect string here...)"
  db_user         : "ADMIN"
  db_password     : "<the ADMIN password you set when creating the ADB instance in OCI Console>"
  allow_dml       : false
```

> **Where is the ADMIN password?**  
> OCI creates an `ADMIN` user automatically when you provision an Autonomous Database.
> The password for this user is whatever you typed in the **"Administrator credentials"**
> section of the **Create Autonomous Database** wizard in the OCI Console. If you forgot
> it, you can reset it from OCI Console → your ADB → **More Actions → Reset Admin Password**.

Then verify it works:

```
Call tool: test_connection
  connection : "prod-adb"
```

If the test passes you'll see the Oracle version banner. You're ready to use all
28 tools against your ADB instance with no OAuth flow required.

## MCP Tools

### Connection Management (3 tools)

| Tool | Description |
|------|-------------|
| `add_connection` | Register a new ADB connection (OAuth or API-key path) |
| `remove_connection` | Remove a registered connection |
| `test_connection` | Verify a connection by running SELECT on V$VERSION |

### Schema & Metadata (8 tools)

| Tool | Description |
|------|-------------|
| `list_connections` | List registered ADB connections for this account |
| `list_schemas` | List all accessible schemas |
| `list_tables` | List tables/views in a schema |
| `describe_table` | Column definitions, data types, nullable flags |
| `execute_query` | Run a SELECT query (read-only by default, max 1000 rows) |
| `explain_plan` | Get Oracle execution plan for a SQL statement |
| `get_ddl` | Get DDL for any object (TABLE, VIEW, PROCEDURE...) |
| `list_procedures` | List stored procedures, functions, packages |

### Object Inspection (7 tools)

| Tool | Description |
|------|-------------|
| `list_indexes` | List indexes on a table or schema (columns, uniqueness, status) |
| `list_constraints` | List PK, FK, UNIQUE, CHECK constraints on a table |
| `list_sequences` | List sequences with min/max/increment/cache settings |
| `list_triggers` | List triggers on a table or schema |
| `list_synonyms` | List synonyms accessible to the user |
| `get_view_definition` | Get the full SQL text behind a view |
| `search_objects` | Search any object by name pattern (LIKE syntax) |

### Data Access & DML (4 tools)

| Tool | Description |
|------|-------------|
| `count_rows` | Fast COUNT(*) with optional WHERE filter |
| `get_sample_data` | Sample rows from a table with optional filter/sort |
| `execute_dml` | Run INSERT / UPDATE / DELETE / MERGE (requires allowDml) |
| `execute_plsql` | Run an anonymous PL/SQL block with DBMS_OUTPUT capture |

### Administration (6 tools)

| Tool | Description |
|------|-------------|
| `get_db_info` | Database version, name, open mode, log mode, platform |
| `get_table_stats` | Optimizer statistics: rows, blocks, size in MB |
| `get_tablespace_usage` | Tablespace used/total GB and percent used |
| `list_grants` | Object-level grants, filterable by owner/object/grantee |
| `list_active_sessions` | Active sessions from V$SESSION with idle time |
| `list_invalid_objects` | Objects with STATUS != VALID |

## Quick Start

### Prerequisites

- Node.js 18+
- An Oracle Autonomous Database instance (19c or 26ai)
- OCI network ACL allowing your server's IP (public-endpoint path), or
- OCI wallet `.zip` (for mTLS / private-endpoint path)

### Install & run

```bash
git clone https://github.com/hvrcharon1/oralink-mcp.git
cd oralink-mcp
npm install
cp .env.example .env
# Edit .env — see MANUAL_STEPS.md for secret generation
npm run dev
```

### Discovery document

`GET /.well-known/oauth-authorization-server` returns the RFC 8414 metadata
document required by Claude.ai marketplace registration.

## Deployment

See [MANUAL_STEPS.md](MANUAL_STEPS.md) for actions requiring human input.

```bash
# Docker
docker compose up -d
```

## Security

- Credentials encrypted at rest with AES-256-GCM
- Per-user isolated connection pools
- Only SELECT allowed by default; DML requires explicit opt-in per connection
- All queries logged with user context
- Wallet content held in memory only — never written to disk
- SQL injection prevention via Oracle parameterized query API
- API keys never stored; only the key→userId mapping lives in env at startup

## License

[Datacules LLC Open Source License](LICENSE) © 2026 Datacules LLC
