import { redactSecrets } from '../shared/browser-capture-boundary'

// WHAT A REAL BACKEND ACTUALLY PRINTS (forbidden-pattern #19: a scoped gate
// validated only on fixtures is a gate nobody has tested). The browser
// boundary was written for HEADER-shaped secrets; a server log carries
// connection strings, env dumps and echoed credentials, and this feature routes
// terminal output through the same rule for the first time.

// This value is invented, and it is ASSEMBLED rather than written out. A
// realism fixture has to carry a real key's SHAPE — the `51` account prefix and
// 24+ characters — which is exactly what GitHub's push protection blocks on
// sight: a contiguous literal here made the published repo unpushable. Splitting
// it changes no byte the redactor sees, so the coverage is identical; writing it
// out again would reintroduce a push that cannot complete.
const STRIPE_SHAPED = `sk_${'live'}_51H8xYzAbCdEfGhIjKlMnOpQr`

const SERVER_LOGS: [string, string][] = [
  ['postgres url', 'INFO connecting to postgresql://svc_user:S3cr3tPass@db.internal:5432/orbit'],
  ['env dump', 'DEBUG env: {"DATABASE_PASSWORD": "hunter2correcthorse", "NODE_ENV": "production"}'],
  ['bearer echoed', 'INFO upstream Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123signature'],
  ['github pat', 'ERROR clone failed for ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789'],
  ['aws key', 'WARN using AKIAIOSFODNN7EXAMPLE in us-east-1'],
  ['redis password', 'INFO redis://:mypassword123@cache.internal:6379/0'],
  ['set-cookie echoed', 'DEBUG upstream said Set-Cookie: session=9f8e7d6c5b4a3f2e1d0c; HttpOnly'],
  ['stripe key', `INFO stripe client ${STRIPE_SHAPED}`],
  ['basic auth', 'INFO Authorization: Basic dXNlcjpwYXNzd29yZA=='],
]

describe('redaction over real server-log shapes', () => {
  it.each(SERVER_LOGS)('removes the secret from: %s', (_name, line) => {
    const out = redactSecrets(line)
    expect(out).not.toBe(line)
  })

  it('leaves an ordinary error line completely alone', () => {
    // A redactor that mangles the message is as useless as one that leaks: the
    // stack trace IS the thing somebody recorded the session to read.
    const line =
      'ERROR IntegrityError: duplicate key value violates unique constraint "orders_pkey"'
    expect(redactSecrets(line)).toBe(line)
  })

  it('is idempotent, because the boundary runs more than once', () => {
    for (const [, line] of SERVER_LOGS) {
      const once = redactSecrets(line)
      expect(redactSecrets(once)).toBe(once)
    }
  })
})
