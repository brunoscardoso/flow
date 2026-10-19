/**
 * ARE THE BROWSER'S TIMESTAMPS THE SAME CLOCK AS THE HOST'S?
 *
 * This is the assumption the debug-session feature rests on: it correlates
 * browser activity with terminal output by sorting on `ts`, and terminal
 * stamps come from main's `Date.now()`. If the browser's numbers are a
 * different kind of number, the timeline is wrong AND LOOKS RIGHT, which is the
 * worst failure available — so it is pinned here rather than assumed.
 *
 * It is not obvious from the code. `cdp-capture.ts` fills `ts` from THREE
 * sources with THREE different conversions:
 *
 *   Runtime.consoleAPICalled  → params.timestamp        (already ms)
 *   Log.entryAdded            → entry.timestamp         (already ms)
 *   Network.requestWillBeSent → params.wallTime * 1000  (SECONDS → ms)
 *
 * All three land on epoch milliseconds today. One edit to the third — CDP also
 * offers `params.timestamp` there, which is monotonic-since-an-arbitrary-origin
 * — would silently shift network entries by the machine's uptime.
 */
import { test, expect } from '../fixtures/electron'
import { resolve } from 'node:path'

/** How far apart two readings of the same clock may be, taken seconds apart. */
const SAME_CLOCK_TOLERANCE_MS = 60_000

test('browser capture timestamps are epoch ms on the host clock', async ({ window }) => {
  test.setTimeout(300_000)
  const page = `file://${resolve('e2e/fixtures/pages/clock-probe.html')}`

  await window.evaluate((url: string) => {
    document.dispatchEvent(new CustomEvent('flow:open-browser', { detail: { url } }))
  }, page)
  await expect(window.locator('webview')).toBeVisible({ timeout: 60_000 })
  await window.waitForTimeout(4000)

  // A request fired LONG AFTER load. The page's own inline fetch races the
  // debugger attaching to the guest and is regularly lost — see the second
  // assertion below, which is the other half of what this spec records.
  const firedAt = (await window.evaluate(async () => {
    const view = document.querySelector('webview') as unknown as {
      executeJavaScript(code: string): Promise<unknown>
    } | null
    if (view === null) return 0
    const at = Date.now()
    await view.executeJavaScript(
      `fetch('http://127.0.0.1:8099/late').catch(() => {}); 1`,
    )
    return at
  })) as number
  expect(firedAt, 'the probe never fired a request').toBeGreaterThan(0)
  await window.waitForTimeout(4000)

  const seen = await window.evaluate(async () => {
    const flow = (window as unknown as { flow: Record<string, any> }).flow
    const read = async (kind: string): Promise<{ ts: number; what: string }[]> => {
      const rows = await flow.browser.bufferSlice({ kind, selector: { mode: 'last-n', n: 30 } })
      return (rows ?? []).map((r: any) => ({
        ts: Number(r?.payload?.ts ?? 0),
        what: String(r?.payload?.text ?? r?.payload?.url ?? ''),
      }))
    }
    return { hostNow: Date.now(), console: await read('console'), network: await read('network') }
  })

  // ── THE POSITIVE FIRST (allowed-pattern #28) ────────────────────────────
  // Both kinds captured something, so a tolerance that passes over an empty
  // list cannot be mistaken for agreement.
  const marker = seen.console.find((row) => row.what.includes('CLOCK_PROBE console at'))
  expect(marker, `no console capture: ${JSON.stringify(seen.console)}`).toBeDefined()
  const late = seen.network.find((row) => row.what.includes('/late'))
  expect(late, `no network capture: ${JSON.stringify(seen.network)}`).toBeDefined()

  // ── CONSOLE: the page printed its OWN Date.now() into the message ────────
  // so this compares the captured stamp with the page's clock directly, not
  // with a tolerance around the host's.
  const printed = Number(/CLOCK_PROBE console at (\d+)/.exec(marker!.what)?.[1] ?? 0)
  expect(printed).toBeGreaterThan(0)
  expect(
    Math.abs(marker!.ts - printed),
    'console ts is not the page’s own epoch clock',
  ).toBeLessThan(1000)

  // ── NETWORK: the `wallTime * 1000` conversion, against the host clock ────
  expect(
    Math.abs(late!.ts - firedAt),
    `network ts is not host epoch ms — fired ${firedAt}, captured ${late!.ts}`,
  ).toBeLessThan(SAME_CLOCK_TOLERANCE_MS)

  // …and it is epoch, not monotonic-since-boot: a monotonic value is uptime in
  // seconds, orders of magnitude below epoch ms, so this catches the one edit
  // that would break the feature silently.
  expect(late!.ts).toBeGreaterThan(1_600_000_000_000)

  // ── AND THE GAP WORTH KNOWING ───────────────────────────────────────────
  // The page's own load-time fetch (to the same host, from the inline script)
  // is NOT here: capture attaches after the guest's first requests. A debug
  // session that needs a page load in its window has to cause the load itself,
  // after starting.
  expect(
    seen.network.some((row) => row.what.includes('/clock-probe')),
    'load-time requests are captured now — the session can stop forcing a reload',
  ).toBe(false)
})
