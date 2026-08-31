#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { loadConfig, paths } from '../lib/config.mjs';
import { openDatabase } from '../lib/db.mjs';
import { TOOLS, createToolHandlers, callTool } from './tools.mjs';

const SERVER_INFO = { name: 'shiplog', version: '0.1.0' };

/**
 * Everything the JSON-RPC layer needs, decoupled from stdio so it can be driven
 * directly in tests. `getDb`/`getCfg` are lazy: neither is required to exist for the
 * server to start, since a fresh install has no config and no data yet.
 */
export function createDispatcher({ getCfg, getDb }) {
  // Config can go from absent to present mid-session (setup completing after the
  // server started), so handlers are rebuilt per call rather than cached once.
  const handlers = () => createToolHandlers({ cfg: getCfg(), getDb });

  return function dispatch(request) {
    const { id, method, params } = request;
    const respond = (result) => (id === undefined ? null : { jsonrpc: '2.0', id, result });
    const fail = (code, message) => (id === undefined ? null : { jsonrpc: '2.0', id, error: { code, message } });

    switch (method) {
      case 'initialize':
        return respond({
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });

      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;   // notifications carry no id and expect no response

      case 'tools/list':
        return respond({ tools: TOOLS });

      case 'tools/call': {
        const result = callTool(handlers(), params?.name, params?.arguments);
        return respond(result);
      }

      case 'ping':
        return respond({});

      default:
        return fail(-32601, `method not found: ${method}`);
    }
  };
}

function main() {
  const p = paths();
  let cfg;
  let cfgLoaded = false;
  const getCfg = () => {
    if (!cfgLoaded) {
      cfgLoaded = true;
      try {
        cfg = loadConfig();
      } catch {
        cfg = null;   // no setup yet; tool calls report this, the server still starts
      }
    }
    return cfg;
  };

  // One connection, opened once, held for the process lifetime - see
  // docs/DECISIONS.md "Query server connection handling". Re-checked lazily in case
  // the first sync completes after the server has already started.
  let db;
  const getDb = () => {
    if (!db && existsSync(p.db)) db = openDatabase(p.db, { readOnly: true });
    return db ?? null;
  };

  const dispatch = createDispatcher({ getCfg, getDb });
  const rl = createInterface({ input: process.stdin, terminal: false });

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let request;
    try {
      request = JSON.parse(trimmed);
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'invalid JSON' } })}\n`);
      return;
    }

    let response;
    try {
      response = dispatch(request);
    } catch (err) {
      response = request.id === undefined
        ? null
        : { jsonrpc: '2.0', id: request.id, error: { code: -32603, message: err.message } };
    }
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  });

  rl.on('close', () => {
    db?.close();
    process.exit(0);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) main();
