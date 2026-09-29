// Memory tool definitions: the MCP bridge (bin/mem-mcp.js) uses them to tell the AI which tools exist,
// and the main process (src/memdb/service.js) executes them by name.
// Tools with write: true go through the write-permission check.
// Descriptions are prompts for the AI and are therefore written in Chinese.

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const num = (description) => ({ type: 'number', description });
const SCOPE = str('分类:work 工作 / life 生活 / personal 个人 / family 家庭 / health 健康 / infra 服务器与服务 / finance 客户与收费',
  { enum: ['work', 'life', 'personal', 'family', 'health', 'infra', 'finance'] });
const ORIGIN = str('来源:stated=机主(或机主的家人)亲口说的;evidence=有执行证据(命令输出、编译结果等);inferred=你自己推测的。推测的会标成待核实,也不能推翻机主说过的话',
  { enum: ['stated', 'evidence', 'inferred'] });
const SAID_BY = str('是谁说的:owner=机主本人,family=机主的家人;不是他们亲口说的就不填', { enum: ['owner', 'family'] });
const SOURCE_REF = str('出处:消息 id、会话 id 等,能填就填(同一出处重复写入只算一次)');
const DATE = (what) => str(`${what},格式 YYYY-MM-DD`);
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

export const TOOLS = [
  // ── Queries ──
  {
    name: 'mem_search',
    description: '在资料库里全文搜索(人、项目、事实偏好、工作流水、用药、检查、服务器、客户、收费都搜)。关键词三个字以上最准。',
    input: obj({ query: str('关键词'), scope: SCOPE, limit: num('最多返回几条,默认 20') }, ['query'])
  },
  {
    name: 'mem_get',
    description: '查某个人或某样东西的全部资料:基本信息、当前有效的事实和偏好、相关的人和物、最近的记录。不填 name 就是你的主人本人。',
    input: obj({ name: str('名字、外号或 id,比如 "机主"、某个家人的名字、某个项目名、"web-01"') })
  },
  {
    name: 'mem_recent',
    description: '最近的工作流水(改了什么、部署了什么、做了什么决定)。回答"最近在忙什么"用这个。',
    input: obj({ project: str('只看某个项目,不填看全部'), days: num('最近几天,默认 7'), limit: num('最多几条,默认 30') })
  },
  {
    name: 'mem_health',
    description: '健康资料:当前在吃的药、最近的检查报告;填 item 就看某个检查指标的历次数值和趋势。',
    input: obj({ person: str('谁的,默认你的主人本人'), item: str('检查指标名,比如 "血红蛋白"') })
  },
  {
    name: 'mem_servers',
    description: '服务器列表:IP、配置、用途、到期日、给哪个客户用。可以按条件筛。',
    input: obj({ expiring_within_days: num('只看多少天内到期的'), customer: str('只看某个客户的'), query: str('按 IP、用途、服务商筛') })
  },
  {
    name: 'mem_billing',
    description: '客户收费:每个客户多少钱、多久收一次、下次什么时候该付。',
    input: obj({ due_within_days: num('只看多少天内该付的'), customer: str('只看某个客户') })
  },
  {
    name: 'mem_history',
    description: '看某条记录以前的样子(改过、删过的旧版本)。',
    input: obj({ table: str('表名,比如 facts / medications / servers'), id: str('记录 id') }, ['table', 'id'])
  },

  // ── Writes ──
  {
    name: 'mem_remember',
    write: true,
    description: '记一条事实、偏好、习惯或决定。同一个人/物的同一项(property)有新说法时,自动替代旧的(旧的留在历史里)。',
    input: obj({
      about: str('关于谁或什么(名字/外号/id),默认你的主人本人'),
      category: str('类别:preference 偏好 / habit 习惯 / profile 基本资料 / decision 决定 / status 状态 / date 重要日子 / other'),
      property: str('哪一项,比如 "生日"、"回复语言"、"咖啡"'),
      value: str('内容'),
      scope: SCOPE,
      valid_from: DATE('从什么时候起成立(不是今天记录的日期;不知道就不填)'),
      origin: ORIGIN,
      said_by: SAID_BY,
      source_ref: SOURCE_REF,
      note: str('备注')
    }, ['category', 'property', 'value', 'scope', 'origin'])
  },
  {
    name: 'mem_log',
    write: true,
    description: '记一条工作流水:改了什么、编译过没有、部署了没有、机主验收了没有(分开记,不要把"改了"写成"部署了");也可以记决定、问题、任务。',
    input: obj({
      kind: str('change 改动 / deploy 部署 / decision 决定 / task 任务 / issue 问题 / note 其他', { enum: ['change', 'deploy', 'decision', 'task', 'issue', 'note'] }),
      title: str('一句话标题'),
      body: str('详细内容:改了哪些文件、为什么、结果'),
      stage: str('进度:changed 已修改 / built 编译通过 / deployed 已部署 / installed 已安装 / accepted 机主验收 / open 未完成 / done 完成 / dropped 放弃',
        { enum: ['changed', 'built', 'deployed', 'installed', 'accepted', 'open', 'done', 'dropped'] }),
      project: str('哪个项目(项目群的机器人不用填,只能记自己的项目)'),
      scope: SCOPE,
      occurred_at: str('什么时候发生的,ISO 时间,默认现在'),
      said_by: SAID_BY,
      source_ref: SOURCE_REF
    }, ['kind', 'title'])
  },
  {
    name: 'mem_entity',
    write: true,
    description: '登记或修改一个人、项目、服务器、客户、组织等。填 id 是修改,不填是新建(同类型同名已存在时会直接返回已有的)。',
    input: obj({
      id: str('要修改的 id'),
      type: str('person / project / server / customer / org / account / place / other', { enum: ['person', 'project', 'server', 'customer', 'org', 'account', 'place', 'other'] }),
      name: str('正式名字'),
      aliases: { type: 'array', items: { type: 'string' }, description: '外号、昵称、别的叫法' },
      summary: str('一句话介绍'),
      scope: SCOPE,
      origin: ORIGIN,
      said_by: SAID_BY,
      note: str('备注')
    }, ['scope'])
  },
  {
    name: 'mem_relate',
    write: true,
    description: '登记关系,比如 机主 spouse 某人、机主 child 某人、某项目 uses 某服务器。',
    input: obj({
      from: str('谁(名字/id)'),
      type: str('关系:spouse 配偶 / child 子女 / parent 父母 / sibling 兄弟姐妹 / friend 朋友 / uses 使用 / owned_by 属于 / member_of 成员 / other'),
      to: str('和谁(名字/id)'),
      scope: SCOPE,
      valid_from: DATE('从什么时候开始'),
      origin: ORIGIN,
      said_by: SAID_BY,
      note: str('备注')
    }, ['from', 'type', 'to', 'scope', 'origin'])
  },
  {
    name: 'mem_medication',
    write: true,
    description: '用药:开始吃(start)、改剂量或用法(update)、停药(stop)。同名药在吃时 start 会当成 update。',
    input: obj({
      action: str('start / update / stop', { enum: ['start', 'update', 'stop'] }),
      name: str('药名'),
      person: str('谁吃的,默认你的主人本人'),
      dose: str('剂量,比如 10mg'),
      frequency: str('用法,比如 每天一次 睡前'),
      purpose: str('治什么'),
      prescriber: str('开药的医生或医院'),
      date: DATE('开始/改/停的日期,默认今天'),
      origin: ORIGIN,
      said_by: SAID_BY,
      note: str('备注')
    }, ['action', 'name'])
  },
  {
    name: 'mem_health_report',
    write: true,
    description: '登记一份检查报告,把指标一项一项记下来(方便以后看趋势)。原件是文件的,填 file_path。',
    input: obj({
      title: str('报告名,比如 "2026 年度体检"'),
      taken_on: DATE('检查日期'),
      person: str('谁的,默认你的主人本人'),
      kind: str('体检 / 化验 / 影像 / 门诊'),
      institution: str('医院或机构'),
      summary: str('结论摘要'),
      file_path: str('原件在本机的路径(图片或 PDF)'),
      results: {
        type: 'array',
        description: '指标',
        items: obj({
          item: str('指标名'), value: str('结果(数字或文字)'), unit: str('单位'),
          ref_low: num('参考下限'), ref_high: num('参考上限'), ref_text: str('参考范围原文'),
          flag: str('H 偏高 / L 偏低 / N 正常 / A 异常', { enum: ['H', 'L', 'N', 'A'] })
        }, ['item', 'value'])
      },
      origin: ORIGIN,
      said_by: SAID_BY,
      source_ref: SOURCE_REF
    }, ['title', 'taken_on'])
  },
  {
    name: 'mem_server',
    write: true,
    description: '登记或修改一台服务器(按名字找,没有就新建)。密码不要写进来:只填钥匙串里存它的名字(keychain_ref)。',
    input: obj({
      name: str('服务器名字,比如 web-01'),
      ip: str('IP'), provider: str('服务商'), region: str('机房/地区'),
      cpu: str('CPU'), memory_gb: num('内存 GB'), disk_gb: num('硬盘 GB'), bandwidth: str('带宽/流量'), os: str('系统'),
      purpose: str('干什么用的'),
      expires_on: DATE('到期日'), renew_price: num('续费价格'), currency: str('币种,比如 USD'), auto_renew: { type: 'boolean', description: '是否自动续费' },
      customer: str('给哪个客户用(客户名);自用不填'),
      keychain_ref: str('root 密码在钥匙串里的 service 名(只记名字)'),
      username: str('登录用户名,默认 root'),
      status: str('active / expired / cancelled', { enum: ['active', 'expired', 'cancelled'] }),
      origin: ORIGIN, said_by: SAID_BY, note: str('备注')
    }, ['name'])
  },
  {
    name: 'mem_customer',
    write: true,
    description: '登记或修改一个客户(按名字找,没有就新建)。',
    input: obj({
      name: str('客户名'), contact_name: str('联系人'), phone: str('电话'), email: str('邮箱'), im: str('微信/Telegram/Batlink'),
      origin: ORIGIN, said_by: SAID_BY, note: str('备注')
    }, ['name'])
  },
  {
    name: 'mem_billing_set',
    write: true,
    description: '登记或修改一项客户收费(填 id 是修改;不填时按 客户+项目 找,没有就新建)。',
    input: obj({
      id: str('要修改的收费 id'),
      customer: str('客户名'), item: str('收什么钱,比如 "web-02 服务器月租"'), server: str('关联的服务器名'),
      amount: num('金额'), currency: str('币种,比如 USD'),
      cycle: str('monthly / quarterly / half-yearly / yearly / once', { enum: ['monthly', 'quarterly', 'half-yearly', 'yearly', 'once'] }),
      next_due_on: DATE('下次该付的日期'),
      status: str('active / paused / ended', { enum: ['active', 'paused', 'ended'] }),
      origin: ORIGIN, said_by: SAID_BY, note: str('备注')
    })
  },
  {
    name: 'mem_payment',
    write: true,
    description: '记一笔客户付款;会顺便更新那项收费的"上次付款"日期,并按周期把"下次该付"往后推。',
    input: obj({
      billing_id: str('收费 id(不知道就填 customer + item)'), customer: str('客户名'), item: str('收费项目'),
      paid_on: DATE('付款日期,默认今天'), amount: num('金额'), currency: str('币种'),
      origin: ORIGIN, said_by: SAID_BY, note: str('备注')
    })
  },
  {
    name: 'mem_retract',
    write: true,
    description: '把一条记错的事实或关系标成作废(不会删除,历史里还在)。要真删必须机主亲自要求,不在这里做。',
    input: obj({ table: str('facts 或 relations', { enum: ['facts', 'relations'] }), id: str('记录 id'), reason: str('为什么作废') }, ['table', 'id', 'reason'])
  }
];

