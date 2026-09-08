// @vitest-environment jsdom
/**
 * The plugin must DECLARE every service it reads.
 *
 * Cordis refuses a property read on an undeclared service, and the pipeline
 * control's Run button reads `conversation` through a session scope. With
 * `conversation` missing from this list the refusal surfaced only as
 * `cannot get property "conversation" without inject`, thrown inside a send
 * whose rejection nothing displayed — so the button looked dead for every run.
 * This test is the cheap guard against that regression.
 */
import { describe, expect, it } from 'vitest'
import { inject } from '../src/client/index.ts'

describe('ui-council-budget client inject', () => {
  it('declares conversation, the service the pipeline control sends through', () => {
    expect(inject).toContain('conversation')
  })

  it('still declares the services the panels read', () => {
    for (const service of ['slots', 'sessions', 'locale', 'settingsScope']) {
      expect(inject).toContain(service)
    }
  })
})
