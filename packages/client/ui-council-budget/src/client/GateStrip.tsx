/**
 * The pending gate, at the top of the column beside the pipeline control.
 *
 * The Approve control proper lives on the call that issued the plan, and that
 * is still the right home for it: an approval detached from the thing it
 * approves is ambiguous. But a council run prints thousands of words, so by
 * the time the report has finished streaming the button is far above the fold,
 * and the user is left scrolling a wall of text to find the one control the
 * run is waiting on. This strip is the pointer: it says what is waiting, how
 * long is left, and carries the same two actions, next to the control that
 * starts a run rather than buried in its output.
 *
 * It shows nothing at all when nothing is waiting. A permanent bar reporting
 * "no gate" would cost the same space and say less than the absence does.
 *
 * The two factors stay two deliberate clicks. Approving and sending in one
 * gesture would collapse a gate whose whole design is that a button press and
 * a user turn are separate acts — so the strip offers Approve, and only once
 * that has landed offers to send the message that runs it.
 *
 * **Picking a version happens here too, and that is not an extra feature.**
 * After the proposing stage every seat has written its own version of the
 * change into a tree of its own, and the chain cannot advance until a person
 * says which one to build. That is the same shape as an approval — a decision
 * only the user can make, blocking a stage that would otherwise spend — so it
 * belongs in the same place, not in the transcript where the candidates were
 * printed and have since scrolled away. The pick IS the second factor: naming
 * the version is the user turn that lets the swarm stage run.
 */

import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { JSX } from 'react'
import type { SettingsFace } from './CouncilBudget.tsx'
import { NS } from './locales.ts'
import css from './GateStrip.module.css'

/** Props for the gate strip. */
export type GateStripProps =
  PropsRuntime<'conversation.column.top'>
  & PropsLocale<typeof NS>
  & {
    settings: SettingsFace
    /** Sends one prompt into this session, exactly as typed. */
    send: (text: string) => Promise<void>
  }

/**
 * How long an issued plan stays approvable.
 *
 * Mirrored from the host's `PLAN_TTL_MS`: the client cannot import host code,
 * and a countdown that disagreed with the gate would be worse than none. The
 * strip only reads it — expiry is decided host-side, on the same number.
 */
const PLAN_TTL_MS = 15 * 60 * 1000

/** Message sent to satisfy the second factor. Short on purpose: the council
 * re-runs the question the plan was written for, not this text. */
const RUN_IT = 'go'

/** One gate's settings keys, and how it reads on the strip. */
interface Gate {
  readonly held: string
  readonly issuedAt: string
  readonly query: string
  readonly approvedId: string
  readonly approvedAt: string
  readonly label: string
}

/**
 * The gates this strip watches, in the order it prefers to show them.
 *
 * A swarm graph is the more expensive commitment, so when both somehow stand
 * it is the one named first.
 */
const GATES: readonly Gate[] = [
  {
    // First because it is the most expensive call the chain makes — a long
    // writing round on every seat, then a vote — and because approving a
    // debate must never be mistaken for approving one of these.
    held: 'pendingProposeId',
    issuedAt: 'pendingProposeIssuedAt',
    // Not `pendingProposeQuery`: the proposing gate stores what the seats were
    // asked to implement under `Task`, and a strip reading the wrong key shows
    // a blank line where the change should be.
    query: 'pendingProposeTask',
    approvedId: 'approvedProposeId',
    approvedAt: 'approvedProposeAt',
    label: 'Proposing round',
  },
  {
    held: 'pendingSwarmId',
    issuedAt: 'pendingSwarmIssuedAt',
    query: 'pendingSwarmQuery',
    approvedId: 'approvedSwarmId',
    approvedAt: 'approvedSwarmAt',
    label: 'Swarm graph',
  },
  {
    held: 'pendingPlanId',
    issuedAt: 'pendingPlanIssuedAt',
    query: 'pendingPlanQuery',
    approvedId: 'approvedPlanId',
    // Not `approvedPlanAt`: the council gate's timestamp key predates the
    // swarm's and never got the prefix.
    approvedAt: 'approvedAt',
    label: 'Council plan',
  },
]

