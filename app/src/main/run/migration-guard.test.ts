// The migration guard — pure decisions; nothing is run.

import { describeCompose } from './compose-describe'
import { threadComposeOverride, type ThreadComposePlan } from './compose-thread'
import { GUARD_REFUSAL, addressesFromUrl, databaseAddressesFrom, guardMigration, type GuardedCommand } from './migration-guard'

const THREAD = '3f2a9c1e-77b0-4d2e-9a10-5b6c7d8e9f00'

const planFor = (compose: string): ThreadComposePlan =>
  threadComposeOverride({ project: describeCompose(compose), projectSlug: 'shop', threadId: THREAD, checkout: '/checkouts/shop' })

/** No app service (nothing mounts the code); db publishes 5433 on every address, cache on loopback only. */
const NO_APP = planFor(
  [
    'services:',
    '  db:',
    '    image: postgres',
    '    volumes:',
    '      - pgdata:/var/lib/postgresql/data',
    '    ports:',
    '      - "5433:5432"',
    '  cache:',
    '    image: redis',
    '    ports:',
    '      - "127.0.0.1:6380:6379"',
    '  picked:',
    '    image: mysql',
    '    ports:',
    '      - "3306"',
    '  varport:',
    '    image: mongo',
    '    ports:',
    '      - "${MONGO_PORT}:27017"',
    '  migrate:',
    '    image: tools',
    '',
  ].join('\n'),
)

const WITH_APP = planFor(
  ['services:', '  api:', '    build: .', '    volumes:', '      - .:/app', '  db:', '    image: postgres', ''].join('\n'),
)

