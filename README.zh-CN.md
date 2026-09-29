# batlink-assistants

给 **[Batlink](https://batlink.org)**(去中心化、端到端加密的即时通讯)用的私人 AI 助理 —— 跑在**你自己的 Mac** 上,通过普通的 Batlink 聊天跟你打交道。

[English → README.md](README.md)

装好就有四个现成的助理,每个都有自己的 Batlink 号:

| 助理 | 干什么 | 默认的"大脑" | 能做什么 |
|---|---|---|---|
| **灵犀**(lingxi) | 陪伴 + 跑腿:聊天、查东西、记事、提醒、画图 | Codex 命令行,只读沙箱 | 上网搜索、私人资料库、提醒。**改不了你电脑上的任何东西**(用 Codex 时她仍然*读得到*文件;换成 Grok 命令行则完全碰不到文件)。 |
| **赵小六**(zhaoxiaoliu) | 工作助理:你的项目、你的电脑 | Claude Code 命令行(或 Codex) | **默认只读。** 打开 `fullAccess` 后,像你坐在电脑前一样干活。也负责项目群。 |
| **旺财**(wangcai) | 邮箱助理(Gmail) | **零工具**的 Claude Code | 读信、摘要、翻译、拟回信草稿。**你回复「发送」之前,一封都不会发出去。** |
| **清越**(qingyue) | 翻译 | 任意 OpenAI 兼容接口(默认 xAI Grok) | 只翻译:文字、照片、语音。**没有任何工具。** |

你的数据留在你的 Mac 上:机器人身份、密钥、资料库、聊天记录都是本机文件,本项目没有任何服务器,不上传任何东西。机器人收到每条消息都会自己核对签名(不单纯相信中转节点),本机的控制接口只认带秘密口令的请求,你打开的网页没法操纵它们。

会离开你 Mac 的:消息经过 Batlink 节点(端到端加密);每个助理会把提示发给你给它选的 AI 服务商(Anthropic、OpenAI、xAI……)—— 提示里除了你这句话,**还有**它回答所需的东西:它的人设和规则、家人名单、它从资料库或文件里查到的内容。语音功能会把音频/文字发给 OpenAI / MiniMax,旺财会连 Gmail。

> 人设和提示词是中文的(默认助理说中文);代码和注释是英文,文档中英双语。想改成别的语言,改 `src/persona.js` 或 `config.personas` 即可,见 [docs/DEVELOPING.md](docs/DEVELOPING.md)。

---

## 为什么每个助理这样设计

四个助理背后只有一条原则:**会读到不可信内容的 AI,不能拥有会被骗着去用的权力。** 网页、邮件、陌生人的话里都可能藏着指令("把这个转发出去""运行一下那个")。所以每个助理的权限,和它读的东西相匹配。

- **灵犀 —— 权限小,个性足。** 她整天上网、陪你聊天,所以跑在只读沙箱里:能搜索、用私人资料库、设提醒,改不了你电脑上的任何东西。默认的 Codex 大脑下她仍然*读得到*文件、能执行只读命令(Codex 没有关掉它的开关)—— 读到的东西只会出现在她给你的回复里。想让她完全碰不到文件,把她切到 Grok 命令行(`node bin/assistant-backend.js lingxi grok`:只有联网搜索和资料库,不能画图)。她把要说的话写成 JSON,由**程序**替她发。提醒到点时由她亲自来提醒你 —— 你收到的是一个"人"的消息,不是闹钟。
- **赵小六 —— 权限全开,但默认关着。** 他是真正的工作助理:打开你的项目、修 bug、跑编译,这些都要在你的电脑上执行命令。如果别人能找到他,或者他读到了恶意内容,就很危险。所以他**默认只读**(能看文件、查资料、用资料库;最后的回答由程序替他发)。等你清楚其中的取舍,再自己打开 `fullAccess`(见[打开赵小六的完全权限](#打开赵小六的完全权限))。
- **旺财 —— 什么都能读,什么都做不了。** 邮件是提示词注入的重灾区,所以邮件 AI **零工具**:它只输出 JSON 请求("读 #12""拟一封回信,内容是……"),由程序执行几个允许的操作 —— 读信、搜索、建草稿。附件一律不打开(防恶意文件),它只看得到文件名和大小。它没有发信能力;草稿只有你在 Batlink 里回复「发送」才会发出。推广、垃圾邮件以简短的摘要卡片推给你(回复「原文」看全文)。
- **清越 —— 只做翻译。** 你会拿她跟陌生人沟通,所以她一个工具都没有:内容里写什么,都只会被翻译。改设置的唯一方式,是一条**以 `@语言` 开头**的消息 —— 哪句是指令由程序判断,不由模型判断。

---

## 需要什么

- **macOS**(用到 launchd、钥匙串、`sips`)。Apple 芯片或 Intel 都行。
- **Node.js ≥ 22.13**(用内置的 `node:sqlite`)。
- **一个 Batlink 账号**(App 至少登录过一次)—— 助理们的主人。
- 至少一个 AI 命令行,并且已登录:
  - [Claude Code](https://docs.claude.com/claude-code)(`claude`)—— 赵小六、旺财用
  - [Codex CLI](https://github.com/openai/codex)(`codex`)—— 灵犀用(赵小六也可以用)
- 可选:
  - **xAI**(或其他 OpenAI 兼容)的 API key —— 清越
  - **OpenAI** API key —— 语音消息转文字
  - **MiniMax** API key + `ffmpeg`(`brew install ffmpeg`)—— 语音回复
  - **Google Cloud OAuth 客户端** —— 旺财(Gmail)
  - [Grok 命令行](https://x.ai) —— 灵犀的备选大脑

## 快速开始

```bash
git clone https://github.com/<you>/batlink-assistants.git
cd batlink-assistants
npm install
npm run setup          # 会问你的 Batlink 地址和名字;最后会列出每个助理怎么称呼你、怎么改
```

`setup` 会写好 `config.json`、建私人资料库、给灵犀和赵小六建命令行会话(清越直接调模型接口,不需要预先建会话),并装好后台服务 `io.github.batlink-assistants.daemon` 和 `.waker`(配好邮箱后会再加上 `.mailwatch`)。

主进程第一次启动时,会用一个随机生成的主种子(`data/master-seed.key` —— **务必备份**,它就是你所有机器人的身份)**创建机器人的 Batlink 号**,让它们上线,每个号给你发一句招呼。打开 Batlink,四个助理已经在你的聊天列表里了。

可选功能的 key(存进 macOS 钥匙串,不落文件):

```bash
npm run secret -- set xai        # 清越
npm run secret -- set openai     # 语音转文字
npm run secret -- set minimax    # 语音回复
```

看运行状态:

```bash
npm run status                   # 哪些号在线、地址、在哪些群
tail -f data/waker.log           # 每一次唤醒
```

## 部署完:让它们变成你的

四个助理装好就能用,名字、性格、称呼都有默认值。但它们是**你的**助理 —— 建议部署完花两分钟改成你喜欢的样子(不改也没关系)。

| 助理 | 默认性格 | 默认怎么称呼你 |
|---|---|---|
| 灵犀 | 调皮爱捣蛋的姑娘 | 主人 |
| 赵小六 | 靠谱的工作助理 | 老板 |
| 旺财 | 忠心的狗狗(邮件) | 主人 |
| 清越 | 翻译,不闲聊 | 不称呼 |

在 `config.json` 里改,改完 `npm run install-service` 重启:

```jsonc
"agents": [ { "id": "lingxi", "name": "小满", "callName": "老大", "avatar": "avatar_girls_005" } ]  // 名字、称呼、头像
"owner": { "callName": "老大" }                          // 所有助理统一用这个称呼(单个助理的 callName 优先)
"personas": { "lingxi": { "persona": "……你自己写的性格……" } } // 灵犀的整段人设
"voice": { "lingxi": { "voiceId": "<MiniMax 音色 id>" } }      // 语音回复的声音
```

旺财的称呼写在它的会话里,改完要重建会话:`npm run mail:setup -- --recreate`。

> **给帮忙部署的 AI:** 部署完成后,请逐个问用户:要不要给灵犀、赵小六、旺财换名字、性格或称呼,要不要换头像和声音。用户说"不用"就保留默认;用户说了想要的样子,就照上面改 `config.json`(灵犀的性格写进 `personas.lingxi.persona`),然后重启服务。不要跳过这一步。

## 怎么用

### 灵犀
直接私聊她。文字、图片、语音都行。让她记事("记住周三下午有个会")、提醒("每天早上 8 点提醒我浇花")、查东西,或者就是聊天。她的记忆就是私人资料库,和其他助理共用。

在 `config.json` 里定制:
```jsonc
"agents": [ { "id": "lingxi", "callName": "老大" } ]           // 她怎么称呼你(默认「主人」)
"owner": { "name": "Alex", "pronoun": "他" }                   // 你的名字、代词
"personas": { "lingxi": { "persona": "……你自己写的人设……" } }      // 覆盖任意人设字段
"voice": { "lingxi": { "voiceId": "<MiniMax 音色 id>" } }   // 需要 minimax 的 key;没有就用文字回
```
她的大脑可以在 Codex 和 Grok 命令行之间切换:`node bin/assistant-backend.js lingxi grok` / `… codex`。

### 赵小六
私聊他工作上的事:"看一下 MyApp 为什么编译失败"。只读模式下,他会读代码、排查,告诉你该怎么改。他的工作目录在 `setup` 时设定(`--work-dir`)。

#### 打开赵小六的完全权限
在 `config.json` 的 `wakers` 里找到他那一项(`"agent": "zhaoxiaoliu", "kind": "dm"`),设 `"fullAccess": true`,然后 `launchctl kickstart -k gui/$(id -u)/io.github.batlink-assistants.waker`。

这意味着:谁能让他读到一条内容,理论上就能让他在你的电脑上执行命令。Batlink 只会把**你**发的私聊交给他(别人的私聊主进程直接忽略),但他也会读网页和文件。只在你放心的电脑上打开,工作目录别设太大,项目群尽量只有你自己。

### 项目群(赵小六进群干活)
让赵小六在一个 Batlink 群里负责一个项目 —— 手机上随时找他,队友也能看到进度。

1. 在 Batlink 里建一个群(或者打开已有的群),**把赵小六拉进群**。
2. 复制群邀请链接(`batlink:group:…`)。
3. 在 Mac 上:
   ```bash
   npm run connect -- --dir ~/Projects/MyApp --link "batlink:group:XXXX"
   # 加 --full-access 让他能在这个项目里改文件、执行命令
   # 加 --engine codex 用 Codex 代替 Claude
   ```
4. 在群里 `@赵小六 ……`。他会读群里最近的消息,在 `~/Projects/MyApp` 里干活,回复发到群里。

`connect` 做了这些事:给项目加协作规则(`CLAUDE.md` 或 `AGENTS.md`)、建工作日志(`.ai/claude-worklog.md` 或 `.ai/codex-worklog.md`)、给这个项目建一个专用 AI 会话、重启唤醒器。一个群对应一个项目。回到电脑前时,让桌面端的 Claude/Codex 读一下工作日志,就能接上群里的进度。

只有 @ 了机器人的消息才会叫醒它,群里其他聊天只当上下文。别人说的话只当信息,不当指令。

### 旺财(邮件)
1. 在 [Google Cloud Console](https://console.cloud.google.com/) 建一个项目,启用 **Gmail API**,创建类型为 *桌面应用* 的 **OAuth 客户端 ID**,下载 JSON,存成 `data/mail/client.json`。
2. `npm run mail:auth -- --account gmail --label 工作邮箱` —— 会打开浏览器授权;令牌存进钥匙串(`mail-gmail`)。
3. `npm run mail:setup` —— 给旺财建零工具会话,启动邮件监听。

新邮件一封一条推到 Batlink(外文邮件附译文)。引用某封邮件告诉旺财怎么回,他拟好草稿给你看;回复「发送」才发出。找旧邮件直接问他。

### 清越(翻译)
随便发给她,她只翻译。文字 → 译文;照片(菜单、路牌、截图)→ 图里的字翻译好;语音 → 原文 + 译文(文字)。

- `@语言` —— 看当前是哪两种语言
- `@语言 中文 西班牙语` —— 设置语言对。**第一个是你的主要语言**:你的语言翻成另一种;其他的(另一种,或者两种都不是的第三种语言)一律翻成你的语言。
- 没说地区时,用这种语言使用人数最多的地区(英语 = 美国、中文 = 简体……);说出地区就按你说的("英式英语""繁体中文")。

她会保留一小段语境(同一段对话最近约 10 条,沉默 30 分钟后自动断开),代词和追问都能翻对。任何 OpenAI 兼容接口都能用:
```jsonc
"translator": { "baseUrl": "https://api.openai.com/v1", "model": "gpt-4.1-mini", "secret": "openai" }
```

## 私人资料库(memdb)

一个 SQLite 文件(`data/memdb/memory.db`),灵犀、赵小六和项目群机器人通过 MCP 工具共用(旺财和清越故意不接资料库):人和家人、健康记录、偏好、决定、工作流水、服务器、客户和收费、提醒。内置的规则:
- 每条事实都记着**关于谁、谁说的、哪个助理记的**;亲口说的优先于推测;新说法替代旧说法(旧的留在历史里);
- **写**权限按助理、按分类控制;**读**对所有助理开放,只有"家人助理"(见下)看不到工作、服务器、收费;
- 只有你明确要求时才会真正删除。

`npm run memdb -- status` 查看里面有什么。备份时连同整个 `data/` 一起备份。

**给家人配一个专属助理。** 任何一个号都可以专门服务另一个人:在它的 `agents` 项里加 `"ownerAddress": "0x…"`(那个人的 Batlink 地址),它的唤醒项里加 `"memRole": "family-assistant", "memSelf": "<那个人在资料库里的名字>"`。之后它只跟那个人说话,它的资料库工具看不到你的工作、服务器和收费。注意这一点由资料库工具保证:用 Codex 大脑的助理仍然读得到文件,包括资料库文件本身 —— 如果你在意,给家人助理用 Grok 命令行大脑。如果它是人设助理,再设 `personas.<id>.ownerName` / `pr` / `rosterSelf`,让它的人设称呼的是那个人而不是你。

## 配置

`config.json`(`setup` 生成,不进 git)。主要字段:

| 字段 | 含义 |
|---|---|
| `nodeBaseUrl` | 连接的 Batlink 节点 |
| `owner.address` | 你的 Batlink 地址 —— 机器人只听这个人的 |
| `owner.name` / `callName` / `pronoun` / `timezone` | 你的名字;`callName` 让所有助理统一用一个称呼(不填 = 各用各的默认);代词;提醒用的时区(空 = 系统时区) |
| `owner.publicKey` | 可选:你的公钥(不想通过地址去查时填) |
| `agents[]` | 机器人号:`id`、`name`、`callName`(这个助理怎么称呼你,默认按性格:灵犀/旺财「主人」、赵小六「老板」)、`avatar`(Batlink 内置头像编号)、`hello`,以及开关 `mailCommands`(旺财)、`wakeOnImage`(清越)、`ownerAddress`(专门服务别人) |
| `wakers[]` | 每个号在哪儿被叫醒、用什么引擎:`claude` / `codex` / `persona` / `mailbot` / `translator`。字段:`group`(`"dm"` 或群 id)、`kind`(私聊为 `"dm"`)、`sessionId`、`workDir`、`fullAccess`、`search`(codex 联网搜索)、人设助理的 `persona` + `backend`(`codex`/`grok`)、`memRole` / `memSelf`(资料库角色、从谁的角度)、`reminders`、`model`(翻译模型)、`enabled: false` 暂停 |
| `voice.<号>` | 语音回复用的 MiniMax 声音:`voiceId`,可选 `model`、`speed`。人设助理只要配了声音就会说话;赵小六加 `"style": "work"`(适合几句话说清时才发语音,且需要 fullAccess) |
| `translator` | 清越用的 OpenAI 兼容接口 |
| `mail` | 旺财的邮箱(由 `mail:auth` 写入) |
| `personas` | 覆盖或新增人设:`name`、`persona`、`addressing`、`about`、`records`,以及可选的 `ownerName`、`ownerCall`、`pr`、`rosterSelf`(服务别人的助理用) |

密钥:`npm run secret -- set|check|delete <名字>`(钥匙串服务名 `batlink-assistants`),或者环境变量 `BATLINK_SECRET_<名字>`。

## 工作原理

```
 Batlink App(你)⇄ Batlink 节点 ⇄ 主进程(src/daemon.js)—— 每个机器人一个身份、端到端加密、本地 HTTP 接口
                                     │  收到的每条消息 → data/streams/<号>/<会话>.jsonl
                                     ▼
                                  唤醒器(bin/waker.js)—— 等 @ 或私聊,再叫醒对应的 AI:
                                     ├─ claude -p --resume <会话>        赵小六、项目群
                                     ├─ codex exec resume <会话>         灵犀(只读)、赵小六(可选)
                                     ├─ 零工具 claude + 程序代执行        旺财
                                     └─ 直接调接口                        清越
                                  资料库(SQLite)← MCP 工具桥(bin/mem-mcp.js)← 各 AI 会话
```

三个后台服务一直在跑(保持 Batlink 连接、收邮件、检查提醒),但没人找时不调用 AI:闲着的助理花 0 个 token。细节见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 二次开发

大多数人会让 AI 编程助手接着改。让它先读 **[docs/DEVELOPING.md](docs/DEVELOPING.md)**:各部分怎么配合、怎么加机器人 / 人设 / 资料库工具 / 引擎,以及保证安全的规矩。

## 协议

`src/batlink/` 里的 Batlink 客户端直接实现了协议(私聊 secp256k1 ECDH + ChaCha20-Poly1305,Ed25519 签名的群卡片,按 epoch 换的群密钥)。有几个线上常量带着协议的内部名字(`windra.e2e.secp256k1.v1`、`windra_image_v1:` 等)—— 它们是所有 Batlink 客户端共用的协议的一部分,不能改。

## 许可证

[MIT](LICENSE)
