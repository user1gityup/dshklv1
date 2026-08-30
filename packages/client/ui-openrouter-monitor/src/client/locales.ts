/** Dictionary keys for the OpenRouter monitor UI copy. */
export type MonitorKey =
  | 'trigger.aria'
  | 'trigger.tooltip'
  | 'panel.title'
  | 'balance.label'
  | 'balance.loading'
  | 'balance.error'
  | 'usage.label'
  | 'usage.totalSpent'
  | 'usage.thisMonth'
  | 'usage.byModel'
  | 'usage.unavailable'
  | 'mgmt.label'
  | 'mgmt.placeholder'
  | 'mgmt.hint'
  | 'mgmt.save'
  | 'mgmt.clear'
  | 'usage.pendingDay'
  | 'session.label'
  | 'session.in'
  | 'session.out'
  | 'session.cached'
  | 'session.none'
  | 'usage.localTitle'
  | 'usage.localTokens'
  | 'usage.tokenSplit'
  | 'model.header'
  | 'status.refreshing'
  | 'status.updated'
  | 'status.configured'
  | 'keyMissing.title'
  | 'keyMissing.body'

export const NS = 'openrouter-monitor'

export const en: Record<MonitorKey, string> = {
  'trigger.aria': 'OpenRouter API balance and usage',
  'trigger.tooltip': 'OpenRouter Monitor',
  'panel.title': 'OpenRouter Monitor',
  'balance.label': 'Credits',
  'balance.loading': 'Loading balance\u2026',
  'balance.error': 'Failed to load balance',
  'usage.label': 'Usage',
  'usage.totalSpent': 'Total spent',
  'usage.thisMonth': 'This month',
  'usage.byModel': 'By model',
  'usage.unavailable': 'Per-model usage unavailable for this key',
  'mgmt.label': 'Per-model usage',
  'mgmt.placeholder': 'Management key (sk-or-v1-…)',
  'mgmt.hint': 'Per-model spend needs an OpenRouter management key.',
  'mgmt.save': 'Enable',
  'mgmt.clear': 'Remove management key',
  'usage.pendingDay': 'No completed-day activity yet. OpenRouter reports per-model spend only for finished UTC days, so today\u2019s usage appears tomorrow.',
  'session.label': 'This session',
  'session.in': 'Input',
  'session.out': 'Output',
  'session.cached': 'Cached',
  'session.none': 'No recorded usage in this session',
  'usage.tokenSplit': '{inTok} in / {outTok} out',
  'usage.localTitle': 'This session (local)',
  'usage.localTokens': '{n} output tokens',
  'model.header': 'Model',
  'status.refreshing': 'Refreshing\u2026',
  'status.updated': 'Updated {time}',
  'status.configured': 'OpenRouter key configured',
  'keyMissing.title': 'No OpenRouter key',
  'keyMissing.body': 'Configure an OpenRouter API key in Settings to see your balance.',
}
export const zh: Record<MonitorKey, string> = {
  'trigger.aria': 'OpenRouter API 余额与用量',
  'trigger.tooltip': 'OpenRouter 监视器',
  'panel.title': 'OpenRouter 监视器',
  'balance.label': '额度',
  'balance.loading': '正在加载余额…',
  'balance.error': '加载余额失败',
  'usage.label': '用量',
  'usage.totalSpent': '累计消费',
  'usage.thisMonth': '本月',
  'usage.byModel': '按模型',
  'usage.unavailable': '此密钥无法获取各模型用量',
  'mgmt.label': '各模型用量',
  'mgmt.placeholder': '管理密钥（sk-or-v1-…）',
  'mgmt.hint': '查看各模型花费需要 OpenRouter 管理密钥。',
  'mgmt.save': '启用',
  'mgmt.clear': '移除管理密钥',
  'usage.pendingDay': '暂无已完成日期的活动数据。OpenRouter 仅报告已结束 UTC 日期的各模型花费，今天的用量将于明天显示。',
  'session.label': '当前会话',
  'session.in': '输入',
  'session.out': '输出',
  'session.cached': '缓存命中',
  'session.none': '当前会话暂无用量记录',
  'usage.tokenSplit': '{inTok} in / {outTok} out',
  'usage.localTitle': '本会话（本地统计）',
  'usage.localTokens': '{n} 个输出 token',
  'model.header': '模型',
  'status.refreshing': '正在刷新…',
  'status.updated': '更新于 {time}',
  'status.configured': '已配置 OpenRouter 密钥',
  'keyMissing.title': '未配置 OpenRouter 密钥',
  'keyMissing.body': '在设置中配置 OpenRouter API 密钥以查看余额。',
}
