// The single capture boundary (Phase 6) — redaction + oversized-body bounding.
//
// Targets the SHARED path (`shared/browser-capture-boundary.ts`), the one code
// path both main (console/network) and renderer (element) import (allowed-pattern
// #14). Every kind must come out `redacted:true`, secrets scrubbed, oversized
// network bodies dropped with `withheld:true` (allowed-pattern #18), and the
// input capture must never be mutated (forbidden-pattern #4).

import {
  MAX_BODY_CHARS,
  REDACTED,
  redactAndBound,
  redactSecrets,
} from './browser-capture-boundary'
import type {
  BrowserConsoleCapture,
  BrowserElementCapture,
  BrowserNetworkCapture,
} from './browser-capture-types'

// A representative secret of each shape the redactor knows.
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36'
const GH_TOKEN = 'ghp_1234567890abcdefghij0123'
const STRIPE_KEY = 'sk_live_abcdefghijklmnop1234'

function element(overrides: Partial<BrowserElementCapture> = {}): BrowserElementCapture {
  return {
    kind: 'element',
    id: 'el-1',
    componentPath: 'App > Sidebar > NavItem',
    redacted: false,
    payload: {
      componentPath: 'App > Sidebar > NavItem',
      selector: 'nav > a.active',
      domSummary: `a token=${GH_TOKEN} sat here`,
      props: { title: 'Home', authHeader: `Bearer ${JWT}` },
    },
    ...overrides,
  }
}

function consoleCapture(
  overrides: Partial<BrowserConsoleCapture> = {},
): BrowserConsoleCapture {
  return {
    kind: 'console',
    id: 'con-1',
    componentPath: 'console.error',
    redacted: false,
    payload: {
      level: 'error',
      text: `login failed with apiKey=${STRIPE_KEY}`,
      stack: `at auth (app.js:1:1) token ${JWT}`,
      ts: 1000,
    },
    ...overrides,
  }
}

