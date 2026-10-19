import { fileUrl, opensInBrowser } from './file-path'

describe('opensInBrowser — which files the browser is the better tab for', () => {
  it('claims generated pages', () => {
    for (const path of ['docs/playbook-output-contract.html', 'a.HTM', 'out/index.html?v=2']) {
      expect(opensInBrowser(path)).toBe(true)
    }
  })

  it('leaves everything people open to edit alone', () => {
    // Markdown has its own preview; the rest are source.
    for (const path of ['README.md', 'src/app.ts', 'a.htmlx', 'styles.css', 'index.html.ts']) {
      expect(opensInBrowser(path)).toBe(false)
    }
  })
})

describe('fileUrl — a path a browser can load', () => {
  it('builds a file URL from a root and a relative path', () => {
    expect(fileUrl('/Users/me/orbit-app', 'docs/contract.html')).toBe(
      'file:///Users/me/orbit-app/docs/contract.html',
    )
  })

  it('encodes the PARTS and not the separators', () => {
    // A folder called `design #2` truncates at the `#` unencoded, and the
    // browser loads its parent directory instead of the page.
    expect(fileUrl('/Users/me/my project', 'design #2/index.html')).toBe(
      'file:///Users/me/my%20project/design%20%232/index.html',
    )
  })

  it('does not care how the caller punctuated the join', () => {
    expect(fileUrl('/repo/', '/docs/a.html')).toBe('file:///repo/docs/a.html')
  })
})
