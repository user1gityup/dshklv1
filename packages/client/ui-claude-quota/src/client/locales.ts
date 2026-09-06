/** Dictionary keys for the Claude quota panel. */
export type QuotaKey =
  | 'trigger.aria'
  | 'trigger.tooltip'
  | 'panel.title'
  | 'session.label'
  | 'week.label'
  | 'resets'
  | 'activity.title'
  | 'activity.day'
  | 'activity.week'
  | 'shape.title'
  | 'shape.context'
  | 'shape.longSessions'
  | 'shape.hint'
  | 'refresh.button'
  | 'refresh.running'
  | 'refresh.failed'
  | 'refresh.cost'
  | 'status.captured'
  | 'status.never'
  | 'empty.title'
  | 'empty.body'

/** Locale namespace this panel registers under. */
export const NS = 'claude-quota'

export const en: Record<QuotaKey, string> = {
  'trigger.aria': 'Claude Code session and weekly quota',
  'trigger.tooltip': 'Claude Quota',
  'panel.title': 'Claude Quota',
  'session.label': 'Session',
  'week.label': 'Week',
  'resets': 'resets {when}',
  'activity.title': 'Activity',
  'activity.day': '{requests} requests · {sessions} sessions (24h)',
  'activity.week': '{requests} requests · {sessions} sessions (7d)',
  'shape.title': 'What the usage looked like',
  'shape.context': '{percent}% at >{threshold}k context',
  'shape.longSessions': '{percent}% from sessions {hours}h+',
  'shape.hint': 'Long sessions re-send the whole conversation each turn, so session length drives cost more than question difficulty.',
  'refresh.button': 'Refresh',
  'refresh.running': 'Reading /usage…',
  'refresh.failed': 'Could not read /usage. Showing the last figures.',
  'refresh.cost': 'A refresh spends one request against this quota.',
  'status.captured': 'Read {time}',
  'status.never': 'No reading yet',
  'empty.title': 'No quota reading',
  'empty.body': 'Press Refresh to ask the Claude Code CLI for your session and weekly usage.',
}

export const zh: Record<QuotaKey, string> = {
  'trigger.aria': 'Claude Code 会话与每周配额',
  'trigger.tooltip': 'Claude 配额',
  'panel.title': 'Claude 配额',
  'session.label': '本会话',
  'week.label': '本周',
  'resets': '{when} 重置',
  'activity.title': '活动',
  'activity.day': '{requests} 次请求 · {sessions} 个会话（24 小时）',
  'activity.week': '{requests} 次请求 · {sessions} 个会话（7 天）',
  'shape.title': '用量构成',
  'shape.context': '{percent}% 在 >{threshold}k 上下文',
  'shape.longSessions': '{percent}% 来自 {hours} 小时以上的会话',
  'shape.hint': '长会话每轮都会重发整段对话，成本更多由会话长度决定，而非问题难度。',
  'refresh.button': '刷新',
  'refresh.running': '正在读取 /usage…',
  'refresh.failed': '无法读取 /usage，显示上次的数据。',
  'refresh.cost': '每次刷新会消耗本配额中的一次请求。',
  'status.captured': '{time} 读取',
  'status.never': '尚无数据',
  'empty.title': '暂无配额数据',
  'empty.body': '点击刷新，向 Claude Code CLI 查询会话与每周用量。',
}