/** A refusal's reason, asserted to be a plain sentence. */
function refusal(result: GuardedCommand): string {
  expect(result.kind).toBe('refused')
  const reason = result.kind === 'refused' ? result.reason : ''
  expect(reason).not.toMatch(/`/)
  expect(reason).not.toMatch(/\//)
  expect(reason).not.toMatch(/--/)
  expect(reason.trim()).not.toBe('')
  return reason
}

describe('guardMigration', () => {
  it('runs inside the app service only when its own environment reaches this thread’s services', () => {
    expect(WITH_APP.appService).toBe('api')
    const env = (DATABASE_URL: string) => ({ api: { DATABASE_URL } })
    // Positive first: the container's database is the thread's own db service.
    expect(
      guardMigration({ command: ' alembic upgrade head ', plan: WITH_APP, databaseAddresses: [], serviceEnvironments: env('postgres://u:p@db:5432/app') }),
    ).toEqual({ kind: 'inside', service: 'api', command: 'alembic upgrade head' })
    // A container pointed at another server is refused, whatever the host env says.
    expect(
      refusal(guardMigration({ command: 'x', plan: WITH_APP, databaseAddresses: ['localhost:5432'], serviceEnvironments: env('postgres://db.example.com:5432/app') })),
    ).toBe(GUARD_REFUSAL.foreign)
    // A second URL under any name counts: one own address never hides another.
    expect(
      refusal(
        guardMigration({
          command: 'x',
          plan: WITH_APP,
          databaseAddresses: [],
          serviceEnvironments: { api: { DATABASE_URL: 'postgres://db:5432/app', DIRECT_URL: 'postgresql://prod-host/app' } },
        }),
      ),
    ).toBe(GUARD_REFUSAL.foreign)
    // Nothing read, or nothing named: refused.
    expect(refusal(guardMigration({ command: 'x', plan: WITH_APP, databaseAddresses: [] }))).toBe(GUARD_REFUSAL.containerEnv)
    expect(refusal(guardMigration({ command: 'x', plan: WITH_APP, databaseAddresses: [], serviceEnvironments: null }))).toBe(GUARD_REFUSAL.containerEnv)
    expect(refusal(guardMigration({ command: 'x', plan: WITH_APP, databaseAddresses: [], serviceEnvironments: { api: {} } }))).toBe(
      GUARD_REFUSAL.noAddresses,
    )
  })

  it('runs locally when every address is this computer on a port this thread published', () => {
    expect(NO_APP.appService).toBeNull()
    expect(
      guardMigration({ command: 'npx prisma migrate deploy', plan: NO_APP, databaseAddresses: ['localhost:5433', '127.0.0.1:6380'] }),
    ).toEqual({ kind: 'local', command: 'npx prisma migrate deploy', addresses: ['localhost:5433', '127.0.0.1:6380'] })
    expect(guardMigration({ command: 'x', plan: NO_APP, databaseAddresses: ['[::1]:5433', '0.0.0.0:5433'] }).kind).toBe('local')
  })

  it('refuses a port Compose picks itself (published: null)', () => {
    expect(refusal(guardMigration({ command: 'x', plan: NO_APP, databaseAddresses: ['localhost:3306'] }))).toBe(GUARD_REFUSAL.unproven)
  })

  it('refuses a port written with a variable (unresolved)', () => {
    expect(refusal(guardMigration({ command: 'x', plan: NO_APP, databaseAddresses: ['localhost:27017'] }))).toBe(GUARD_REFUSAL.unproven)
  })

  it('refuses a port nobody published, even when another address is proven', () => {
    expect(
      refusal(guardMigration({ command: 'x', plan: NO_APP, databaseAddresses: ['localhost:5433', 'localhost:5432'] })),
    ).toBe(GUARD_REFUSAL.unproven)
  })

  it('refuses a foreign host, even on a published port number', () => {
    expect(refusal(guardMigration({ command: 'x', plan: NO_APP, databaseAddresses: ['db.prod.internal:5433'] }))).toBe(
      GUARD_REFUSAL.foreign,
    )
    expect(refusal(guardMigration({ command: 'x', plan: NO_APP, databaseAddresses: ['10.0.0.5:5433'] }))).toBe(GUARD_REFUSAL.foreign)
  })

  it('a port bound to loopback is not proven for another local address', () => {
    expect(refusal(guardMigration({ command: 'x', plan: NO_APP, databaseAddresses: ['0.0.0.0:6380'] }))).toBe(GUARD_REFUSAL.unproven)
  })

  it('refuses when no address is known', () => {
    expect(refusal(guardMigration({ command: 'x', plan: NO_APP, databaseAddresses: [] }))).toBe(GUARD_REFUSAL.noAddresses)
    expect(refusal(guardMigration({ command: 'x', plan: NO_APP, databaseAddresses: ['  '] }))).toBe(GUARD_REFUSAL.noAddresses)
  })

  it('refuses an address it cannot read', () => {
    expect(refusal(guardMigration({ command: 'x', plan: NO_APP, databaseAddresses: [':5433'] }))).toBe(GUARD_REFUSAL.unreadable)
    expect(refusal(guardMigration({ command: 'x', plan: NO_APP, databaseAddresses: ['localhost'] }))).toBe(GUARD_REFUSAL.unreadable)
    expect(refusal(guardMigration({ command: 'x', plan: NO_APP, databaseAddresses: ['postgres://${HOST}/db'] }))).toBe(
      GUARD_REFUSAL.unreadable,
    )
  })

  it('refuses an empty command', () => {
    expect(refusal(guardMigration({ command: '  ', plan: WITH_APP, databaseAddresses: [] }))).toBe(GUARD_REFUSAL.empty)
  })

  it('a Compose migration service runs as that service when the plan can read it and its environment reaches this thread', () => {
    const own = { migrate: { DATABASE_URL: 'postgres://db:5432/app' } }
    expect(guardMigration({ command: '', composeService: 'migrate', plan: NO_APP, databaseAddresses: [], serviceEnvironments: own })).toEqual({
      kind: 'service',
      service: 'migrate',
    })
    expect(
      refusal(
        guardMigration({
          command: '',
          composeService: 'migrate',
          plan: NO_APP,
          databaseAddresses: [],
          serviceEnvironments: { migrate: { DATABASE_URL: 'postgres://shared.example.com/app' } },
        }),
      ),
    ).toBe(GUARD_REFUSAL.foreign)
    expect(refusal(guardMigration({ command: '', composeService: 'migrate', plan: NO_APP, databaseAddresses: [] }))).toBe(GUARD_REFUSAL.containerEnv)
    expect(refusal(guardMigration({ command: '', composeService: 'seed', plan: NO_APP, databaseAddresses: [], serviceEnvironments: own }))).toBe(
      GUARD_REFUSAL.service,
    )
  })

  it('every refusal is a plain sentence', () => {
    for (const reason of Object.values(GUARD_REFUSAL)) {
      expect(reason).not.toMatch(/`|\/|--/)
    }
  })
})

