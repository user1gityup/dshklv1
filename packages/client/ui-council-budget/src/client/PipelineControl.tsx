/**
 * The pipeline control: one button for the whole council → swarm → council run.
 *
 * The chain is a tool, and a tool is only reachable by asking the model for it.
 * That is the thing this control removes: the user should not have to remember
 * the wording that starts a three-stage run, nor retype it to continue one. So
 * the prompt lives here, in the open, and the button sends it.
 *
 * It is deliberately NOT a hidden instruction. What gets sent is shown on the
 * control before it is sent, because a button that silently prompts on the
 * user's behalf is a button they cannot audit.
 *
 * A saved run is PICKED, not fired, by being clicked. With several of them
 * the question the panel has to answer before anything is spent is which one,
 * so the pills carry that answer: the picked run reads green and the rest read
 * red, saying plainly which one the Run button is aimed at. Nothing is red
 * until something is picked — a row of red pills before any choice is made
 * would be reporting a fault, not a choice.
 *
 * The held state is the reason this is a panel rather than a single button.
 * A run parked on a spent subscription has to come back by itself — that is
 * the whole point of holding rather than failing — so the control counts the
 * hold down and sends the continue prompt once, on its own, when the window
 * has rolled over.
 */

import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { SettingsFace } from './CouncilBudget.tsx'
import { NS } from './locales.ts'
import css from './PipelineControl.module.css'

/** Props for the pipeline control. */
export type PipelineControlProps =
  PropsRuntime<'conversation.input.dock'>
  & PropsLocale<typeof NS>
  & {
    settings: SettingsFace
    /** Sends one prompt into this session, exactly as typed. */
    send: (text: string) => Promise<void>
  }

/** Stage order, mirrored from the host so the control can count them. */
const STAGES = ['council', 'swarm', 'review'] as const

/** What each stage is called on the control. */
const STAGE_LABEL: Record<string, string> = {
  council: 'council — agree the approach',
  swarm: 'swarm — split and run the work',
  review: 'council — review what came back',
}

/**
 * The prompt that starts a run, shown to the user before it is sent.
 * @param request - the work, in the user's own words.
 * @returns the prompt text.
 */
export function startPrompt(request: string): string {
  return `Run the pipeline tool on this request, one stage at a time: ${request}`
}

/** The prompt that abandons the run in progress and starts a fresh one. */
export const RESTART_PROMPT = 'Restart the pipeline: call the pipeline tool with restart set to true.'

/** The prompt that advances a run that is already in progress. */
export const CONTINUE_PROMPT = 'Continue the pipeline — call the pipeline tool again to advance the next stage.'

/**
 * The area half of a preset id.
 *
 * Ids are `area/name` — `dsh/gate-audit`, `web/ship-landing`. The area is what
 * makes a list of twenty scannable: sorting by id puts an area's runs together,
 * and showing the area on the button says which project a name belongs to when
 * two areas both have a `smoke-test`.
 * @param id - the preset id.
 * @returns the area, or '' when the id carries none.
 */
export function presetArea(id: string): string {
  const cut = id.indexOf('/')
  return cut <= 0 ? '' : id.slice(0, cut)
}

/**
 * The name half of a preset id, used when a preset carries no display name.
 * @param id - the preset id.
 * @returns the name after the area, or the whole id.
 */
export function presetLeaf(id: string): string {
  const cut = id.indexOf('/')
  return cut < 0 ? id : id.slice(cut + 1)
}
/**
 * How one saved run's pill should read, given which run is picked.
 *
 * Three states rather than two: with nothing picked the row is a list and
 * every pill is neutral, and only a choice turns the others red.
 * @param id - the pill's preset id.
 * @param picked - the picked preset id, '' when none is.
 * @returns 'on' for the picked run, 'off' for the rest, 'idle' before a choice.
 */
export function presetTone(id: string, picked: string): 'on' | 'off' | 'idle' {
  if (picked === '') return 'idle'
  return id === picked ? 'on' : 'off'
}

/**
 * How long until a hold ends, worded for a person.
 * @param resumeAt - epoch ms.
 * @param now - epoch ms.
 * @returns e.g. "12m 04s".
 */
