# Xenica AFFiNE read/write MCP bridge

A separate, fixed-owner/workspace adapter for AFFiNE **0.27.4**. The original server is unchanged. This package uses that release's native Markdown/CRDT transforms and authenticated Socket.IO workspace sync rather than requiring Copilot, model credentials, an indexer, or a canary deployment.

Deployment, OAuth, maintenance and acceptance evidence live in [StLixx/Xenica](https://github.com/StLixx/Xenica/pull/80). This package exposes an internal authenticated RPC service; it must never be published directly. The Xenica OAuth gateway exposes the MCP endpoint.

## Tools

- `list_documents`, `doc_search`, `read_document`
- `create_document`, `update_document`, `update_document_meta`

Search scans live accessible title/body content (including Chinese), returns bounded excerpts and URLs, and refuses workspaces above the configured scan limit instead of silently claiming a complete result. Writes require a unique `idempotency_key`; updates also require the revision returned by `read_document`. Reuse the exact arguments/key after uncertain delivery. A changed document requires reading again and a new key.

Body editing supports one-note Markdown documents: paragraphs, headings, lists, task items, code and dividers. Image, database, embed, math, rich inline and populated canvas documents are rejected before body replacement. Title updates preserve those bodies. No delete, sharing, arbitrary code execution or caller-selected workspace tool is exposed.

Native CRDT differences preserve unrelated changes. Revision checks catch changes observed before submission, but AFFiNE's existing sync API has no atomic compare-and-swap: an edit arriving between the check and push can merge according to Yjs rules. Avoid simultaneous editing of the same paragraph. The bridge verifies accepted updates and retains durable intent/result records so a transport retry does not create another document. This is not a general workspace transaction API.

## Build and test on Infra

The parent monorepo uses Yarn workspaces. Build this package in its isolated Docker context; do not run npm install at the monorepo root.

```sh
docker build -t xenica-affine-rw-bridge:<revision> tools/xenica-mcp
docker run --rm --network none \
  -v "$PWD/tools/xenica-mcp/test:/mcp/test:ro" \
  -e AFFINE_NATIVE_PATH=/app/dist/server-native.x64.node \
  --entrypoint node xenica-affine-rw-bridge:<revision> --test test/documents.test.mjs
```

Tests use an in-memory sync transport and temporary SQLite files, never a production workspace.

The image pins the original 0.27.4 OCI digest; reusing this bridge with another AFFiNE/native schema requires compatibility tests. Runtime configuration is mounted read-only at `/private/bridge.json`, state at `/state`:

```json
{"public_url":"https://affine.example.com","upstream_url":"http://affine:3010","owner_id":"fixed-owner","workspace_id":"fixed-workspace","email":"owner@example.com","password":"EXISTING_PRIVATE_PASSWORD","bridge_secret":"PRIVATE_RANDOM_SECRET"}
```

Keep configuration and SQLite state private. The state contains document bodies needed for idempotent retry. Audit rows store hashed caller identity, tool, document ID, time and outcome; they do not log credentials or document text. Limit the service to one replica because write serialization is process-local. The original AFFiNE login session and permissions remain authoritative for sync access.
