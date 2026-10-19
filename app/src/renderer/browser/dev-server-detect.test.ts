// Dev-server detection for the embedded browser tab's initial target — pure
// logic, no DOM. It reuses the terminal link detector (allowed-pattern #14: one
// code path for "what is a URL") to find a printed loopback URL, and falls back
// to a common port when nothing was printed.

import {
  COMMON_DEV_PORTS,
  detectDevServerUrl,
  detectDevServerUrlFromOutput,
} from './dev-server-detect'

describe('detectDevServerUrlFromOutput', () => {
  it('parses a printed "Local: http://localhost:5173" line', () => {
    expect(detectDevServerUrlFromOutput('  Local:   http://localhost:5173/')).toBe(
      'http://localhost:5173/',
    )
  })

  it('accepts 127.0.0.1 as loopback', () => {
    expect(detectDevServerUrlFromOutput('Network: http://127.0.0.1:8080/app')).toBe(
      'http://127.0.0.1:8080/app',
    )
  })

  it('ignores a non-loopback URL (a docs link is not a dev server)', () => {
    expect(detectDevServerUrlFromOutput('See https://docs.example.com/guide')).toBeNull()
  })

  it('scans multiple lines and returns the first loopback URL', () => {
    const output = [
      'vite v5 building...',
      '  ➜  Network: https://docs.example.com',
      '  ➜  Local:   http://localhost:4321/',
    ].join('\n')
    expect(detectDevServerUrlFromOutput(output)).toBe('http://localhost:4321/')
  })

  it('returns null when nothing URL-like was printed', () => {
    expect(detectDevServerUrlFromOutput('starting server, please wait')).toBeNull()
  })
})

describe('detectDevServerUrl', () => {
  it('prefers a printed loopback URL over the fallback port', () => {
    expect(detectDevServerUrl({ printedOutput: 'Local: http://localhost:5173' })).toBe(
      'http://localhost:5173',
    )
  })

  it('falls back to the first common port when nothing was printed', () => {
    expect(detectDevServerUrl({})).toBe(`http://localhost:${COMMON_DEV_PORTS[0]}`)
    expect(detectDevServerUrl()).toBe('http://localhost:3000')
  })

  it('falls back when the printed output has no loopback URL', () => {
    expect(detectDevServerUrl({ printedOutput: 'See https://docs.example.com' })).toBe(
      'http://localhost:3000',
    )
  })

  it('honours a custom port list', () => {
    expect(detectDevServerUrl({ ports: [4000, 5000] })).toBe('http://localhost:4000')
  })

  it('returns null only when there is nothing printed and no ports', () => {
    expect(detectDevServerUrl({ ports: [] })).toBeNull()
  })
})