describe('databaseAddressesFrom', () => {
  it('reads a database URL under any variable name, so a second database is never missed', () => {
    expect(
      databaseAddressesFrom({
        DATABASE_URL: 'postgres://localhost:5433/app',
        DIRECT_URL: 'postgresql://prod-host:5432/app',
        SQLALCHEMY_DATABASE_URI: 'mysql+pymysql://u:p@reports:3307/x',
        HOMEPAGE: 'https://example.com',
      }),
    ).toEqual(['localhost:5433', 'prod-host:5432', 'reports:3307'])
  })

  it('reads URL variables with each server’s usual port', () => {
    expect(
      databaseAddressesFrom({
        DATABASE_URL: 'postgresql://u:p@localhost/app',
        ANALYTICS_DATABASE_URL: 'mysql://root@127.0.0.1:3307/stats',
        REDIS_URL: 'redis://localhost',
        MONGODB_URI: 'mongodb://a:1,b/db',
        UNRELATED_URL: 'https://example.com',
      }),
    ).toEqual(['localhost:5432', '127.0.0.1:3307', 'localhost:6379', 'a:1', 'b:27017'])
  })

  it('reads host and port pairs, with defaults', () => {
    expect(databaseAddressesFrom({ POSTGRES_HOST: 'localhost', POSTGRES_PORT: '5433', MYSQL_HOST: 'db' })).toEqual([
      'localhost:5433',
      'db:3306',
    ])
    expect(databaseAddressesFrom({ PGHOST: '::1' })).toEqual(['[::1]:5432'])
  })

  it('a port with no host, or a socket folder, is kept so the guard refuses it', () => {
    expect(databaseAddressesFrom({ PGPORT: '5433' })).toEqual([':5433'])
    expect(databaseAddressesFrom({ PGHOST: '/var/run/postgresql' })).toEqual(['/var/run/postgresql'])
  })

  it('a file database has no address; an unreadable or discovered one comes back as written', () => {
    expect(addressesFromUrl('sqlite:///db.sqlite3')).toEqual([])
    expect(addressesFromUrl('mongodb+srv://cluster.example.net/db')).toEqual(['mongodb+srv://cluster.example.net/db'])
    expect(addressesFromUrl('not a url')).toEqual(['not a url'])
    expect(addressesFromUrl('postgres://[::1]:5433/app')).toEqual(['[::1]:5433'])
  })

  it('every address a project could name that is not provably this thread is refused end to end', () => {
    const decide = (env: Record<string, string>) =>
      guardMigration({ command: 'alembic upgrade head', plan: NO_APP, databaseAddresses: databaseAddressesFrom(env) })
    // Positive first: the same plan and command run locally on the thread's published port.
    expect(decide({ DATABASE_URL: 'postgresql+psycopg://u:p@127.0.0.1:5433/app' })).toEqual({
      kind: 'local',
      command: 'alembic upgrade head',
      addresses: ['127.0.0.1:5433'],
    })
    expect(refusal(decide({ PGHOST: '/var/run/postgresql' }))).toBe(GUARD_REFUSAL.unreadable)
    expect(refusal(decide({ DATABASE_URL: 'postgres://u@/app?host=/tmp' }))).toBe(GUARD_REFUSAL.unreadable)
    expect(refusal(decide({ MONGODB_URI: 'mongodb+srv://u:p@cluster0.example.net/app' }))).toBe(GUARD_REFUSAL.unreadable)
    expect(refusal(decide({ DATABASE_URL: 'postgres://u@${DB_HOST}:5433/app' }))).toBe(GUARD_REFUSAL.unreadable)
    expect(refusal(decide({ DATABASE_URL: 'postgres://u@db.prod.example.com:5433/app' }))).toBe(GUARD_REFUSAL.foreign)
    expect(refusal(decide({ PGPORT: '5433' }))).toBe(GUARD_REFUSAL.unreadable)
    expect(refusal(decide({ DB_HOST: 'localhost' }))).toBe(GUARD_REFUSAL.unreadable)
    // A port Compose picks itself, and one written with a variable, prove nothing.
    expect(refusal(decide({ MYSQL_HOST: 'localhost', MYSQL_PORT: '3306' }))).toBe(GUARD_REFUSAL.unproven)
    expect(refusal(decide({ MONGO_URL: 'mongodb://localhost:27017/app' }))).toBe(GUARD_REFUSAL.unproven)
    expect(refusal(decide({}))).toBe(GUARD_REFUSAL.noAddresses)
    // One proven address never vouches for another that is not.
    expect(refusal(decide({ DATABASE_URL: 'postgres://u@localhost:5433/app', REDIS_URL: 'redis://cache.example.com:6380' }))).toBe(
      GUARD_REFUSAL.foreign,
    )
  })

  it('feeds the guard end to end', () => {
    const addresses = databaseAddressesFrom({ DATABASE_URL: 'postgres://u@localhost:5433/app' })
    expect(guardMigration({ command: 'alembic upgrade head', plan: NO_APP, databaseAddresses: addresses }).kind).toBe('local')
    const foreign = databaseAddressesFrom({ DATABASE_URL: 'postgres://u@prod.example.com:5433/app' })
    expect(guardMigration({ command: 'alembic upgrade head', plan: NO_APP, databaseAddresses: foreign }).kind).toBe('refused')
  })
})
