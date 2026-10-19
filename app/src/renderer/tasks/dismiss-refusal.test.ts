// A refusal must not destroy the typed reason (#1729 — the #299 rule).
//
// #dismissCard used to call close() unconditionally BEFORE inspecting
// result.ok, so a refused write (item just claimed or closed by another run,
// transient IPC failure) tore down the modal and the sentence somebody
// composed, leaving only a toast. The method is DOM/IPC glue with no pure
// seam, so this pins the order in the source the way ui-text-hygiene pins
// copy: the refusal branch returns before close() runs.
import { readFileSync } from 'fs'
import { join } from 'path'

describe('dismiss modal survives a refused write (#1729)', () => {
  const src = readFileSync(join(__dirname, 'kanban-board.ts'), 'utf8')
  const method = src.slice(src.indexOf('async #dismissCard('))
  const body = method.slice(0, method.indexOf('\n  }'))

  it('close() runs only after the ok-check; the refusal branch returns first', () => {
    const refusal = body.indexOf('if (!result.ok)')
    const closeCall = body.indexOf('close()')
    expect(refusal).toBeGreaterThan(-1)
    expect(closeCall).toBeGreaterThan(refusal)
    expect(body.slice(refusal, closeCall)).toContain('return')
  })

  it('the refusal path re-arms the form instead of toasting into the void', () => {
    expect(body).toContain('refused(result.reason')
  })
})

// Key repeat is one submit, not N (#1725 — the #311 rule). The Enter keydown
// path never consults confirm.disabled, so a held Enter fired one
// `loop close` per repeat: the first won, every follow-up surfaced "already
// closed" as an error toast over a successful dismissal. The gate is a latch
// checked INSIDE send(), where both entry paths (click and Enter) converge.
describe('dismiss submit is latched (#1725)', () => {
  const src = readFileSync(join(__dirname, 'kanban-board.ts'), 'utf8')

  it('send() bails on the latch before anything else', () => {
    const send = src.slice(src.indexOf('let submitting = false'))
    const body = send.slice(0, send.indexOf('confirm.addEventListener'))
    expect(body).toContain('if (submitting) return')
    expect(body).toContain('submitting = true')
    // The refusal path re-opens the gate so a retry is possible (#1729).
    expect(body).toContain('submitting = false')
  })
})
