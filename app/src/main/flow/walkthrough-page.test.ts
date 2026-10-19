// The walkthrough page scheme's whole security decision, held without Electron:
// which URLs resolve to which file, and what a refusal answers.

import {
  WALKTHROUGH_PAGE_CSP,
  isWalkthroughPath,
  parseWalkthroughPageUrl,
  resolveWalkthroughRequest,
  serveWalkthroughPage,
  walkthroughPageUrl,
} from './walkthrough-page'
import { withTheme } from '../../shared/walkthrough-page'

const ROOT = '/Users/me/projects/pay'
const PAGE = 'flow/discovery/discovery_pay_v1.walkthrough.html'
const knownRoot = (rootPath: string): boolean => rootPath === ROOT

/** A URL built by hand, so a test can say things the builder never would. */
function rawUrl(root: string, path: string): string {
  return `flow-page://walkthrough/?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`
}

describe('isWalkthroughPath', () => {
  it('accepts a page directly inside each flow doc dir', () => {
    for (const dir of ['discovery', 'plans', 'brainstorms', 'archive']) {
      expect(isWalkthroughPath(`flow/${dir}/x_v1.walkthrough.html`)).toBe(true)
    }
  })

  it('refuses traversal, nesting, absolute paths and other dirs', () => {
    expect(isWalkthroughPath('flow/discovery/../../etc/x.walkthrough.html')).toBe(false)
    expect(isWalkthroughPath('flow/discovery/..walkthrough.html')).toBe(false)
    expect(isWalkthroughPath('flow/discovery/sub/x.walkthrough.html')).toBe(false)
    expect(isWalkthroughPath('/flow/discovery/x.walkthrough.html')).toBe(false)
    expect(isWalkthroughPath('src/x.walkthrough.html')).toBe(false)
    expect(isWalkthroughPath('flow/brain/x.walkthrough.html')).toBe(false)
    expect(isWalkthroughPath('flow/discovery/x\\..\\y.walkthrough.html')).toBe(false)
  })

  it('refuses a file that is not a walkthrough page', () => {
    expect(isWalkthroughPath('flow/discovery/discovery_pay_v1.md')).toBe(false)
    expect(isWalkthroughPath('flow/discovery/page.html')).toBe(false)
    expect(isWalkthroughPath('flow/discovery/.walkthrough.html')).toBe(false)
  })
})

describe('walkthroughPageUrl / parseWalkthroughPageUrl', () => {
  it('round-trips a root with spaces and a page path', () => {
    const url = walkthroughPageUrl('/Users/me/My Projects/pay', PAGE)
    expect(parseWalkthroughPageUrl(url)).toEqual({ root: '/Users/me/My Projects/pay', path: PAGE })
  })

  it('ignores the cache-busting version', () => {
    expect(parseWalkthroughPageUrl(walkthroughPageUrl(ROOT, PAGE, 17))).toEqual({ root: ROOT, path: PAGE })
  })

  it('refuses another scheme, another host, and missing parameters', () => {
    expect(parseWalkthroughPageUrl(rawUrl(ROOT, PAGE).replace('flow-page:', 'https:'))).toBeNull()
    expect(parseWalkthroughPageUrl(rawUrl(ROOT, PAGE).replace('//walkthrough/', '//other/'))).toBeNull()
    expect(parseWalkthroughPageUrl(`flow-page://walkthrough/?path=${encodeURIComponent(PAGE)}`)).toBeNull()
    expect(parseWalkthroughPageUrl(`flow-page://walkthrough/?root=${encodeURIComponent(ROOT)}`)).toBeNull()
    expect(parseWalkthroughPageUrl('not a url')).toBeNull()
  })
})

describe('resolveWalkthroughRequest', () => {
  it('resolves a valid page of a known root to the file inside it', () => {
    expect(resolveWalkthroughRequest(walkthroughPageUrl(ROOT, PAGE), knownRoot)).toEqual({
      ok: true,
      request: { root: ROOT, path: PAGE },
      absPath: `${ROOT}/${PAGE}`,
    })
  })

  it('refuses traversal before any root is consulted', () => {
    const asked: string[] = []
    const result = resolveWalkthroughRequest(rawUrl(ROOT, 'flow/discovery/../../../etc/passwd.walkthrough.html'), (root) => {
      asked.push(root)
      return true
    })
    expect(result).toEqual({ ok: false, reason: 'not a walkthrough page address' })
    expect(asked).toEqual([])
  })

  it('refuses a file that is not a walkthrough page', () => {
    expect(resolveWalkthroughRequest(rawUrl(ROOT, 'flow/discovery/discovery_pay_v1.md'), knownRoot).ok).toBe(false)
  })

  it('refuses an unknown root even with a valid page path', () => {
    expect(resolveWalkthroughRequest(walkthroughPageUrl('/etc', PAGE), knownRoot)).toEqual({
      ok: false,
      reason: 'unknown project root',
    })
  })
})

