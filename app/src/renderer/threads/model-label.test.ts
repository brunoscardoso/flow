import { modelLabel } from './model-label'

describe('modelLabel (#129)', () => {
  it('labels current model snapshots with their version', () => {
    expect(modelLabel('claude-opus-4-8')).toBe('Opus 4.8')
    expect(modelLabel('claude-sonnet-5')).toBe('Sonnet 5')
    expect(modelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(modelLabel('claude-fable-5')).toBe('Fable 5')
  })

  it('drops a trailing date snapshot instead of using it as a version (#1126)', () => {
    // Date snapshot must not become a minor version…
    expect(modelLabel('claude-opus-4-20250514')).toBe('Opus 4')
    // …nor the major version when the id has no numeric version after the family.
    expect(modelLabel('claude-3-5-sonnet-20241022')).toBe('Sonnet 3.5')
    expect(modelLabel('claude-3-7-sonnet-20250219')).toBe('Sonnet 3.7')
  })

  it('labels bare aliases without a version', () => {
    expect(modelLabel('opus')).toBe('Opus')
    expect(modelLabel('sonnet')).toBe('Sonnet')
    expect(modelLabel('haiku')).toBe('Haiku')
  })

  it('maps auto / empty to Auto', () => {
    expect(modelLabel('auto')).toBe('Auto')
    expect(modelLabel(null)).toBe('Auto')
    expect(modelLabel('')).toBe('Auto')
  })

  it('passes an unrecognized id through unchanged', () => {
    expect(modelLabel('some-future-model-x')).toBe('some-future-model-x')
  })
})

describe('a context variant is not a version', () => {
  it('keeps the minor version and names the variant', () => {
    // `[1m]` fed to the version parser made `1[1m]` a non-numeric segment, so
    // the minor was dropped and the model read one release behind what was
    // actually running.
    expect(modelLabel('claude-fable-5-1[1m]')).toBe('Fable 5.1 (1M)')
    expect(modelLabel('claude-opus-5[1m]')).toBe('Opus 5 (1M)')
  })

  it('leaves a plain id exactly as it was', () => {
    expect(modelLabel('claude-opus-5')).toBe('Opus 5')
    expect(modelLabel('claude-fable-5-1')).toBe('Fable 5.1')
  })
})