/** Read a string setting, treating the empty sentinel as absent. */
function text(section: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = section?.[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Read a numeric setting. */
function number(section: Record<string, unknown> | undefined, key: string): number {
  const value = section?.[key]
  return typeof value === 'number' ? value : 0
}

/** Minutes and seconds left, or undefined once nothing is left. */
function countdown(issuedAt: number, now: number): string | undefined {
  if (issuedAt <= 0) return undefined
  const left = issuedAt + PLAN_TTL_MS - now
  if (left <= 0) return undefined
  const seconds = Math.floor(left / 1000)
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`
}

/** What the strip has to show, decided from settings alone. */
export interface GateView {
  /** Settings key holding the id, so a discard knows what to clear. */
  readonly heldKey: string
  /** Settings keys the Approve click writes. */
  readonly approvedIdKey: string
  readonly approvedAtKey: string
  /** The id being approved. */
  readonly id: string
  /** What is waiting: "Council plan" or "Swarm graph". */
  readonly label: string
  readonly state: 'waiting' | 'approved' | 'expired'
  /** Time left on the plan's TTL, mm:ss, while any remains. */
  readonly left?: string | undefined
  /** The question the gate was issued for, for telling two gates apart. */
  readonly question: string
}

/** One seat's version, as the chain stored it. */
export interface PickCandidate {
  readonly seat: string
  readonly root: string
  readonly files: number
}

/**
 * The versions waiting to be picked from, or none.
 *
 * Parsed rather than trusted, for the same reason the host parses it back:
 * this crosses a durable file boundary. Losing it costs nothing — the code is
 * still on disk under each seat's root — so anything unreadable is treated as
 * nothing waiting, which fails towards showing no picker rather than towards
 * showing a broken one.
 * @param section - the council settings section.
 * @returns the candidates, empty when there is nothing to pick between.
 */
export function pickCandidates(section: Record<string, unknown> | undefined): readonly PickCandidate[] {
  // A pick already made is not a pick still waiting: the strip is for what
  // blocks the run, and this one no longer does.
  if (text(section, 'pipelinePicked') !== undefined) return []
  const raw = text(section, 'pipelineCandidates')
  if (raw === undefined) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.filter((entry): entry is PickCandidate =>
    typeof entry === 'object' && entry !== null
    && typeof (entry as { seat?: unknown }).seat === 'string'
    && typeof (entry as { root?: unknown }).root === 'string'
    && typeof (entry as { files?: unknown }).files === 'number')
}

/**
 * The message a pick sends, which is also the gate's second factor.
 * @param picked - seats chosen, in the order they were chosen.
 * @returns the message text, shown on the button before it is sent.
 */
export function pickMessage(picked: readonly string[]): string {
  if (picked.length === 0) return ''
  if (picked.length === 1) return `Build from the ${String(picked[0])} version.`
  // Several picked means a merge, and saying so plainly is what stops the next
  // stage from quietly building the first one and dropping the rest.
  return `Build from these versions, merged: ${picked.join(', ')}.`
}

/**
 * Decide what the strip shows.
 *
 * Kept apart from the rendering so every branch is checkable without a DOM:
 * which gate wins when two stand, expiry against the same TTL the host judges
 * on, and the approved state that turns the strip from a button into a nudge.
 * @param section - the council settings section.
 * @param now - current time in epoch ms.
 * @returns what to render, or undefined when nothing is waiting.
 */
export function gateState(section: Record<string, unknown> | undefined, now: number): GateView | undefined {
  // Auto-approve means nothing ever waits, so a strip would be reporting a
  // gate the user switched off.
  if (section?.['autoApprove'] === true) return undefined
  for (const gate of GATES) {
    const id = text(section, gate.held)
    if (id === undefined) continue
    const left = countdown(number(section, gate.issuedAt), now)
    const approved = text(section, gate.approvedId) === id
    return {
      heldKey: gate.held,
      approvedIdKey: gate.approvedId,
      approvedAtKey: gate.approvedAt,
      id,
      label: gate.label,
      // Expiry beats approval: an approved plan past its TTL still cannot run,
      // and saying "approved" there would send the user off to type a message
      // that does nothing.
      state: left === undefined && number(section, gate.issuedAt) > 0 ? 'expired' : approved ? 'approved' : 'waiting',
      ...left === undefined ? {} : { left },
      question: text(section, gate.query) ?? '',
    }
  }
  return undefined
}

/**
 * The waiting gate, or nothing.
 * @param props - the council settings scope and this session's send.
 * @returns the strip, or null when no gate is open.
 */
export function GateStrip({ settings, send }: GateStripProps): JSX.Element | null {
  const snapshot = useSyncExternalStore(
    fn => settings.subscribe(fn),
    () => settings.getSnapshot(),
  )
  const [now, setNow] = useState(() => Date.now())
  const [sending, setSending] = useState(false)
  const [picked, setPicked] = useState<readonly string[]>([])
  const view = gateState(snapshot.value, now)
  const candidates = pickCandidates(snapshot.value)
  // The pick outranks a gate. A swarm graph approved before the version was
  // chosen is a graph for the wrong version, so the choice is asked for first.
  const picking = candidates.length > 0
  const open = view !== undefined || picking

  // The countdown only ticks while something is actually waiting on it.
  useEffect(() => {
    if (!open) return undefined
    const timer = setInterval(() => {
      setNow(Date.now())
    }, 1000)
    return () => {
      clearInterval(timer)
    }
  }, [open])

  if (picking) {
    const message = pickMessage(picked)
    return (
      <div className={css.strip} data-state="waiting">
        <div className={css.headline}>
          <span className={css.label}>Pick a version</span>
          <span className={css.state}>
            {`${String(candidates.length)} seats wrote one — nothing is built until you choose`}
          </span>
        </div>

        <div className={css.picks}>
          {candidates.map((candidate) => {
            const on = picked.includes(candidate.seat)
            return (
              <button
                key={candidate.seat}
                type="button"
                className={on ? `${css.pick} ${css.pickOn}` : css.pick}
                aria-pressed={on}
                // The path is the only way to actually look at the code, and a
                // title is the cheapest place to put it that costs no layout.
                title={`${candidate.root} — ${String(candidate.files)} files`}
                onClick={() => {
                  // Several may be picked: the usual answer is a merge, and
                  // forcing a single winner would throw away the parts of the
                  // others the user wanted.
                  //
                  // Updated from the previous value rather than from the one
                  // captured when this row rendered. Two picks inside one React
                  // batch both read the same stale array otherwise, and the
                  // second silently replaces the first — which is exactly the
                  // merge the multi-select exists to allow.
                  setPicked(previous => previous.includes(candidate.seat)
                    ? previous.filter(seat => seat !== candidate.seat)
                    : [...previous, candidate.seat])
                }}
              >
                <span className={css.pickSeat}>{candidate.seat}</span>
                <span className={css.pickFiles}>{`${String(candidate.files)} files`}</span>
              </button>
            )
          })}
        </div>

        <div className={css.actions}>
          <button
            type="button"
            className={css.run}
            disabled={sending || picked.length === 0}
            onClick={() => {
              setSending(true)
              // Written before it is sent: the settings key is what the next
              // stage reads, and a message that landed against an unwritten
              // pick would build nothing in particular.
              void settings.set('pipelinePicked', picked.join(','))
              void send(message).finally(() => {
                setSending(false)
              })
            }}
          >
            {picked.length === 0 ? 'Choose one or more' : sending ? 'Sending…' : `Send “${message}”`}
          </button>
        </div>
      </div>
    )
  }

  if (view === undefined) return null

  const { id, left, question } = view
  const approved = view.state === 'approved'
  const expired = view.state === 'expired'

  return (
    <div className={css.strip} data-state={view.state}>
      <div className={css.headline}>
        <span className={css.label}>{view.label}</span>
        <span className={css.state}>
          {expired
            ? 'expired — ask again for a fresh one'
            : approved
              ? 'approved · send a message to run it'
              : 'waiting for your approval'}
        </span>
        {left === undefined ? null : <span className={css.clock}>{left}</span>}
      </div>

      {question === '' ? null : <p className={css.question}>{question}</p>}

      {expired
        ? null
        : (
          <div className={css.actions}>
            {approved
              ? (
                <button
                  type="button"
                  className={css.run}
                  disabled={sending}
                  onClick={() => {
                    // The message is the second factor, and it is sent as
                    // itself — shown on the button before it goes, never as a
                    // hidden prompt.
                    setSending(true)
                    void send(RUN_IT).finally(() => {
                      setSending(false)
                    })
                  }}
                >
                  {sending ? 'Sending…' : `Send “${RUN_IT}” to run it`}
                </button>
              )
              : (
                <>
                  <button
                    type="button"
                    className={css.approve}
                    onClick={() => {
                      // Order matters: the id says WHICH plan was approved, and
                      // the timestamp is what the second factor is measured
                      // against.
                      void settings.set(view.approvedIdKey, id)
                      void settings.set(view.approvedAtKey, Date.now())
                    }}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className={css.discard}
                    onClick={() => { void settings.set(view.heldKey, '') }}
                  >
                    Discard
                  </button>
                </>
              )}
          </div>
        )}
    </div>
  )
}

export { NS }
