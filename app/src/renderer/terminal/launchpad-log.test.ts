import { PROJECT_HUE_COUNT } from '../project-accent'
import { LaunchpadLog, MAX_PARTIAL_CHARS, stepColourSlot, stripAnsi } from './launchpad-log'

const text = (log: LaunchpadLog): Array<[string, string]> => log.lines().map((line) => [line.source, line.text])

describe('stripAnsi', () => {
  it('removes colours, cursor moves, titles and links, and keeps the words', () => {
    expect(stripAnsi('\x1b[32mVITE\x1b[0m ready in \x1b[1m812\x1b[22m ms')).toBe('VITE ready in 812 ms')
    expect(stripAnsi('\x1b[2K\x1b[1Gdone')).toBe('done')
    expect(stripAnsi('\x1b]0;my title\x07prompt')).toBe('prompt')
    expect(stripAnsi('\x1b]8;;http://localhost:5173/\x1b\\link\x1b]8;;\x1b\\')).toBe('link')
    expect(stripAnsi('a\x07b\x08c')).toBe('abc')
    expect(stripAnsi('tab\there')).toBe('tab\there')
  })
})

describe('LaunchpadLog', () => {
  it('splits chunks into lines, in arrival order across steps', () => {
    const log = new LaunchpadLog()
    log.push('web', 'VITE ready\r\nLocal: http://localhost:5173/\r\n')
    log.push('api', 'INFO started\n')
    log.push('web', '[hmr] update\n')
    expect(text(log)).toEqual([
      ['web', 'VITE ready'],
      ['web', 'Local: http://localhost:5173/'],
      ['api', 'INFO started'],
      ['web', '[hmr] update'],
    ])
    expect(log.lines().map((line) => line.seq)).toEqual([0, 1, 2, 3])
  })

  it('a line split across chunks is joined; each step keeps its own unfinished line', () => {
    const log = new LaunchpadLog()
    log.push('web', 'hel')
    log.push('api', 'wor')
    expect(log.size).toBe(0)
    log.push('web', 'lo\nnext')
    log.push('api', 'ld\n')
    expect(text(log)).toEqual([
      ['web', 'hello'],
      ['api', 'world'],
    ])
    log.push('web', '\n')
    expect(text(log)[2]).toEqual(['web', 'next'])
  })

  it('strips colour codes from each line, and a progress line keeps what it last drew', () => {
    const log = new LaunchpadLog()
    log.push('w', '\x1b[31merror\x1b[0m\n')
    log.push('w', '10%\r50%\r100%\n')
    log.push('w', 'done\r\n')
    expect(text(log)).toEqual([
      ['w', 'error'],
      ['w', '100%'],
      ['w', 'done'],
    ])
  })

  it('keeps only the newest lines, across every step', () => {
    const log = new LaunchpadLog(3)
    for (let i = 0; i < 10; i += 1) log.push(i % 2 === 0 ? 'a' : 'b', `line ${i}\n`)
    expect(log.size).toBe(3)
    expect(text(log)).toEqual([
      ['b', 'line 7'],
      ['a', 'line 8'],
      ['b', 'line 9'],
    ])
    expect(log.firstSeq).toBe(7)
    expect(log.nextSeq).toBe(10)
    expect(log.since(9).map((line) => line.text)).toEqual(['line 9'])
    expect(log.since(0).map((line) => line.text)).toEqual(['line 7', 'line 8', 'line 9'])
    expect(log.since(10)).toEqual([])
  })

  it('stays bounded over a long run', () => {
    const log = new LaunchpadLog(2_000)
    for (let i = 0; i < 25_000; i += 1) log.push('s', `${i}\n`)
    expect(log.size).toBe(2_000)
    expect(log.lines()[0].text).toBe('23000')
    expect(log.lines()[1_999].text).toBe('24999')
  })

  it('a step that never prints a newline cannot grow its unfinished line without bound', () => {
    const log = new LaunchpadLog()
    log.push('s', 'x'.repeat(MAX_PARTIAL_CHARS * 2 + 10))
    expect(log.size).toBe(2)
    expect(log.lines()[0].text).toHaveLength(MAX_PARTIAL_CHARS)
    log.push('s', '\n')
    expect(log.lines()[2].text).toHaveLength(10)
  })

  it('forget drops a step’s unfinished line', () => {
    const log = new LaunchpadLog()
    log.push('s', 'half')
    log.forget('s')
    log.push('s', 'new\n')
    expect(text(log)).toEqual([['s', 'new']])
  })

  it('an empty log reports nothing kept', () => {
    const log = new LaunchpadLog()
    expect(log.size).toBe(0)
    expect(log.firstSeq).toBe(0)
    expect(log.lines()).toEqual([])
  })
})

describe('stepColourSlot', () => {
  it('a step’s colour follows its place in step order, stable as other steps’ lines arrive', () => {
    const keys = ['app-dev', 'core-dev', 'temporal-dev', 'temporal-worker']
    expect(keys.map((key) => stepColourSlot(keys, key))).toEqual([0, 1, 2, 3])
    expect(stepColourSlot(keys, 'core-dev')).toBe(stepColourSlot([...keys], 'core-dev'))
    expect(stepColourSlot(keys, 'missing')).toBe(-1)
  })

  it('wraps after the palette', () => {
    const keys = Array.from({ length: PROJECT_HUE_COUNT + 2 }, (_, i) => `s${i}`)
    expect(stepColourSlot(keys, `s${PROJECT_HUE_COUNT}`)).toBe(0)
    expect(stepColourSlot(keys, `s${PROJECT_HUE_COUNT + 1}`)).toBe(1)
  })
})