function network(overrides: Partial<BrowserNetworkCapture> = {}): BrowserNetworkCapture {
  return {
    kind: 'network',
    id: 'net-1',
    componentPath: 'POST /api/login',
    redacted: false,
    payload: {
      method: 'POST',
      url: 'http://localhost:3000/api/login',
      status: 200,
      timingMs: 42,
      requestHeaders: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${JWT}`,
        Cookie: 'session=abc123',
      },
      responseHeaders: { 'Set-Cookie': 'session=def456; HttpOnly' },
      requestBody: `{"password":"hunter2","token":"${GH_TOKEN}"}`,
      responseBody: '{"ok":true}',
      ts: 2000,
    },
    ...overrides,
  }
}

describe('redactSecrets', () => {
  it('masks assignment values but keeps the key visible', () => {
    expect(redactSecrets('apiKey=sk_live_abcdefghijklmnop1234')).toBe(`apiKey=${REDACTED}`)
  })

  it('masks a Bearer token, keeping the scheme word visible', () => {
    // No `authorization:` prefix here — that would trip the assignment rule and
    // redact the word "Bearer" itself. This isolates the Bearer-scheme rule.
    expect(redactSecrets('Bearer mytokenvalue')).toBe(`Bearer ${REDACTED}`)
  })

  it('masks standalone token shapes (JWT, GitHub PAT)', () => {
    expect(redactSecrets(`x ${JWT} y`)).toBe(`x ${REDACTED} y`)
    expect(redactSecrets(`x ${GH_TOKEN} y`)).toBe(`x ${REDACTED} y`)
  })

  it('is idempotent — re-running over redacted text is a no-op', () => {
    const once = redactSecrets(`token ${JWT}`)
    expect(redactSecrets(once)).toBe(once)
  })

  it('leaves an empty string untouched', () => {
    expect(redactSecrets('')).toBe('')
  })
})

describe('redactAndBound — element', () => {
  it('redacts domSummary and every prop value', () => {
    const out = redactAndBound(element()) as BrowserElementCapture
    expect(out.payload.domSummary).toBe(`a token=${REDACTED} sat here`)
    expect(out.payload.props?.authHeader).toBe(`Bearer ${REDACTED}`)
    expect(out.payload.props?.title).toBe('Home') // benign value survives
    expect(out.redacted).toBe(true)
  })

  it('does not mutate the input capture (forbidden-pattern #4)', () => {
    const input = element()
    const before = JSON.parse(JSON.stringify(input))
    redactAndBound(input)
    expect(input).toEqual(before)
  })
})

describe('redactAndBound — console', () => {
  it('redacts message text and stack', () => {
    const out = redactAndBound(consoleCapture()) as BrowserConsoleCapture
    expect(out.payload.text).toBe(`login failed with apiKey=${REDACTED}`)
    expect(out.payload.stack).toBe(`at auth (app.js:1:1) token ${REDACTED}`)
    expect(out.redacted).toBe(true)
  })

  it('omits stack cleanly when there was none', () => {
    const out = redactAndBound(
      consoleCapture({ payload: { level: 'log', text: 'plain', ts: 3000 } }),
    ) as BrowserConsoleCapture
    expect(out.payload.stack).toBeUndefined()
    expect(out.redacted).toBe(true)
  })

  it('does not mutate the input capture', () => {
    const input = consoleCapture()
    const before = JSON.parse(JSON.stringify(input))
    redactAndBound(input)
    expect(input).toEqual(before)
  })
})

describe('redactAndBound — network', () => {
  it('masks sensitive header names wholesale and scrubs benign ones', () => {
    const out = redactAndBound(network()) as BrowserNetworkCapture
    expect(out.payload.requestHeaders.Authorization).toBe(REDACTED)
    expect(out.payload.requestHeaders.Cookie).toBe(REDACTED)
    expect(out.payload.responseHeaders['Set-Cookie']).toBe(REDACTED)
    expect(out.payload.requestHeaders['Content-Type']).toBe('application/json')
    expect(out.redacted).toBe(true)
  })

  it('redacts secrets inside request/response bodies', () => {
    const out = redactAndBound(network()) as BrowserNetworkCapture
    expect(out.payload.requestBody).not.toContain(GH_TOKEN)
    expect(out.payload.requestBody).toContain('"token":"[redacted]"')
    expect(out.payload.responseBody).toBe('{"ok":true}')
  })

  it('withholds an oversized body: withheld:true and the body is DROPPED', () => {
    const big = 'a'.repeat(MAX_BODY_CHARS + 1)
    const out = redactAndBound(
      network({
        payload: {
          method: 'GET',
          url: 'http://localhost:3000/big',
          status: 200,
          timingMs: 5,
          requestHeaders: {},
          responseHeaders: {},
          responseBody: big,
          ts: 4000,
        },
      }),
    ) as BrowserNetworkCapture
    expect(out.withheld).toBe(true)
    expect(out.payload.responseBody).toBeUndefined() // dropped, never rendered empty
    expect(out.redacted).toBe(true)
  })

  it('keeps a body exactly at the limit (boundary is > not >=)', () => {
    // `'a '` repeated: exactly MAX_BODY_CHARS chars, but broken by spaces so no
    // 40+ char run trips the base64/hex redactor — the body survives verbatim.
    const atLimit = 'a '.repeat(MAX_BODY_CHARS / 2)
    const out = redactAndBound(
      network({
        payload: {
          method: 'GET',
          url: 'http://localhost:3000/edge',
          status: 200,
          timingMs: 5,
          requestHeaders: {},
          responseHeaders: {},
          responseBody: atLimit,
          ts: 5000,
        },
      }),
    ) as BrowserNetworkCapture
    expect(out.withheld).toBeUndefined()
    expect(out.payload.responseBody).toBe(atLimit)
  })

  it('does not mutate the input capture, even when withholding', () => {
    const input = network({
      payload: {
        method: 'GET',
        url: 'http://localhost:3000/big',
        status: 200,
        timingMs: 5,
        requestHeaders: { Authorization: `Bearer ${JWT}` },
        responseHeaders: {},
        responseBody: 'a'.repeat(MAX_BODY_CHARS + 1),
        ts: 6000,
      },
    })
    const before = JSON.parse(JSON.stringify(input))
    redactAndBound(input)
    expect(input).toEqual(before)
  })
})

describe('redactAndBound — the one path for all three kinds', () => {
  it('always sets redacted:true regardless of kind', () => {
    for (const capture of [element(), consoleCapture(), network()]) {
      expect(redactAndBound(capture).redacted).toBe(true)
    }
  })

  it('returns a NEW object for every kind (never the same reference)', () => {
    for (const capture of [element(), consoleCapture(), network()]) {
      expect(redactAndBound(capture)).not.toBe(capture)
    }
  })
})
