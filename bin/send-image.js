#!/usr/bin/env node
// Send an image to a group as one of the bots (calls the local daemon's /send-image).
// The image is compressed to the app's group image spec (long edge 1280, JPEG, <=160KB); anything macOS
// can open (png/jpg/heic, ...) works. To add a caption, send a separate text with send.js.
//
// Usage: node bin/send-image.js --agent zhaoxiaoliu --group <groupId> --file /absolute/path/image.png
//        node bin/send-image.js --agent zhaoxiaoliu --dm --file /absolute/path/image.png   (direct message to the owner)

import { resolve } from 'node:path';
import { PORT, requireAgent, localFetch } from '../src/local.js';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const agent = requireAgent(opt('agent'));
const groupId = opt('group');
const file = opt('file');
const toDm = args.includes('--dm') || groupId === 'dm';
if ((!groupId && !toDm) || !file) {
  console.error('Usage: node bin/send-image.js --agent <agentId> --group <groupId> --file <image path>\n   or: node bin/send-image.js --agent <agentId> --dm --file <image path>   (direct message to the owner)');
  process.exit(2);
}
const res = await localFetch(`/${toDm ? 'dm-image' : 'send-image'}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(toDm ? { agent, path: resolve(file) } : { agent, groupId, path: resolve(file) })
});
const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`Sending image failed: ${res.status} ${body.error ?? JSON.stringify(body)}`);
  process.exit(1);
}
console.log(`Image sent (${agent} -> ${toDm ? 'owner (direct)' : groupId}, ${body.width}x${body.height}, ${Math.round(body.bytes / 1024)}KB)`);
