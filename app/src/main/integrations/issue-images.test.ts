import {
  imagesFromJiraFields,
  imagesFromMarkdown,
  imagesFromHtml,
  imageHostAllowed,
  isImageContentType,
  MAX_ISSUE_IMAGES,
} from './issue-images'

describe('imagesFromJiraFields', () => {
  it('keeps image attachments and names them by filename', () => {
    expect(
      imagesFromJiraFields({
        attachment: [
          { filename: 'crash.png', mimeType: 'image/png', content: 'https://s/a/1' },
          { filename: 'log.txt', mimeType: 'text/plain', content: 'https://s/a/2' },
        ],
      }),
    ).toEqual([{ url: 'https://s/a/1', name: 'crash.png' }])
  })

  it('trusts the tracker\'s MIME type over the filename, in both directions', () => {
    const images = imagesFromJiraFields({
      attachment: [
        // A .png the tracker calls a binary blob is not drawn as one …
        { filename: 'trap.png', mimeType: 'application/octet-stream', content: 'https://s/a/1' },
        // … and a typed image with no extension still is.
        { filename: 'pasted-image', mimeType: 'image/jpeg', content: 'https://s/a/2' },
      ],
    })
    expect(images).toEqual([{ url: 'https://s/a/2', name: 'pasted-image' }])
  })

  it('falls back to the extension only when the tracker named no type', () => {
    expect(
      imagesFromJiraFields({ attachment: [{ filename: 'shot.PNG', content: 'https://s/a/1' }] }),
    ).toEqual([{ url: 'https://s/a/1', name: 'shot.PNG' }])
  })

  it('is empty for an issue whose attachment field was never requested', () => {
    expect(imagesFromJiraFields({ summary: 'no attachment key here' })).toEqual([])
    expect(imagesFromJiraFields(null)).toEqual([])
  })

  it('caps a ticket with an absurd number of attachments', () => {
    const attachment = Array.from({ length: 40 }, (_, i) => ({
      filename: `s${String(i)}.png`,
      mimeType: 'image/png',
      content: `https://s/a/${String(i)}`,
    }))
    expect(imagesFromJiraFields({ attachment })).toHaveLength(MAX_ISSUE_IMAGES)
  })
})

describe('imagesFromMarkdown', () => {
  it('reads both spellings GitHub accepts, in order', () => {
    const body = [
      'Steps:',
      '![the crash](https://github.com/user-attachments/assets/abc)',
      '<img width="600" alt="after the fix" src="https://github.com/user-attachments/assets/def">',
    ].join('\n')
    expect(imagesFromMarkdown(body)).toEqual([
      { url: 'https://github.com/user-attachments/assets/abc', name: 'the crash' },
      { url: 'https://github.com/user-attachments/assets/def', name: 'after the fix' },
    ])
  })

  it('names an unlabelled image from its filename, never blank', () => {
    expect(imagesFromMarkdown('![](https://x/y/screen%20shot.png)')).toEqual([
      { url: 'https://x/y/screen%20shot.png', name: 'screen shot.png' },
    ])
  })

  it('falls back to an ordinal when the address has no filename either', () => {
    expect(imagesFromMarkdown('![](https://x/)')[0]?.name).toBe('Image 1')
  })

  it('counts the same screenshot linked twice as one picture', () => {
    const body = '![a](https://x/s.png)\n\n…and again: ![b](https://x/s.png)'
    expect(imagesFromMarkdown(body)).toEqual([{ url: 'https://x/s.png', name: 'a' }])
  })

  it('leaves ordinary links alone — only an image is an image', () => {
    expect(imagesFromMarkdown('see [the design](https://x/d.png) for details')).toEqual([])
  })

  it('takes a markdown title after the URL without swallowing it into the address', () => {
    expect(imagesFromMarkdown('![a](https://x/s.png "a title")')).toEqual([
      { url: 'https://x/s.png', name: 'a' },
    ])
  })
})

