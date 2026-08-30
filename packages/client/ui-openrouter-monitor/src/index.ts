/** Host loader entry for the browser-only OpenRouter monitor plugin. */

export type { MonitorKey } from './client/locales.ts'

/** Provides no host-side behavior; the surface lives in the client face. */
export function apply(): void {}
