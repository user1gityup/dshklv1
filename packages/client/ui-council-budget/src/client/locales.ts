/** Dictionary keys for the council budget panel. */
export type BudgetKey =
  | 'trigger.aria'
  | 'trigger.tooltip'
  | 'panel.title'
  | 'seats.title'
  | 'seats.metered'
  | 'seats.free'
  | 'seats.subscription'
  | 'capacity.title'
  | 'capacity.perRun'
  | 'capacity.runsMonth'
  | 'capacity.runsLeft'
  | 'capacity.unit'
  | 'capacity.unknown'
  | 'balance.label'
  | 'balance.loading'
  | 'tools.title'
  | 'note.estimate'
  | 'capacity.outlay'
  | 'capacity.subRate'
  | 'seats.subPriced'
  | 'power.title'
  | 'power.total'
  | 'power.solo'
  | 'power.multiple'
  | 'power.perspectives'
  | 'power.latency'
  | 'power.precision'
  | 'power.precisionNone'
  | 'add.title'
  | 'add.modelPlaceholder'
  | 'add.namePlaceholder'
  | 'add.button'
  | 'add.remove'
  | 'add.unpriced'
  | 'add.duplicate'
  | 'mode.title'
  | 'mode.on'
  | 'mode.hint'
  | 'approve.title'
  | 'approve.action'
  | 'approve.discard'
  | 'approve.awaitingMessage'
  | 'swarm.toggleTitle'
  | 'swarm.toggleLabel'
  | 'swarm.toggleOn'
  | 'swarm.toggleHint'
  | 'swarm.title'
  | 'swarm.hint'
  | 'swarm.mode'
  | 'swarm.chooseMode'
  | 'swarm.economy'
  | 'swarm.fastest'
  | 'swarm.subscription'
  | 'swarm.free'
  | 'swarm.metered'
  | 'swarm.noneEnabled'
  | 'pipeline.title'
  | 'pipeline.hint'
  | 'pipeline.run'
  | 'pipeline.continue'
  | 'pipeline.held'
  | 'pipeline.resumeNow'
  | 'pipeline.presets'
  | 'pipeline.restart'
  | 'pipeline.placeholder'
  | 'pipeline.minimize'
  | 'pipeline.expand'
  | 'pipeline.failed'
  | 'pipeline.idle'
  | 'swarm.meteredWarning'
  | 'approve.always'
  | 'approve.alwaysHint'
  | 'approve.autoOn'
  | 'approve.autoOff'

export const NS = 'council-budget'

export const en: Record<BudgetKey, string> = {
  'trigger.aria': 'Council budget and capacity',
  'trigger.tooltip': 'Council Budget',
  'panel.title': 'Council Budget',
  'seats.title': 'Seats',
  'seats.metered': 'metered',
  'seats.free': 'free',
  'seats.subscription': 'subscription',
  'capacity.title': 'Capacity',
  'capacity.perRun': 'Est. cost per full run',
  'capacity.runsMonth': 'Runs per month at budget',
  'capacity.runsLeft': 'Runs left on balance',
  'capacity.unit': 'Typical run size',
  'capacity.unknown': 'not enough data yet',
  'balance.label': 'OpenRouter balance',
  'balance.loading': 'Loading…',
  'tools.title': 'Tools',
  'capacity.outlay': 'Total monthly outlay',
  'capacity.subRate': 'Subscription cost per 1M tokens',
  'seats.subPriced': 'subscription (priced)',
  'power.title': 'Power',
  'power.total': 'Total output per month',
  'power.solo': 'One seat alone',
  'power.multiple': 'Council vs one seat',
  'power.perspectives': 'Perspectives per query',
  'power.latency': 'Wall time vs one seat',
  'power.precision': 'Consensus rate',
  'power.precisionNone': 'no runs yet',
  'add.title': 'Add an OpenRouter seat',
  'add.modelPlaceholder': 'model id, e.g. x-ai/grok-4',
  'add.namePlaceholder': 'display name (optional)',
  'add.button': 'Add seat',
  'add.remove': 'remove',
  'add.unpriced': 'not in the OpenRouter catalogue — it will run but cannot be priced',
  'add.duplicate': 'that seat already exists',
  'mode.title': 'Council mode',
  'mode.on': 'Route every request through the council',
  'mode.hint': 'Trivial replies still answer directly. Each run stops at a plan for approval first.',
  'approve.title': 'Council plan waiting for your approval',
  'approve.action': 'Approve',
  'approve.discard': 'Discard',
  'approve.awaitingMessage': 'Approved. Send a message to run the council.',
  'pipeline.title': 'Pipeline',
  'pipeline.hint': 'Council agrees the approach, seats write competing versions, the swarm builds the one you pick, the council reviews it. One stage per press.',
  'pipeline.run': 'Run pipeline',
  'pipeline.continue': 'Continue',
  'pipeline.held': 'Held on quota — resuming in',
  'pipeline.resumeNow': 'Resume now',
  'pipeline.presets': 'Saved runs',
  'pipeline.restart': 'Start over',
  'pipeline.failed': 'The prompt did not reach the session — nothing was sent. Reason:',
  'pipeline.placeholder': 'What should the chain work on?',
  'pipeline.minimize': 'Minimize',
  'pipeline.expand': 'Expand',
  'pipeline.idle': 'idle',
  'swarm.toggleTitle': 'Swarm',
  'swarm.toggleLabel': 'Run approved work as a swarm',
  'swarm.toggleOn': 'Approved work is split across your seats and run in waves',
  'swarm.toggleHint': 'Split a request across your seats and run it in waves. They read, search and report.',
  'swarm.title': 'Swarm roster',
  'swarm.hint': 'Economy contests each unit with free workers. Fastest uses paid workers in parallel. Both require paid review.',
  'swarm.mode': 'Swarm mode',
  'swarm.chooseMode': 'Choose mode',
  'swarm.economy': 'Economy — free contestants, paid review',
  'swarm.fastest': 'Fastest — paid workers in parallel',
  'swarm.subscription': 'subscription',
  'swarm.free': 'free',
  'swarm.metered': 'metered',
  'swarm.noneEnabled': 'No worker is enabled, so nothing can run.',
  'swarm.meteredWarning': 'A metered worker is enabled: units it takes are billed per token.',
  'approve.always': 'Always approve',
  'approve.alwaysHint': 'Stop asking before each council run. The council will spend without checking with you first. You can switch this off at any time.',
  'approve.autoOn': 'Council auto-approve is ON — runs start without asking you.',
  'approve.autoOff': 'Turn off',
  'note.estimate': 'Estimates only. Subscription seats are priced from their monthly fee divided by measured output; prompt size is assumed at 3x output, so a cache-heavy workload costs less than shown.',
}