function countdown(resumeAt: number, now: number): string {
  const left = Math.max(0, resumeAt - now)
  const minutes = Math.floor(left / 60_000)
  const seconds = Math.floor((left % 60_000) / 1_000)
  return `${String(minutes)}m ${seconds < 10 ? '0' : ''}${String(seconds)}s`
}

/**
 * Pipeline control, docked above the composer.
 * @param props - locale seat, the council settings scope, and the send face.
 * @returns the control.
 */
export function PipelineControl({ t, settings, send }: PipelineControlProps): JSX.Element | null {
  const snapshot = useSyncExternalStore(
    fn => settings.subscribe(fn),
    () => settings.getSnapshot(),
  )
  const section = snapshot.value
  const [request, setRequest] = useState('')
  // Which saved run the Run button is aimed at; '' means the typed request.
  // Picking is separate from running because a pill that spends on the click
  // that selects it can never be *selected* — only committed to.
  const [picked, setPicked] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  // A hold must reactivate ONCE. Without this the countdown reaching zero
  // would send the continue prompt on every tick.
  const fired = useRef<number>(0)
  /** The stage this control has already sent a continue for. */
  const advanced = useRef<string>('')

  const running = typeof section?.['pipelineId'] === 'string' && section['pipelineId'] !== ''
  const stage = typeof section?.['pipelineStage'] === 'string' ? section['pipelineStage'] : 'council'
  const resumeAt = typeof section?.['pipelineHoldResumeAt'] === 'number' ? section['pipelineHoldResumeAt'] : 0
  const held = resumeAt > 0
  const query = typeof section?.['pipelineQuery'] === 'string' ? section['pipelineQuery'] : ''
  const auto = section?.['pipelineAuto'] === true

  // Presets are written into settings — by hand, or by an assistant the user
  // worked the wording out with. The panel only reads them, so a preset is
  // reviewable in one place instead of being retyped into the composer.
  const presets = Object.entries(
    (section?.['pipelinePresets'] ?? {}) as Record<string, { name?: string; query?: string; autoAdvance?: boolean }>,
  )
    .filter(([, preset]) => typeof preset.query === 'string' && preset.query !== '')
    // Sorted by id, and ids are `area/name`, so the list groups itself by area
    // without anyone maintaining an order. A saved run is found by scanning,
    // and scanning only works when neighbours are related.
    .sort(([a], [b]) => a.localeCompare(b))

  // The clock only runs while something is actually counting down.
  useEffect(() => {
    if (!held) return undefined
    const timer = setInterval(() => { setNow(Date.now()) }, 1_000)
    return () => { clearInterval(timer) }
  }, [held])

  // The picked run, read from the live list rather than copied: a preset
  // deleted or rewritten under the panel must not still be firable from a
  // selection made before the change.
  const chosen = presets.find(([id]) => id === picked)?.[1]
  // The one text the Run button will send. A picked run outranks the box, and
  // the two clear each other, so the panel never holds two pending requests.
  const outgoing = chosen === undefined ? request.trim() : (chosen.query ?? '')

  const go = (text: string): void => {
    setBusy(true)
    void send(text).finally(() => { setBusy(false) })
  }

  // Start whatever the panel is aimed at. Only a saved run carries an
  // auto-advance setting, so firing one writes that flag and a typed request
  // clears it — otherwise the last preset's setting would leak into the next
  // hand-typed run.
  const start = (): void => {
    if (outgoing === '') return
    void settings.set('pipelineAuto', chosen?.autoAdvance === true)
    advanced.current = ''
    setPicked('')
    go(startPrompt(outgoing))
  }

  // The reactivation itself: the window has rolled over, so continue without
  // being asked. This is what the hold exists for.
  useEffect(() => {
    if (!held || now < resumeAt || fired.current === resumeAt) return
    fired.current = resumeAt
    go(CONTINUE_PROMPT)
  }, [held, now, resumeAt])

  // Auto-advance: a preset that says so carries the chain from stage to stage
  // without being asked. It fires once per stage — the ref is what stops a
  // re-render from sending the same continue twice — and never while held,
  // because a held run must not be poked at all until its window rolls over.
  useEffect(() => {
    if (!auto || !running || held || busy) return undefined
    if (advanced.current === stage) return undefined
    const timer = setTimeout(() => {
      advanced.current = stage
      go(CONTINUE_PROMPT)
    }, 1_500)
    return () => { clearTimeout(timer) }
  }, [auto, running, held, busy, stage])

  // The run is over: stop advancing, so the next manual run is manual.
  useEffect(() => {
    if (!running && auto) void settings.set('pipelineAuto', false)
  }, [running, auto, settings])

  // A pick that no longer names a saved run would colour the row while aiming
  // the Run button at nothing, so it is dropped.
  useEffect(() => {
    if (picked !== '' && chosen === undefined) setPicked('')
  }, [picked, chosen])

  const index = STAGES.indexOf(stage as (typeof STAGES)[number])
  const position = index < 0 ? 1 : index + 1

  return (
    <div className={css.panel} role="group" aria-label={t('pipeline.title')}>
      <div className={css.head}>
        <strong className={css.title}>{t('pipeline.title')}</strong>
        <span className={css.sub}>{t('pipeline.hint')}</span>
      </div>

      {held
        ? (
          <div className={css.held}>
            <span className={css.lamp} aria-hidden="true" />
            <span>
              {t('pipeline.held')}
              {' '}
              <strong>{countdown(resumeAt, now)}</strong>
              {' · '}
              {STAGE_LABEL[stage] ?? stage}
            </span>
            <button
              type="button"
              className={css.action}
              disabled={busy}
              onClick={() => { go(CONTINUE_PROMPT) }}
            >
              {t('pipeline.resumeNow')}
            </button>
          </div>
        )
        : null}

      {running && !held
        ? (
          <div className={css.row}>
            <span className={css.stage}>
              {`Stage ${String(position)} of 3 · ${STAGE_LABEL[stage] ?? stage}`}
            </span>
            <button
              type="button"
              className={css.action}
              disabled={busy}
              onClick={() => { go(CONTINUE_PROMPT) }}
            >
              {t('pipeline.continue')}
            </button>
            <button
              type="button"
              className={css.action}
              disabled={busy}
              onClick={() => { go(RESTART_PROMPT) }}
            >
              {t('pipeline.restart')}
            </button>
            <span className={css.query} title={query}>{query}</span>
          </div>
        )
        : null}

      {presets.length > 0 && !running
        ? (
          <div className={css.row}>
            <span className={css.presetLabel}>{t('pipeline.presets')}</span>
            {presets.map(([id, preset]) => {
              const tone = presetTone(id, picked)
              return (
                <button
                  key={id}
                  type="button"
                  className={
                    tone === 'idle' ? css.preset : `${css.preset} ${tone === 'on' ? css.presetOn : css.presetOff}`
                  }
                  aria-pressed={tone === 'on'}
                  disabled={busy}
                  title={preset.query}
                  onClick={() => {
                    // Clicking the picked run again unpicks it, so a choice
                    // made by mistake is undone the same way it was made.
                    setPicked(tone === 'on' ? '' : id)
                    if (tone !== 'on') setRequest('')
                  }}
                >
                  {presetArea(id) === '' ? null : <span className={css.presetArea}>{presetArea(id)}</span>}
                  {preset.name === undefined || preset.name === '' ? presetLeaf(id) : preset.name}
                </button>
              )
            })}
          </div>
        )
        : null}

      {!running
        ? (
          <div className={css.row}>
            <input
              className={css.input}
              type="text"
              value={request}
              placeholder={t('pipeline.placeholder')}
              onChange={(event) => {
                setRequest(event.target.value)
                if (event.target.value !== '') setPicked('')
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') start()
              }}
            />
            <button
              type="button"
              className={css.action}
              disabled={busy || outgoing === ''}
              onClick={() => { start() }}
            >
              {t('pipeline.run')}
            </button>
          </div>
        )
        : null}

      {/* The prompt is shown, not hidden: a button that speaks for the user
          should say what it is about to say. */}
      {!running && outgoing !== ''
        ? <p className={css.preview}>{startPrompt(outgoing)}</p>
        : null}
    </div>
  )
}
