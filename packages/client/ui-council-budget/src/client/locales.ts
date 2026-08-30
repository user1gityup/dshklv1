/** Dictionary keys for the council budget panel. */
export type BudgetKey =
  | 'trigger.aria'
  | 'trigger.tooltip'
  | 'panel.title'
  | 'seats.title'
  | 'seats.metered'
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

export const NS = 'council-budget'

export const en: Record<BudgetKey, string> = {
  'trigger.aria': 'Council budget and capacity',
  'trigger.tooltip': 'Council Budget',
  'panel.title': 'Council Budget',
  'seats.title': 'Seats',
  'seats.metered': 'metered',
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
  'note.estimate': 'Estimates only. Subscription seats are priced from their monthly fee divided by measured output; prompt size is assumed at 3x output, so a cache-heavy workload costs less than shown.',
}

export const zh: Record<BudgetKey, string> = {
  'trigger.aria': '议会预算与容量',
  'trigger.tooltip': '议会预算',
  'panel.title': '议会预算',
  'seats.title': '席位',
  'seats.metered': '按量计费',
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
  'note.estimate': '仅为估算。订阅制席位按月费除以实测输出计价；提示词长度按输出的 3 倍估计，因此缓存较多的工作负载实际成本更低。',
}