describe('serveWalkthroughPage', () => {
  let warn: jest.SpyInstance
  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => warn.mockRestore())

  it('serves the page as html under its own CSP', async () => {
    const reads: string[] = []
    const response = await serveWalkthroughPage(walkthroughPageUrl(ROOT, PAGE), {
      isKnownRoot: knownRoot,
      readFile: async (absPath) => {
        reads.push(absPath)
        return '<h1>Pay</h1>'
      },
    })
    expect(reads).toEqual([`${ROOT}/${PAGE}`])
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('content-security-policy')).toBe(WALKTHROUGH_PAGE_CSP)
    expect(await response.text()).toBe('<h1>Pay</h1>')
  })

  it('the CSP allows inline script and style and nothing on the network', () => {
    expect(WALKTHROUGH_PAGE_CSP).toContain("default-src 'none'")
    expect(WALKTHROUGH_PAGE_CSP).toContain("script-src 'unsafe-inline'")
    expect(WALKTHROUGH_PAGE_CSP).not.toMatch(/https?:|\*/)
  })

  it('answers a refused request with a plain 404, logs it, and reads nothing', async () => {
    const reads: string[] = []
    const response = await serveWalkthroughPage(walkthroughPageUrl('/elsewhere', PAGE), {
      isKnownRoot: knownRoot,
      readFile: async (absPath) => {
        reads.push(absPath)
        return 'secret'
      },
    })
    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(reads).toEqual([])
    expect(warn).toHaveBeenCalledWith('[WalkthroughPage] refused request', expect.objectContaining({ reason: 'unknown project root' }))
  })

  it('answers a missing file with a 404 and logs the failure', async () => {
    const response = await serveWalkthroughPage(walkthroughPageUrl(ROOT, PAGE), {
      isKnownRoot: knownRoot,
      readFile: async () => {
        throw new Error('ENOENT')
      },
    })
    expect(response.status).toBe(404)
    expect(warn).toHaveBeenCalledWith('[WalkthroughPage] failed to read page', expect.objectContaining({ path: PAGE }))
  })
})

describe('Flow theme handoff (2026-09-30)', () => {
  // The page is sandboxed to an opaque origin and cannot read its host, and
  // prefers-color-scheme follows the OS rather than Flow — so Flow says which
  // theme it is showing, and the server stamps it on the page.
  it('carries the theme through the URL and back', () => {
    const url = walkthroughPageUrl('/repo', 'flow/discovery/x_v1.walkthrough.html', 3, 'light')
    expect(parseWalkthroughPageUrl(url)).toEqual({ root: '/repo', path: 'flow/discovery/x_v1.walkthrough.html', theme: 'light' })
  })

  it('ignores a theme it does not know', () => {
    const url = walkthroughPageUrl('/repo', 'flow/discovery/x_v1.walkthrough.html').concat('&theme=purple')
    expect(parseWalkthroughPageUrl(url)).toEqual({ root: '/repo', path: 'flow/discovery/x_v1.walkthrough.html' })
  })

  it('stamps data-theme on the page’s <html>, replacing one the page already had', () => {
    expect(withTheme('<!doctype html><html lang="en"><body></body></html>', 'dark')).toBe(
      '<!doctype html><html lang="en" data-theme="dark"><body></body></html>',
    )
    expect(withTheme('<html data-theme="light" lang="en">', 'dark')).toBe('<html lang="en" data-theme="dark">')
  })

  it('leaves a page with no <html> tag as written', () => {
    expect(withTheme('<p>fragment</p>', 'dark')).toBe('<p>fragment</p>')
  })

  it('serves the page with the theme stamped', async () => {
    const url = walkthroughPageUrl('/repo', 'flow/discovery/x_v1.walkthrough.html', undefined, 'dark')
    const response = await serveWalkthroughPage(url, {
      isKnownRoot: () => true,
      readFile: async () => '<html><body>page</body></html>',
    })
    await expect(response.text()).resolves.toBe('<html data-theme="dark"><body>page</body></html>')
  })
})