describe('imagesFromHtml (Azure descriptions)', () => {
  it('reads the src and alt of every img tag', () => {
    const html =
      '<div>Repro:<br><img src="https://dev.azure.com/o/p/_apis/wit/attachments/g?fileName=a.png" alt="the tile"></div>'
    expect(imagesFromHtml(html)).toEqual([
      {
        url: 'https://dev.azure.com/o/p/_apis/wit/attachments/g?fileName=a.png',
        name: 'the tile',
      },
    ])
  })

  it('names an alt-less img from its path, not from its query string', () => {
    expect(
      imagesFromHtml('<img src="https://dev.azure.com/o/p/_apis/wit/attachments/g?fileName=a.png">')[0]
        ?.name,
    ).toBe('g')
  })
})

describe('imageHostAllowed — the one security decision', () => {
  it('lets a Jira image through only on the CONNECTED site', () => {
    const host = { provider: 'jira', site: 'acme.atlassian.net' } as const
    expect(imageHostAllowed(host, 'https://acme.atlassian.net/rest/api/3/attachment/content/1')).toBe(
      true,
    )
    // The exact leak `fetchJira` refuses for issue reads, one step further out:
    // a ticket body naming another Atlassian site is still somebody else's.
    expect(imageHostAllowed(host, 'https://evil.atlassian.net/rest/api/3/attachment/content/1')).toBe(
      false,
    )
  })

  it('refuses a Jira image when no site is connected', () => {
    expect(imageHostAllowed({ provider: 'jira', site: '' }, 'https://acme.atlassian.net/x')).toBe(
      false,
    )
    expect(imageHostAllowed({ provider: 'jira', site: null }, 'https://acme.atlassian.net/x')).toBe(
      false,
    )
  })

  it('allows GitHub\'s own asset hosts and nothing else', () => {
    const host = { provider: 'github' } as const
    expect(imageHostAllowed(host, 'https://github.com/user-attachments/assets/abc')).toBe(true)
    expect(imageHostAllowed(host, 'https://objects.githubusercontent.com/x')).toBe(true)
    expect(imageHostAllowed(host, 'https://raw.githubusercontent.com/o/r/main/a.png')).toBe(true)
    // A ticket author's own tracker pixel — the reason this function exists.
    expect(imageHostAllowed(host, 'https://tracker.example.com/beacon.png')).toBe(false)
    // A lookalike that merely ENDS in the allowed name.
    expect(imageHostAllowed(host, 'https://evilgithub.com/a.png')).toBe(false)
    expect(imageHostAllowed(host, 'https://github.com.evil.net/a.png')).toBe(false)
  })

  it('allows Azure DevOps and its legacy host', () => {
    const host = { provider: 'azure' } as const
    expect(imageHostAllowed(host, 'https://dev.azure.com/o/p/_apis/wit/attachments/g')).toBe(true)
    expect(imageHostAllowed(host, 'https://acme.visualstudio.com/x')).toBe(true)
    expect(imageHostAllowed(host, 'https://notazure.com/x')).toBe(false)
  })

  it('refuses plain http — a Basic header must not travel in the clear', () => {
    expect(imageHostAllowed({ provider: 'github' }, 'http://github.com/a.png')).toBe(false)
  })

  it('refuses a URL carrying userinfo, whatever host it appears to name', () => {
    expect(imageHostAllowed({ provider: 'github' }, 'https://user:pw@github.com/a.png')).toBe(false)
  })

  it('refuses anything that is not a URL at all', () => {
    expect(imageHostAllowed({ provider: 'github' }, 'not a url')).toBe(false)
    expect(imageHostAllowed({ provider: 'github' }, '/relative/a.png')).toBe(false)
    expect(imageHostAllowed({ provider: 'github' }, 'data:image/png;base64,AAAA')).toBe(false)
  })
})

describe('isImageContentType', () => {
  it('accepts an image type with parameters, rejects everything else', () => {
    expect(isImageContentType('image/png')).toBe(true)
    expect(isImageContentType('image/jpeg; charset=binary')).toBe(true)
    // An HTML login page served where an image was asked for — the shape a
    // credential failure takes when the host answers 200 anyway.
    expect(isImageContentType('text/html')).toBe(false)
    expect(isImageContentType('image/svg+xml')).toBe(false)
    expect(isImageContentType(null)).toBe(false)
  })
})
