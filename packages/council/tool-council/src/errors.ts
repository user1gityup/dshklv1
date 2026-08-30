/**
 * Error description for seat failures.
 *
 * `String(error)` renders a plain object as `[object Object]`, which is how a
 * real failure reason reached a report as nothing at all. Provider SDKs throw
 * plain objects and `AggregateError`s routinely, so a seat runner cannot assume
 * it caught an `Error`.
 */

/** Fields worth reporting when a thrown value is not an Error. */
interface ErrorLike {
  readonly message?: unknown
  readonly error?: unknown
  readonly code?: unknown
  readonly status?: unknown
  readonly statusText?: unknown
  readonly type?: unknown
  readonly name?: unknown
}

/** Read a string-ish field, ignoring anything that would render as an object. */
function text(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

/**
 * Describe a thrown value in one line a human can act on.
 *
 * Walks the shapes providers actually throw — Error, AggregateError, a plain
 * object with `message` or `error`, an HTTP-ish object with `status` — and
 * falls back to a JSON view rather than `[object Object]`.
 * @param error - the caught value, of unknown shape.
 * @returns a single-line description, never empty.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const parts = [error.message.trim() === '' ? error.name : error.message]
    // AggregateError carries the reasons that actually matter.
    const inner = (error as { errors?: unknown }).errors
    if (Array.isArray(inner) && inner.length > 0) {
      parts.push(`(${inner.slice(0, 3).map(entry => describeError(entry)).join('; ')})`)
    }
    const cause = (error as { cause?: unknown }).cause
    if (cause !== undefined && cause !== null) parts.push(`caused by ${describeError(cause)}`)
    return parts.join(' ')
  }

  if (typeof error === 'string') return error.trim() === '' ? 'empty error' : error.trim()
  if (error === null || error === undefined) return 'unknown error'
  if (typeof error !== 'object') return String(error)

  const shape = error as ErrorLike
  const message = text(shape.message) ?? text(shape.error)
  const status = text(shape.status)
  const code = text(shape.code)
  const label = text(shape.name) ?? text(shape.type)

  const parts: string[] = []
  if (label !== undefined) parts.push(label)
  if (status !== undefined) parts.push(`HTTP ${status}${text(shape.statusText) === undefined ? '' : ` ${String(text(shape.statusText))}`}`)
  if (code !== undefined) parts.push(`code ${code}`)
  if (message !== undefined) parts.push(message)
  if (parts.length > 0) return parts.join(' · ')

  // Nothing recognisable: show the shape rather than hide it.
  try {
    const json = JSON.stringify(error)
    if (typeof json === 'string' && json !== '{}' && json.length <= 400) return json
    if (typeof json === 'string' && json.length > 400) return `${json.slice(0, 400)}…`
  } catch {
    // Circular or non-serialisable; fall through.
  }
  const keys = Object.keys(error)
  return keys.length === 0 ? 'unknown error object' : `unknown error with keys: ${keys.slice(0, 8).join(', ')}`
}
