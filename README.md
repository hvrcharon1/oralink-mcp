# OraLink MCP

> Oracle Autonomous Database MCP Server — an OAuth 2.0-compatible, hosted connector for Claude.ai and any MCP client.

[![License: Datacules LLC OSL](https://img.shields.io/badge/License-Datacules_OSL-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue.svg)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-1.x-green.svg)](https://modelcontextprotocol.io)
[![Node](https://img.shields.io/badge/Node.js-18%2B-brightgreen.svg)](https://nodejs.org)

## What is this?

OraLink MCP is a hosted, OAuth 2.0-compatible [Model Context Protocol](https://modelcontextprotocol.io) server that bridges **any MCP client** (Claude.ai, Claude Desktop, Cursor, VS Code Copilot, Cline, etc.) to **Oracle Autonomous Database on OCI** — with no SQLcl, no Oracle Instant Client, and no local tooling required.

Unlike Oracle's existing SQLcl MCP server (STDIO/local-only), OraLink MCP:

- Runs as an **HTTPS endpoint** reachable from the cloud
- Implements **OAuth 2.0 authorization code flow** — eligible for the Claude.ai connector marketplace
- Works from **any device including mobile**
- Connects to **any Oracle ADB instance** across regions
- Uses **node-oracledb Thin Mode** — no Oracle Client libraries needed

## Architecture

```
Claude.ai / Cursor / Any MCP Client
        │  (MCP over HTTPS + Bearer token)
        ▼
┌──────────────────────────┐
│       OraLink MCP        │
│  ┌──────────────────┐   │
│  │   OAuth 2.0      │   │
│  │   /oauth/*       │   │
│  └────────┬─────────┘   │
│  ┌─────────▼─────────┐  │
│  │   MCP Tools       │  │
│  │ schema / query /  │  │
│  │ metadata / DDL    │  │
│  └────────┬──────────┘  │
│  ┌─────────▼─────────┐  │
│  │  node-oracledb    │  │
│  │  (Thin Mode v6)   │  │
│  └────────┬──────────┘  │
└───────────┼──────────────┘
            │  (TLS / mTLS)
            ▼
  Oracle Autonomous Database
        (OCI Cloud)
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `list_connections` | List registered ADB connections for this account |
| `list_schemas` | List all accessible schemas |
| `list_tables` | List tables/views in a schema |
| `describe_table` | Column definitions, data types, constraints |
| `execute_query` | Run a SELECT query (read-only by default) |
| `explain_plan` | Get Oracle execution plan for a SQL statement |
| `get_ddl` | Get DDL for any object (TABLE, VIEW, PROCEDURE...) |
| `list_procedures` | List stored procedures, functions, packages |

## Quick Start

### Prerequisites

- Node.js 18+
- An Oracle Autonomous Database instance (19c or 26ai)
- OCI wallet `.zip` (for mTLS) or TLS connection string

### Install & run

```bash
git clone https://github.com/hvrcharon1/oralink-mcp.git
cd oralink-mcp
npm install
cp .env.example .env
# Edit .env — see MANUAL_STEPS.md for secret generation
npm run dev
```

### Connect your MCP client

```json
{
  "mcpServers": {
    "oralink": {
      "type": "streamableHttp",
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer <your_access_token>"
      }
    }
  }
}
```

## OAuth 2.0 Flow (for Claude.ai marketplace)

```
1. User clicks "Connect Oracle ADB" in Claude.ai
2. Redirected → GET /oauth/authorize
3. User enters ADB connection details (connect string, username, password, wallet)
4. POST /oauth/authorize → stores encrypted credentials, issues auth code
5. POST /oauth/token → returns access_token (JWT) + refresh_token
6. Claude.ai stores token, sends as Bearer on every MCP request
7. OraLink validates JWT → routes to per-user Oracle connection pool
```

### Discovery document

`GET /.well-known/oauth-authorization-server` returns the RFC 8414 metadata document required by Claude.ai.

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

## License

[Datacules LLC Open Source License](LICENSE) © 2026 Datacules LLC
