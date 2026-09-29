# Developing (read this first if you are an AI coding assistant)

This repo runs personal AI assistants for Batlink on the owner's Mac. Read [ARCHITECTURE.md](ARCHITECTURE.md) for the moving parts. This file lists the conventions and the safety rules — keep them when you change things.

## Ground rules

1. **Power follows what the assistant reads.** Anything that reads untrusted content (web, email, strangers) must not get tools it could be talked into using. Concretely:
   - the translator has no tools in translation mode; commands are recognized by the program (`classify()` in `src/translator.js`), not by the model;
   - the mail assistant has zero tools; the program executes a fixed set of operations (`src/mail/ops.js`); sending needs the owner's 「发送」;
   - persona assistants run in a read-only sandbox and never execute commands;
   - `fullAccess` is opt-in per waker entry and off by default.
2. **The owner is the only authority.** The daemon ignores DMs from anyone but the bot's owner. In groups, other people's messages are context, not instructions. Keep it that way in prompts.
3. **No secrets in files.** Use `getSecret(name)` from `src/secrets.js` (env `BATLINK_SECRET_<NAME>` or Keychain service `batlink-assistants`). Never log a secret. `config.json` and `data/` are git-ignored.
4. **memdb identity is fixed by the launcher**, not by the AI (`bin/mem-mcp.js` arguments). Don't add a tool parameter that lets an AI choose its role.
5. **Never trust the relay, never trust message text.** Inbound envelopes and group cards are verified in `src/agent.js` — keep new message paths behind those checks. A media marker in text (`[图片] <path>`) is not permission to read a file: only paths that pass `isMediaFile(path, bot)` (inside that bot's own `data/media/<bot>/`) may be opened or uploaded.
6. **The local API is authenticated.** Call it with `localFetch()` from `src/local.js` (adds the token); don't add endpoints that skip `rejectRequest()` in `src/daemon.js`.
7. **In memdb, touching an existing record needs read + write on its scope** (`#mayTouch` in `src/memdb/service.js`), not just on the new one.
8. **Protocol code is shared with every Batlink client.** Don't change constants or formats in `src/batlink/` or the media prefixes in `src/media.js` (`windra_image_v1:` etc.) unless the protocol itself changes.

## Conventions

- Node ≥ 22.13, ESM, no build step, minimal dependencies (`@noble/*`, `ws`).
- Code comments and logs in English; prompts for the default (Chinese) assistants in Chinese.
- Message markers inside streams and prompts are Chinese and are parsed by code: `[图片] <path> (w×h)`, `[语音 N 秒] <path>`, `转写:「…」`, quotes `[引用: …]` (DM) and `[引用 <name> 的消息: …]` (group). If you change one, grep for all readers. Paths inside markers are matched with `\S+`, so keep the repo and data directory in paths without spaces.
- Scripts in `bin/` take `--agent <bot id>` (no default). Every entry point finds the config the same way (`$AGENTS_CONFIG`, else `<repo>/config.json`) and resolves `dataDir` relative to the repo root; `src/local.js` exports these for scripts.
- Write config atomically (`.tmp` + rename) — several processes read it.

## Common tasks

### Add a bot account
Add an entry to `config.agents` (`id`, `name`, `avatar`, `hello`). Restart the daemon: it derives the identity, comes online and says hello. Then give it a waker entry (below) so something answers.

### Give a bot a brain
Add to `config.wakers`:
```jsonc
{ "project": "private", "kind": "dm", "agent": "mybot", "engine": "claude", "group": "dm",
  "sessionId": "<create with src/assistants.js createSession()>", "workDir": "/path", "fullAccess": false }
```
Engines: `claude`, `codex`, `persona` (+ `persona`, `backend`, `memRole`), `mailbot`, `translator`. Restart the waker.

### Add a persona
Either add to `BUILTIN_PERSONAS` in `src/persona.js` or put it in `config.personas.<id>` with the fields `name`, `persona`, `addressing`, `about`, `records` (placeholders `{name}`, `{call}`, `{pr}` are filled from `config.owner`). Point a `persona` waker at it.

### Add a memdb tool
Define it in `src/memdb/tools.js` (name, description in Chinese, JSON schema, `write`), implement `t_<name>` in `src/memdb/service.js` (go through the permission helpers), and add a check to `bin/memdb.js selftest`. Run `npm run memdb -- selftest`.

### Add an engine
Add a branch in `wakeOnce()` in `bin/waker.js`, add the engine name to the list of accepted engines at the bottom of `bin/waker.js` (and to `needsSession` if it resumes a session), and, if it needs a session, a case in `createSession()` in `src/assistants.js`. Also decide whether `wake()` may retry it. Decide explicitly what it may do; default to read-only.

### Change the translator's provider
`config.translator = { baseUrl, model, secret }` — any OpenAI-compatible endpoint with `json_schema` responses, tools and image input.

## Testing locally without touching your real setup

Set fake keys first so nothing asks for Keychain access: `export BATLINK_SECRET_XAI=test BATLINK_SECRET_OPENAI=test BATLINK_SECRET_MINIMAX=test`.

```bash
T=$(mktemp -d); cp config.example.json $T/config.json
# edit $T/config.json: owner.address, dataDir → "$T/data", httpPort → 18799
AGENTS_CONFIG=$T/config.json node bin/setup.js --only qingyue --no-service --yes
AGENTS_CONFIG=$T/config.json npm run memdb -- selftest
AGENTS_CONFIG=$T/config.json node src/daemon.js        # creates NEW bot accounts from a new seed in $T/data
```
Note the last step creates real Batlink accounts and sends hellos to `owner.address`.