// ── Reminders ──
// Only personal assistants get these tools: the assistant that creates a reminder is the one woken to deliver it.
// Who may use them (see canUseTool below):
//   - any agent id in REMINDER_AGENTS (default: the bundled personal assistant 'lingxi'); change it at startup with
//     setReminderAgents([...ids]) — in BOTH processes (the daemon running MemService and bin/mem-mcp.js);
//   - any identity started with --reminders (src/memdb/mcp-args.js adds it for engine=persona wakers and for
//     wakers with "reminders": true in config.json), which works without touching REMINDER_AGENTS.
export const REMINDER_AGENTS = new Set(['lingxi']);

/** Replace the set of agent ids allowed to use the reminder tools */
export function setReminderAgents(ids) {
  REMINDER_AGENTS.clear();
  for (const id of ids ?? []) if (String(id).trim()) REMINDER_AGENTS.add(String(id).trim());
  return REMINDER_AGENTS;
}

const LOCAL_TIME = str('本地时间,格式 "YYYY-MM-DD HH:mm",比如 "2030-01-01 08:00"');
const REPEAT = obj({
  freq: str('day 每天 / week 每周 / month 每月', { enum: ['day', 'week', 'month'] }),
  interval: num('每几天/周/月,默认 1')
}, ['freq']);
TOOLS.push(
  {
    name: 'mem_reminder_add',
    write: true,
    only: REMINDER_AGENTS,
    description: '建一个提醒。到点时程序会叫醒你,由你亲自私聊提醒你服务的人;没完成的话每 20 分钟再叫你一次,最多 20 次。循环提醒每一次都按起点整周期推算。',
    input: obj({
      title: str('提醒什么,比如 "喝水"、"交电费"'),
      at: LOCAL_TIME,
      repeat: REPEAT,
      timezone: str('时区(IANA 名,比如 Asia/Shanghai、America/New_York),默认机主设置的时区(没设就用这台电脑的时区)'),
      note: str('备注:提醒时要带上的细节'),
      scope: SCOPE,
      said_by: SAID_BY
    }, ['title', 'at'])
  },
  {
    name: 'mem_reminder_list',
    only: REMINDER_AGENTS,
    description: '看提醒:不填 id 列出所有进行中的提醒(下次时间、已提醒几次);填 id 看这一条的详情和最近的完成/错过记录。',
    input: obj({ id: str('提醒 id'), include_finished: { type: 'boolean', description: '列表里也包括已完成、已取消、已错过的一次性提醒' } })
  },
  {
    name: 'mem_reminder_done',
    write: true,
    only: REMINDER_AGENTS,
    description: '标记这一次已经做完(对方说做了、吃了、好了)。循环提醒会记一次"完成"并推进到下一次;一次性提醒就此结束。',
    input: obj({ id: str('提醒 id'), note: str('备注,比如 "饭后吃的"') }, ['id'])
  },
  {
    name: 'mem_reminder_snooze',
    write: true,
    only: REMINDER_AGENTS,
    description: '推迟这一次:过一会儿再提醒(对方说"等会儿""半小时后再叫我")。只推迟这一次,不影响以后的循环;提醒次数重新从 1 算。',
    input: obj({ id: str('提醒 id'), minutes: num('推迟多少分钟'), until: LOCAL_TIME }, ['id'])
  },
  {
    name: 'mem_reminder_update',
    write: true,
    only: REMINDER_AGENTS,
    description: '修改或取消提醒:改标题、备注、时间、循环规则;cancel=true 就是不再提醒。改时间或规则会从新的起点重新算。',
    input: obj({
      id: str('提醒 id'), title: str('新标题'), note: str('新备注'), at: LOCAL_TIME, timezone: str('新时区'),
      repeat: { ...REPEAT, description: '新的循环规则' },
      one_time: { type: 'boolean', description: '改成一次性(去掉循环)' },
      cancel: { type: 'boolean', description: '取消这个提醒' }
    }, ['id'])
  }
);

/** Tools hidden from some roles (an assistant serving a family member gets nothing about work, servers, customers or billing) */
export const HIDDEN_FOR_ROLE = {
  'family-assistant': new Set(['mem_servers', 'mem_billing', 'mem_log', 'mem_server', 'mem_customer', 'mem_billing_set', 'mem_payment'])
};

/**
 * Whether an identity may use a tool: tools with `only` are limited to those agents (or, for the reminder tools,
 * to identities started with --reminders); some roles additionally have tools hidden.
 * @param {{ name: string, only?: Set<string> }} def
 * @param {{ actor: string, role: string, reminders?: boolean }} identity
 */
export function canUseTool(def, { actor, role, reminders = false } = {}) {
  if (HIDDEN_FOR_ROLE[role]?.has(def.name)) return false;
  if (!def.only) return true;
  const agent = String(actor ?? '').split('@')[0];
  return def.only.has(agent) || (def.only === REMINDER_AGENTS && reminders === true);
}

/** Tools available to an identity */
export function toolsFor(actor, role, { reminders = false } = {}) {
  return TOOLS.filter((t) => canUseTool(t, { actor, role, reminders }));
}

export const TOOL_BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
