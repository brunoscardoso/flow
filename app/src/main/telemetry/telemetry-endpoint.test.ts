import { assertWriteOnlyShape, configuredEndpoint } from './telemetry-endpoint'

describe('the configured endpoint', () => {
  // NULL IS THE ORDINARY CASE. No host exists yet, and a developer building
  // from a clone must never be posting anywhere.
  it('is nowhere when the build configured nothing', () => {
    expect(configuredEndpoint({ url: '', key: '' })).toBeNull()
    expect(configuredEndpoint()).toBeNull()
  })

  it('is nowhere when only half of it was configured', () => {
    expect(configuredEndpoint({ url: 'https://x.example/ingest', key: '' })).toBeNull()
    expect(configuredEndpoint({ url: '', key: 'k' })).toBeNull()
  })

  // Install facts on a café network, in the clear, otherwise.
  it('refuses a plaintext endpoint', () => {
    expect(configuredEndpoint({ url: 'http://x.example/ingest', key: 'k' })).toBeNull()
  })

  it('is the endpoint when both halves are there and it is https', () => {
    expect(configuredEndpoint({ url: 'https://x.example/ingest', key: 'k' })).toEqual({
      url: 'https://x.example/ingest',
      key: 'k',
    })
  })

  it('ignores surrounding whitespace, which a CI variable usually has', () => {
    expect(configuredEndpoint({ url: '  https://x.example/i  ', key: ' k ' })).toEqual({
      url: 'https://x.example/i',
      key: 'k',
    })
  })
})

describe('the shipped key must not be able to read', () => {
  it('passes an ordinary opaque ingest token', () => {
    expect(assertWriteOnlyShape('flw_ingest_9f3a2b7c')).toBeNull()
  })

  // The three mistakes that are actually made. Each of these can READ, and the
  // whole bargain of an embedded key is that it cannot — it ships inside a
  // binary anyone can unzip.
  it.each([
    ['postgres://user:pw@host/db', 'a database connection string'],
    ['postgresql://user:pw@host/db', 'a database connection string'],
    ['mysql://user:pw@host/db', 'a database connection string'],
    ['eyJ...service_role...', 'a service-role key'],
    ['ghp_aaaaaaaaaaaaaaaaaaaa', 'a GitHub token'],
    ['sk-aaaaaaaaaaaaaaaaaaaa', 'a secret API key'],
    ['-----BEGIN PRIVATE KEY-----', 'a private key'],
  ])('refuses %s', (key, what) => {
    const reason = assertWriteOnlyShape(key)
    expect(reason).not.toBeNull()
    expect(reason).toContain(what)
    expect(reason).toContain('write-only')
  })

  it('says WHY, so the person who pasted it knows what to paste instead', () => {
    expect(assertWriteOnlyShape('postgres://u:p@h/d')).toContain('can read data')
  })
})
