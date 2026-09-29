# Architecture

## Processes

| Process | File | launchd label | Job |
|---|---|---|---|
| daemon | `src/daemon.js` | `io.github.batlink-assistants.daemon` | Holds every bot's Batlink identity; keeps a WebSocket to the node; decrypts incoming messages and appends them to message streams; exposes a local HTTP API (127.0.0.1) for sending; hosts memdb; fires due reminders. |
| waker | `bin/waker.js` | `…waker` | One loop per `config.wakers` entry: waits for the next mention / DM (`bin/listen.js --once`), builds the prompt, runs the right engine, sends the reply. |
| mailwatch | `bin/mailwatch.js` | `…mailwatch` | Polls the configured mailboxes and pushes new mail to 旺财's DM; executes 「发送」 approvals. Installed only when `config.mail` has accounts. |

All three read `config.json` (or `$AGENTS_CONFIG`) and write under `dataDir` (default `./data`).

## Data directory

```
data/
  master-seed.key             32 random bytes; every bot identity is derived from it (BACK IT UP, keep it secret)
  api-token                   secret for the local HTTP API (created on first start)
  <bot>/state.json            per-bot state: groups, keys, epochs
  <bot>/hello-sent            the one-time hello was sent
  owner.json                  cached owner public key (resolved from owner.address)
  streams/<bot>/<chat>.jsonl  every message the bot saw; "dm" is the private chat with its owner
  cursors/<bot>/<chat>.json   how far the waker has read
  context/<bot>/…             long wake-up contexts written to a file (contextFile)
  media/<bot>/…               received / sent images and voice messages (+ .txt transcripts)
  memdb/memory.db             the private database (SQLite, WAL)
  memdb/files/                documents saved by the assistants (reports, prescriptions…)
  persona/<bot>/              working folders of persona sessions (empty on purpose)
  translator/<bot>/           清越's language settings and recent history
  mail/                       client.json (Google OAuth client), per-mailbox indexes, 旺财's empty working folder
  waker.log                   one line per wake-up / failure
  *.stdout.log                output of the launchd services (daemon, waker, mailwatch)
```

## Message flow

1. The daemon receives an encrypted envelope over WebSocket and **verifies it itself** instead of trusting the relay node: the sender's signature over `messageId|recipient|createdAt|expiresAt|ciphertext` (recipient = this bot), sender address = derived from the key, not expired, not from the future, not a replay (`<bot>/seen-messages.json`). Group cards are accepted only with a valid admin-key signature, the sender listed as a member, and the admin key unchanged once the group is known; group messages from non-members are dropped. Then it decrypts (`src/batlink/crypto.js`, `src/agent.js`, `src/group.js`), stores media, and appends one JSON line to `streams/<bot>/<chat>.jsonl`. Private messages from anyone other than the bot's owner are ignored.
2. `bin/listen.js --once` (spawned by the waker) returns the next line that should wake this bot — a mention by the owner in a group, an owner DM (except a lone image for bots without `wakeOnImage`, and 旺财's 「发送」/「原文」 commands, which mailwatch handles), or a due reminder — together with **context**: every message in that chat since the bot was last woken (long context goes to a file, `contextFile`).
3. The waker transcribes voice messages in DMs (`src/voice.js`, optional), then:
   - **claude / codex** engines: `claude -p --resume <session>` / `codex exec resume <session> -` with the prompt on stdin. Read-only by default; the final answer is posted by the waker. With `fullAccess`, the AI posts its own reply with `bin/dm.js` / `bin/send.js`.
   - **persona**: `src/persona.js` runs Codex (or the Grok CLI) in a read-only sandbox; output JSON `{text, voice}`; images the model drew are picked up from `~/.codex/generated_images/<session>/`.
   - **mailbot**: `src/mail/assistant.js` asks a zero-tool Claude session for a JSON plan and executes the allowed operations itself.
   - **translator**: `src/translator.js` calls an OpenAI-compatible API directly.
4. Replies go through the daemon's HTTP API (`/dm`, `/send`, `/dm-image`, `/dm-voice`, …), which encrypts and delivers them.

No wake-up, no AI process: an idle assistant uses no tokens.

## Local HTTP API

See the header of `src/daemon.js` for the full list. The main calls:

```
GET  /status
POST /send        {agent, groupId, text}
POST /dm          {agent, text}
POST /dm-image    {agent, path}
POST /dm-voice    {agent, text, voiceId?, languageBoost?}   (at most 60 s; longer → 413 voice_too_long)
POST /mem/call    {identity, tool, args}     (memdb; used by bin/mem-mcp.js)
```

It listens on 127.0.0.1 only and every request must carry the token from `data/api-token` (`Authorization: Bearer …`, created on first start, mode 600). Requests with an `Origin` header, a non-loopback `Host` (DNS rebinding) or a POST that is not `application/json` are refused — a web page in your browser cannot drive your bots. Use `localFetch()` from `src/local.js`; never expose the port.

## memdb

- `src/memdb/schema.js` — tables (entities, facts, relations, events, health, servers, customers, billing, reminders, files…), history triggers, full-text search (FTS5 trigram), write permissions per role and category.
- `src/memdb/service.js` — every read/write goes through `MemService.call(identity, tool, args)`, which enforces the rules: provenance (who / said by / origin), supersede-don't-overwrite, read restrictions, idempotency by `source_ref`.
- `src/memdb/tools.js` — the tool list and descriptions the AIs see (Chinese), and which roles see which tools.
- `bin/mem-mcp.js` — a stdio MCP server that forwards tool calls to `POST /mem/call`. **The identity (actor, role, project, self) is fixed by its command-line arguments**, which the waker sets per wake-up (`src/memdb/mcp-args.js`) — an AI cannot claim to be someone else.

Roles: `owner`, `family` (humans acting directly), `desktop` (your own desktop AI sessions), `assistant` (DM assistants), `project` (project-group bots; only their own project's work log), `chat` (persona assistants), `family-assistant` (a family member's assistant: no work / infra / finance), `import`.

## Identities

`src/batlink/keys.js` derives each bot's secp256k1 key from the master seed and the bot id (`deriveIdentity(seed, 'agent', id)`). Same seed + same id = same Batlink address, so renaming a bot's display name is harmless but **changing its `id` creates a new account**.
