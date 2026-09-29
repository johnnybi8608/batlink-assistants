#!/usr/bin/env node
// Memory MCP bridge (stdio): lists the memory tools to the AI and forwards calls unchanged to the bot main process
// (POST /mem/call). It makes no decisions itself; all permission checks happen in src/memdb/service.js.
//
// The identity is fixed by the launch arguments; whatever the AI claims in the conversation does not matter:
//   node bin/mem-mcp.js --actor lingxi --role chat --reminders
//   node bin/mem-mcp.js --actor claude@myproject --role project --project myproject
//   node bin/mem-mcp.js --actor claude@dm --role assistant
//   node bin/mem-mcp.js --actor desktop-claude --role desktop
// Options: --self <person> (whom "the owner" means for this assistant), --reminders (enable mem_reminder_* tools),
//          --port <daemon port>, --token-file <path of the API token> (set by the launcher; fall back to config.json)

import { createInterface } from 'node:readline';
import { toolsFor } from '../src/memdb/tools.js';
import { PORT, localFetch } from '../src/local.js';

const args = process.argv.slice(2);
const arg = (name) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : null);
const identity = { actor: arg('actor'), role: arg('role'), project: arg('project'), self: arg('self'), reminders: args.includes('--reminders') };
const port = arg('port') ?? PORT;

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const replyError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

async function callTool(name, input) {
  if (!toolsFor(identity.actor, identity.role, identity).some((t) => t.name === name)) return text(`Unknown tool: ${name}`, true);
  try {
    const res = await localFetch(`/mem/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity, tool: name, args: input ?? {} }),
      signal: AbortSignal.timeout(30000)
    }, { port, tokenFile: arg('token-file') ?? undefined });
    const body = await res.json().catch(() => ({}));
    if (res.status === 503) return text('Memory database temporarily unavailable (the bot main process has not opened it); try again later.', true);
    if (!res.ok) return text(`Memory database error (${res.status}): ${body.error ?? ''}`, true);
    if (!body.ok) return text(body.error, true);
    return text(JSON.stringify(body.result, null, 1));
  } catch {
    return text('Memory database temporarily unavailable (cannot reach the bot main process); try again later.', true);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications (notifications/initialized etc.) need no reply
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'memdb', version: '1.0.0' },
        // Shown to the AI (Chinese, like the tool descriptions)
        instructions: '私人资料库:机主本人、家人、健康、工作流水、服务器、客户与收费。需要了解这些时先查;有新信息按规则记下。'
      });
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: toolsFor(identity.actor, identity.role, identity).map((t) => ({ name: t.name, description: t.description, inputSchema: t.input })) });
    case 'tools/call':
      return reply(id, await callTool(params?.name, params?.arguments));
    default:
      return replyError(id, -32601, `Method not supported: ${method}`);
  }
});
