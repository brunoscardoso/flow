import { brainSearchPresentation, toolIcon } from './tool-card-model'

const bashInput = (command: string): string => JSON.stringify({ command })

describe('brainSearchPresentation', () => {
  it('renders a brain-search Bash call as Knowledge search with the query as summary', () => {
    expect(
      brainSearchPresentation(
        'Bash',
        bashInput('planflow-ai brain search "chat membership retrieval" 2>/dev/null || echo "NO_BRAIN_CLI"'),
      ),
    ).toEqual({
      icon: 'brain',
      label: 'Knowledge search',
      summary: 'chat membership retrieval',
    })
  })

  it('appends the scope to the summary when --scope is given', () => {
    expect(
      brainSearchPresentation('Bash', bashInput('planflow-ai brain search "learn session" --scope resources')),
    ).toEqual({
      icon: 'brain',
      label: 'Knowledge search',
      summary: 'learn session · resources',
    })
  })

  it('leaves every other Bash call untouched', () => {
    expect(brainSearchPresentation('Bash', bashInput('planflow-ai blueprint derive'))).toBeNull()
    expect(brainSearchPresentation('Bash', bashInput('grep -rn "planflow-ai brain search" docs/'))).toBeNull()
    expect(brainSearchPresentation('Bash', bashInput('npm run build'))).toBeNull()
  })

  it('leaves non-Bash tools untouched even if their input mentions the command', () => {
    expect(
      brainSearchPresentation('Grep', JSON.stringify({ pattern: 'planflow-ai brain search' })),
    ).toBeNull()
  })

  it('tolerates missing or malformed input (running/pending cards)', () => {
    expect(brainSearchPresentation('Bash', null)).toBeNull()
    expect(brainSearchPresentation('Bash', 'not json')).toBeNull()
    expect(brainSearchPresentation('Bash', JSON.stringify({ description: 'x' }))).toBeNull()
  })
})

describe('toolIcon', () => {
  it('gives mutating file ops (write/edit/notebookedit) the pencil, distinct from read (#18)', () => {
    // The bug: all four file ops shared `file`, so a read looked like a
    // destructive edit. The three mutators must read differently from a read.
    expect(toolIcon('Write')).toBe('pencil')
    expect(toolIcon('Edit')).toBe('pencil')
    expect(toolIcon('NotebookEdit')).toBe('pencil')
    expect(toolIcon('Read')).toBe('file')
    expect(toolIcon('Read')).not.toBe(toolIcon('Edit'))
  })

  it('is case-insensitive on the tool name', () => {
    expect(toolIcon('EDIT')).toBe('pencil')
    expect(toolIcon('read')).toBe('file')
  })

  it('keeps non-mutating lookups on the search glyph', () => {
    expect(toolIcon('Glob')).toBe('search')
    expect(toolIcon('Grep')).toBe('search')
  })

  it('falls back to dot for an unmapped tool', () => {
    expect(toolIcon('SomeFutureTool')).toBe('dot')
  })
})
