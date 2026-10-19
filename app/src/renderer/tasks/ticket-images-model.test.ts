import {
  IMAGE_FETCH_CONCURRENCY,
  imageTileAction,
  imageTileCaption,
  imagesSectionLabel,
  inBatches,
} from './ticket-images-model'

describe('imagesSectionLabel', () => {
  it('counts, except when there is nothing to count', () => {
    expect(imagesSectionLabel(1)).toBe('Image')
    expect(imagesSectionLabel(4)).toBe('Images (4)')
  })
})

describe('imageTileCaption', () => {
  it('keeps the picture\'s name in every state, including the failure', () => {
    expect(imageTileCaption('crash.png', { kind: 'loading' })).toBe('Loading crash.png…')
    expect(imageTileCaption('crash.png', { kind: 'ready', dataUri: 'data:', bytes: 1 })).toBe(
      'crash.png',
    )
    // A ticket with six screenshots needs to say WHICH one is missing.
    expect(
      imageTileCaption('crash.png', { kind: 'failed', reason: 'the attachment is gone' }),
    ).toBe('crash.png — the attachment is gone')
  })
})

describe('imageTileAction', () => {
  it('promises a press only when there is something to open', () => {
    expect(imageTileAction('a.png', { kind: 'ready', dataUri: 'data:', bytes: 1 })).toBe(
      'Open a.png full size',
    )
    expect(imageTileAction('a.png', { kind: 'loading' })).toBe('a.png is still loading')
    expect(imageTileAction('a.png', { kind: 'failed', reason: 'x' })).toBe(
      'a.png could not be loaded',
    )
  })
})

describe('inBatches', () => {
  it('never has more than the limit in flight — the fact the comment claims', async () => {
    let inFlight = 0
    let peak = 0
    const settle: (() => void)[] = []
    const items = Array.from({ length: 9 }, (_, i) => i)
    const done = inBatches(items, IMAGE_FETCH_CONCURRENCY, async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise<void>((resolve) => settle.push(resolve))
      inFlight -= 1
    })
    // Drain: every started task finishes, which starts the next.
    for (let round = 0; round < items.length + 2; round += 1) {
      await Promise.resolve()
      settle.splice(0).forEach((resolve) => {
        resolve()
      })
      await Promise.resolve()
    }
    await done
    expect(peak).toBe(IMAGE_FETCH_CONCURRENCY)
  })

  it('visits every item exactly once, in order', async () => {
    const seen: number[] = []
    await inBatches([1, 2, 3, 4, 5], 2, async (item) => {
      seen.push(item)
      await Promise.resolve()
    })
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
  })

  it('is a no-op on nothing, rather than spawning an idle runner', async () => {
    const work = jest.fn()
    await inBatches([], 3, work)
    expect(work).not.toHaveBeenCalled()
  })

  it('runs a single item once even when the limit is larger than the list', async () => {
    const seen: string[] = []
    await inBatches(['only'], 5, async (item) => {
      seen.push(item)
      await Promise.resolve()
    })
    expect(seen).toEqual(['only'])
  })
})
