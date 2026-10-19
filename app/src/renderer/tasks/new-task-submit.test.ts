import {
  canSubmit,
  createErrorMessage,
  planManualSubmit,
  skipPermissionsFailedToast,
  startTaskFailedToast,
} from './new-task-submit'

describe('canSubmit (#311)', () => {
  it('proceeds only when not already in flight and the required field is present', () => {
    expect(canSubmit(false, true)).toBe(true)
  })

  it('blocks a re-entrant submit while a create/import is in flight — even with input', () => {
    // The Enter-key double-submit vector: title still has a value, but a create is pending.
    expect(canSubmit(true, true)).toBe(false)
  })

  it('blocks an empty required field', () => {
    expect(canSubmit(false, false)).toBe(false)
    expect(canSubmit(true, false)).toBe(false)
  })
})

describe('planManualSubmit (#299)', () => {
  it('closes the modal only on success', () => {
    expect(planManualSubmit({ ok: true })).toEqual({ close: true, inlineError: null })
  })

  it('keeps the modal open with an inline error on failure — so typed input survives', () => {
    expect(planManualSubmit({ ok: false, error: new Error('store is busy') })).toEqual({
      close: false,
      inlineError: 'store is busy',
    })
  })
})

describe('createErrorMessage (#299)', () => {
  it('uses an Error message, passes a string through, and avoids "[object Object]"', () => {
    expect(createErrorMessage(new Error('disk full'))).toBe('disk full')
    expect(createErrorMessage('IPC closed')).toBe('IPC closed')
    expect(createErrorMessage({})).toBe('Unknown error')
  })
})

describe('auto-start failure toasts (#297)', () => {
  it('startTaskFailedToast names the error and points to resending in the thread', () => {
    const toast = startTaskFailedToast(new Error('session not ready'))
    expect(toast.title).toBe('Could not start task')
    expect(toast.body).toContain('session not ready')
    expect(toast.body).toMatch(/resend/i)
  })

  it('skipPermissionsFailedToast explains the fail-safe (prompts stay on)', () => {
    const toast = skipPermissionsFailedToast(new Error('store locked'))
    expect(toast.title).toBe("Couldn't skip permission prompts")
    expect(toast.body).toContain('store locked')
    expect(toast.body).toMatch(/approve/i)
  })
})
