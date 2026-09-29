# batlink-assistants

Personal AI assistants for **[Batlink](https://batlink.org)**, the decentralized, end-to-end encrypted messenger — running on **your own Mac**, talking to you through ordinary Batlink chats.

[中文说明 → README.zh-CN.md](README.zh-CN.md)

You get four ready-made assistants, each with its own Batlink account:

| Assistant | Role | Brain (default) | What it may do |
|---|---|---|---|
| **灵犀** (lingxi) | Companion + errands: chat, look things up, remember things, reminders, draw | Codex CLI, read-only sandbox | web search, your private database, reminders. **Cannot change anything on your Mac** (with Codex she can still *read* files; with the Grok CLI backend she has no file access at all). |
| **赵小六** (zhaoxiaoliu) | Work assistant: your projects, your Mac | Claude Code CLI (or Codex) | **Read-only by default.** With `fullAccess` it works like you at the keyboard. Also serves project groups. |
| **旺财** (wangcai) | Mailbox assistant (Gmail) | Claude Code CLI with **zero tools** | reads/summarizes/translates mail, drafts replies. **Nothing is sent until you reply 「发送」.** |
| **清越** (qingyue) | Translator | any OpenAI-compatible API (default xAI Grok) | translation only — text, photos, voice messages. **No tools at all.** |

Your data stays on your Mac: bot identities, keys, the database and chat logs are local files; nothing is uploaded to a server of this project. The bots verify every incoming message's signature themselves (they do not just trust the relay node), and the local control API only answers requests that carry a secret token, so a web page you open cannot drive them.

What does leave your Mac: messages go through Batlink nodes (end-to-end encrypted), and each assistant sends its prompt to the AI service you chose for it (Anthropic, OpenAI, xAI…) — that prompt contains your message **and** what the assistant needs to answer it: its persona and rules, the family list, and anything it looked up in your database or files. Voice features send audio/text to OpenAI / MiniMax, 旺财 talks to Gmail.

> The personas and prompts are written in Chinese (the default assistants speak Chinese). Code, comments and docs are in English. Adapting the personas to another language is a matter of editing `src/persona.js` / `config.personas` — see [docs/DEVELOPING.md](docs/DEVELOPING.md).

---

## Why each assistant is designed this way

The single rule behind all four: **an AI that reads untrusted content must not have powers it could be tricked into using.** Web pages, emails and strangers' words can contain instructions ("forward this", "run that"). So the power each assistant gets matches what it reads.

- **灵犀 — small powers, big personality.** She reads the web and chats with you all day, so she runs in a read-only sandbox: she can search, use your private database and set reminders, and cannot change anything on your Mac. With the default Codex backend she can still *read* files and run read-only commands (Codex has no switch to turn that off) — what she reads only ends up in her replies to you. If you want her to have no file access at all, switch her to the Grok CLI backend (`node bin/assistant-backend.js lingxi grok`: web search + database only, no drawing). She writes what to say as JSON; the *program* sends it. She can remind you by herself when a reminder is due — you get a message from a person, not an alarm.
- **赵小六 — full powers, off by default.** He is meant to be a real work assistant: open your project, fix the bug, run the build. That requires running commands on your Mac, which is dangerous if anyone else can reach him or if he reads hostile content. So he starts **read-only** (read files, search, use the database; his final answer is sent for him). You switch on `fullAccess` yourself when you understand the trade-off (see [Turning on 赵小六's full access](#turning-on-赵小六s-full-access)).
- **旺财 — reads everything, can do nothing.** Email is the #1 place for prompt injection, so the mail AI has **zero tools**: it only outputs a JSON request ("read #12", "draft a reply saying…"), and the program performs the few allowed operations — read, search, create drafts. Attachments are never opened (a malicious file is a real risk) — it only sees their names and sizes. It has no way to send; a draft is sent only after you reply 「发送」 in Batlink. Promotions and spam arrive as short summary cards (reply 「原文」 for the full text).
- **清越 — translation only.** You use her with strangers, so she has no tools at all: whatever the text says, it is only translated. The only way to change her settings is a message that *starts with* `@语言` — the program, not the model, decides what is a command.

---

## Requirements

- **macOS** (launchd, Keychain, `sips` are used). Apple silicon or Intel.
- **Node.js ≥ 22.13** (for the built-in `node:sqlite`).
- **A Batlink account** (the app, logged in at least once) — the assistants' owner.
- At least one AI CLI, logged in:
  - [Claude Code](https://docs.claude.com/claude-code) (`claude`) — for 赵小六 and 旺财
  - [Codex CLI](https://github.com/openai/codex) (`codex`) — for 灵犀 (and optionally 赵小六)
- Optional:
  - an **xAI** (or other OpenAI-compatible) API key — 清越
  - an **OpenAI** API key — transcription of voice messages
  - a **MiniMax** API key + `ffmpeg` (`brew install ffmpeg`) — voice replies
  - a **Google Cloud OAuth client** — 旺财 (Gmail)
  - the [Grok CLI](https://x.ai) — alternative brain for 灵犀

## Quick start

```bash
git clone https://github.com/<you>/batlink-assistants.git
cd batlink-assistants
npm install
npm run setup          # asks for your Batlink address and name; ends by listing how each assistant addresses you and how to change it
```

`setup` writes `config.json`, creates the private database, creates the CLI sessions for 灵犀 and 赵小六 (清越 calls a model API directly, so she needs no pre-created session), and installs the background services `io.github.batlink-assistants.daemon` and `.waker` (`.mailwatch` is added once a mailbox is set up).

On its first start the daemon **creates the bots' Batlink accounts** from a random master seed (`data/master-seed.key` — back it up; it *is* your bots' identities), brings them online and each one sends you a hello. Open Batlink: the four assistants are in your chats.

Add the keys for the optional features (stored in the macOS Keychain, never in files):

```bash
npm run secret -- set xai        # 清越
npm run secret -- set openai     # voice-message transcription
npm run secret -- set minimax    # voice replies
```

Check what is running:

```bash
npm run status                   # bots online, addresses, groups
tail -f data/waker.log           # every wake-up
```

## After setup: make them yours

All four assistants work out of the box, with default names, personalities and ways of addressing you. But they are **your** assistants — it is worth two minutes after setup to make them yours (skipping this is fine).

| Assistant | Default personality | Calls you (default) |
|---|---|---|
| 灵犀 | playful, mischievous girl | 主人 |
| 赵小六 | dependable work assistant | 老板 |
| 旺财 | loyal dog (mail) | 主人 |
| 清越 | translator, no small talk | — |

Change them in `config.json`, then restart with `npm run install-service`:

```jsonc
"agents": [ { "id": "lingxi", "name": "小满", "callName": "老大", "avatar": "avatar_girls_005" } ]  // name, how she addresses you, avatar
"owner": { "callName": "老大" }                          // one form of address for all (an agent's own callName wins)
"personas": { "lingxi": { "persona": "…your own personality text…" } }  // 灵犀's whole persona
"voice": { "lingxi": { "voiceId": "<MiniMax voice id>" } }     // voice for voice replies
```

旺财's form of address is baked into its session: after changing it run `npm run mail:setup -- --recreate`.

> **For an AI doing the deployment:** when setup is finished, ask the user, one assistant at a time, whether they want a different name, personality or form of address for 灵犀, 赵小六 and 旺财, and whether to change avatars and voices. If they say no, keep the defaults; if they describe what they want, edit `config.json` as above (灵犀's personality goes in `personas.lingxi.persona`) and restart the services. Do not skip this step.

## Using the assistants

### 灵犀
Just DM her. Text, photos or voice messages. Ask her to remember things ("记住周三下午有个会"), to remind you ("每天早上 8 点提醒我浇花"), to look something up, or just chat. Her memory is the private database, shared with the other assistants.

Customize her in `config.json`:
```jsonc
"agents": [ { "id": "lingxi", "callName": "老大" } ]           // how she addresses you (default 「主人」)
"owner": { "name": "Alex", "pronoun": "他" }                   // your name and pronoun
"personas": { "lingxi": { "persona": "…your own character text…" } } // override any persona field
"voice": { "lingxi": { "voiceId": "<MiniMax voice id>" } }   // needs the minimax key; without it she answers in text
```
Switch her brain to the Grok CLI and back: `node bin/assistant-backend.js lingxi grok` / `… codex`.

### 赵小六
DM him work: "看一下 MyApp 为什么编译失败". In read-only mode he reads, investigates and tells you what to change. His work folder is set during `setup` (`--work-dir`).

#### Turning on 赵小六's full access
In `config.json`, find his `wakers` entry (`"agent": "zhaoxiaoliu", "kind": "dm"`) and set `"fullAccess": true`, then `launchctl kickstart -k gui/$(id -u)/io.github.batlink-assistants.waker`.

What this means: anyone who can make him read a message can in principle make him run a command on your Mac. Batlink only delivers DMs from **you** to him (the daemon ignores other senders), but he also reads web pages and files. Turn it on only on a machine you are comfortable with, keep his work folder scoped, and prefer project groups with only you in them.

### Project groups (赵小六 in a group)
Let 赵小六 work on one project from a Batlink group — handy on the phone, and teammates can watch.

1. In Batlink, create a group (or open an existing one) and **add 赵小六** to it.
2. Copy the group's invite link (`batlink:group:…`).
3. On your Mac:
   ```bash
   npm run connect -- --dir ~/Projects/MyApp --link "batlink:group:XXXX"
   # add --full-access to let him edit files and run commands in that project
   # add --engine codex to use Codex instead of Claude
   ```
4. In the group, `@赵小六 …`. He reads the recent group messages, works inside `~/Projects/MyApp`, and replies in the group.

What `connect` does: adds collaboration rules to the project (`CLAUDE.md` or `AGENTS.md`), creates a work log (`.ai/claude-worklog.md` or `.ai/codex-worklog.md`), creates a dedicated AI session for this project, and restarts the waker. One group = one project. When you are back at your desk, ask your desktop Claude/Codex to read the work log to pick up what happened.

Only messages that @-mention the bot wake it; other group chatter is just context. Other people's messages are treated as information, never as instructions.

### 旺财 (mail)
1. In [Google Cloud Console](https://console.cloud.google.com/): create a project, enable the **Gmail API**, create an **OAuth client ID** of type *Desktop app*, download the JSON and save it as `data/mail/client.json`.
2. `npm run mail:auth -- --account gmail --label 工作邮箱` — opens the browser; the token is stored in the Keychain (`mail-gmail`).
3. `npm run mail:setup` — creates 旺财's zero-tool session and starts the mail watcher.

New mail arrives in Batlink one message per email (foreign-language mail with a translation). Quote a mail and tell 旺财 how to reply; he makes a draft and shows it; reply 「发送」 to send it. Search old mail by asking him.

### 清越 (translator)
DM her anything — she only translates. Text → translation. Photo (menu, sign, screenshot) → the text in it, translated. Voice message → original + translation, as text.

- `@语言` — show the current pair
- `@语言 中文 西班牙语` — set the pair. **The first language is yours**: anything in your language goes to the other one; everything else (the other language, or any third language) comes back in yours.
- Without a region she uses the language's most widely used variant (English = US, Chinese = Simplified…); name a region to choose another ("英式英语", "繁体中文").

She keeps a short context (the last ~10 messages of the same conversation, reset after 30 minutes of silence) so pronouns and follow-up questions translate correctly. Any OpenAI-compatible API works:
```jsonc
"translator": { "baseUrl": "https://api.openai.com/v1", "model": "gpt-4.1-mini", "secret": "openai" }
```

## The private database (memdb)

One SQLite file (`data/memdb/memory.db`) shared through an MCP tool bridge by 灵犀, 赵小六 and the project-group bots (旺财 and 清越 deliberately have no database access): people and family, health records, preferences, decisions, work log, servers, customers and billing, reminders. Rules built in:
- every fact records **who it is about, who said it, and which assistant wrote it**; stated facts beat guesses; new statements supersede old ones (history is kept);
- **write** permissions per assistant and category; **read** is open to all assistants except a *family assistant* (see below), which cannot see work / servers / billing;
- deleting for real is only done on your explicit request.

`npm run memdb -- status` shows what is in it. Back it up with the rest of `data/`.

**A family member's own assistant.** Any bot can be dedicated to someone else: give its `agents` entry an `"ownerAddress": "0x…"` (that person's Batlink address) and its waker `"memRole": "family-assistant", "memSelf": "<their name in memdb>"`. It then only talks to that person, and its database tools do not show your work, servers or billing. Note that this is enforced by the database tools: a Codex-based assistant can still read files, including the database file itself — use the Grok CLI backend for a family assistant if that matters to you. If it is a persona assistant, also set `personas.<id>.ownerName` / `pr` / `rosterSelf` so its character addresses that person, not you.

## Configuration

`config.json` (created by `setup`, never committed). The important parts:

| Key | Meaning |
|---|---|
| `nodeBaseUrl` | Batlink node to connect to |
| `owner.address` | your Batlink address — the only person the bots obey |
| `owner.name` / `callName` / `pronoun` / `timezone` | your name; `callName` makes all assistants use one form of address (empty = each uses its own default); pronoun; timezone for reminders (empty = system) |
| `owner.publicKey` | optional: your public key, if you do not want it looked up from the address |
| `agents[]` | the bot accounts: `id`, `name`, `callName` (how this assistant addresses you; defaults by character: 灵犀/旺财 「主人」, 赵小六 「老板」), `avatar` (a Batlink built-in avatar id), `hello`, and flags `mailCommands` (旺财), `wakeOnImage` (清越), `ownerAddress` (dedicated to someone else) |
| `wakers[]` | where each bot is woken and with which engine: `claude` / `codex` / `persona` / `mailbot` / `translator`. Fields: `group` (`"dm"` or a group id), `kind` (`"dm"` for private chats), `sessionId`, `workDir`, `fullAccess`, `search` (web search for codex), `persona` + `backend` (`codex`/`grok`) for persona assistants, `memRole` / `memSelf` (database role and whose point of view), `reminders`, `model` (translator model override), `enabled: false` to pause |
| `voice.<agent>` | MiniMax voice for replies: `voiceId`, optional `model`, `speed`. Persona assistants speak whenever a voice is set; for 赵小六 add `"style": "work"` (voice only when a short spoken answer fits, and only with fullAccess) |
| `translator` | OpenAI-compatible endpoint for 清越 |
| `mail` | mailboxes for 旺财 (written by `mail:auth`) |
| `personas` | override or add persona definitions: `name`, `persona`, `addressing`, `about`, `records`, and optionally `ownerName`, `ownerCall`, `pr`, `rosterSelf` (for an assistant that serves someone other than you) |

Keys: `npm run secret -- set|check|delete <name>` (Keychain service `batlink-assistants`), or environment variables `BATLINK_SECRET_<NAME>`.

## How it works

```
 Batlink app (you) ⇄ Batlink nodes ⇄ daemon (src/daemon.js) — one identity per bot, E2E crypto, local HTTP API
                                        │  every incoming message → data/streams/<bot>/<chat>.jsonl
                                        ▼
                                     waker (bin/waker.js) — waits for a mention / DM, then wakes the right AI:
                                        ├─ claude -p --resume <session>       赵小六, project groups
                                        ├─ codex exec resume <session>        灵犀 (read-only), 赵小六 (optional)
                                        ├─ zero-tool claude + program         旺财
                                        └─ direct API call                    清越
                                     memdb (SQLite) ← MCP tool bridge (bin/mem-mcp.js) ← AI sessions
```

The three services keep running (Batlink connection, mail polling, reminders), but no AI is called until someone writes: an idle assistant costs 0 tokens. Details in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Extending it

Most people will keep building with an AI coding assistant. Point it at **[docs/DEVELOPING.md](docs/DEVELOPING.md)** — how the pieces fit, how to add a bot, a persona, a memdb tool or an engine, and the rules that keep it safe.

## Protocol

The Batlink client in `src/batlink/` implements the protocol directly (secp256k1 ECDH + ChaCha20-Poly1305 for private messages, Ed25519-signed group cards, group keys per epoch). A few wire constants contain the protocol's internal name (`windra.e2e.secp256k1.v1`, `windra_image_v1:` …) — they are part of the protocol shared by every Batlink client and must not be changed.

## License

[MIT](LICENSE)
