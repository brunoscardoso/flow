import { modePersistPayload } from './mode-persist'

describe('modePersistPayload (#229)', () => {
  it('maps autonomous → bypass true + autopilot string "true"', () => {
    expect(modePersistPayload('autonomous')).toEqual({
      onboarding: { autonomyBypassDefault: true },
      config: { autopilot: 'true' },
    })
  })

  it('maps manual → bypass false + autopilot string "false"', () => {
    expect(modePersistPayload('manual')).toEqual({
      onboarding: { autonomyBypassDefault: false },
      config: { autopilot: 'false' },
    })
  })

  it('always emits a STRING autopilot flag (flowconfig values are strings)', () => {
    expect(typeof modePersistPayload('autonomous').config.autopilot).toBe('string')
    expect(typeof modePersistPayload('manual').config.autopilot).toBe('string')
  })
})
