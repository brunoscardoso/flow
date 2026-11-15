import { modePersistPayload } from './mode-persist'

describe('modePersistPayload', () => {
  it("maps Don't ask → bypass true", () => {
    expect(modePersistPayload('autonomous')).toEqual({ onboarding: { autonomyBypassDefault: true } })
  })

  it('maps Ask me first → bypass false', () => {
    expect(modePersistPayload('manual')).toEqual({ onboarding: { autonomyBypassDefault: false } })
  })

  it("never writes a project's autopilot — it is chosen per conversation", () => {
    // The positive first (#28): the payload carries the app setting.
    expect(Object.keys(modePersistPayload('autonomous'))).toEqual(['onboarding'])
    expect(modePersistPayload('autonomous')).not.toHaveProperty('config')
  })
})