export const zh: Record<BudgetKey, string> = {
  'trigger.aria': '议会预算与容量',
  'trigger.tooltip': '议会预算',
  'panel.title': '议会预算',
  'seats.title': '席位',
  'seats.metered': '按量计费',
  'seats.free': '免费',
  'seats.subscription': '订阅制',
  'capacity.title': '容量',
  'capacity.perRun': '每次完整运行的预估成本',
  'capacity.runsMonth': '按预算每月可运行次数',
  'capacity.runsLeft': '按余额剩余可运行次数',
  'capacity.unit': '典型运行规模',
  'capacity.unknown': '数据不足',
  'balance.label': 'OpenRouter 余额',
  'balance.loading': '加载中…',
  'tools.title': '工具',
  'capacity.outlay': '每月总支出',
  'capacity.subRate': '订阅制每百万 token 成本',
  'seats.subPriced': '订阅制（已计价）',
  'power.title': '算力',
  'power.total': '每月总输出',
  'power.solo': '单席位单独运行',
  'power.multiple': '议会与单席位之比',
  'power.perspectives': '每次查询的视角数',
  'power.latency': '相对单席位的耗时',
  'power.precision': '一致率',
  'power.precisionNone': '暂无运行记录',
  'add.title': '添加 OpenRouter 席位',
  'add.modelPlaceholder': '模型 id，例如 x-ai/grok-4',
  'add.namePlaceholder': '显示名称（可选）',
  'add.button': '添加席位',
  'add.remove': '移除',
  'add.unpriced': '不在 OpenRouter 目录中——可运行但无法计价',
  'add.duplicate': '该席位已存在',
  'mode.title': '议会模式',
  'mode.on': '所有请求都交由议会处理',
  'mode.hint': '简单回复仍直接作答。每次运行都会先停在计划处等待批准。',
  'approve.title': '议会计划等待您的批准',
  'approve.action': '批准',
  'approve.discard': '丢弃',
  'approve.awaitingMessage': '已批准。发送一条消息即可运行议会。',
  'pipeline.title': '流水线',
  'pipeline.hint': '议会定方案，各席各写一版，蜂群按你所选者构建，议会复核。每次按下推进一个阶段。',
  'pipeline.run': '运行流水线',
  'pipeline.continue': '继续',
  'pipeline.held': '额度用尽，暂停中，恢复倒计时',
  'pipeline.resumeNow': '立即恢复',
  'pipeline.presets': '已保存的运行',
  'pipeline.restart': '重新开始',
  'pipeline.failed': '提示未送达会话 — 未发送任何内容。原因：',
  'pipeline.placeholder': '这条链要处理什么？',
  'pipeline.minimize': '最小化',
  'pipeline.expand': '展开',
  'pipeline.idle': '空闲',
  'swarm.toggleTitle': '蜂群',
  'swarm.toggleLabel': '以蜂群方式执行已批准的工作',
  'swarm.toggleOn': '已批准的工作将按波次分配给你配置的席位',
  'swarm.toggleHint': '将请求拆分给你的席位并按波次运行。它们会读取、搜索并汇报。',
  'swarm.title': '蜂群名单',
  'swarm.hint': '经济模式由免费工作者竞争每个单元；最快模式由付费工作者并行执行。两种模式均要求付费审查。',
  'swarm.mode': '群组模式',
  'swarm.chooseMode': '选择模式',
  'swarm.economy': '经济模式 — 免费竞争，付费审查',
  'swarm.fastest': '最快模式 — 付费工作者并行执行',
  'swarm.subscription': '订阅',
  'swarm.free': '免费',
  'swarm.metered': '按量计费',
  'swarm.noneEnabled': '没有启用任何工作者，因此无法运行。',
  'swarm.meteredWarning': '已启用按量计费的工作者：它承担的任务将按 token 计费。',
  'approve.always': '始终批准',
  'approve.alwaysHint': '不再在每次运行前询问。议会将直接花费，不再与您确认。可随时关闭。',
  'approve.autoOn': '议会自动批准已开启 — 运行将不再征求您的同意。',
  'approve.autoOff': '关闭',
  'note.estimate': '仅为估算。订阅制席位按月费除以实测输出计价；提示词长度按输出的 3 倍估计，因此缓存较多的工作负载实际成本更低。',
}
