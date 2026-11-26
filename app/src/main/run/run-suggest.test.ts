// Run suggestions — an in-memory fs; nothing on disk is read or written.

import { join } from 'path'

import { composeServices, describeCompose, detectDataCommands, oncePriority, readComposeDescription, pyprojectScripts, readmeRunLines, suggestOnceSteps, suggestRunSteps, type SuggestFs } from './run-suggest'

function memoryFs(files: Record<string, string>): SuggestFs & { reads: string[] } {
  const reads: string[] = []
  return {
    reads,
    readFile: async (path) => {
      reads.push(path)
      return files[path] ?? null
    },
    exists: async (path) => path in files,
  }
}

const ROOT = '/repos/shop'
const at = (file: string): string => join(ROOT, file)

describe('suggestRunSteps', () => {
  it('offers long-running package scripts with the right runner, skipping one-shot ones and hooks', async () => {
    const fs = memoryFs({
      [at('package.json')]: JSON.stringify({
        scripts: {
          dev: 'next dev',
          predev: 'node prep.js',
          start: 'next start',
          build: 'next build',
          test: 'jest',
          lint: 'eslint .',
          'dev:build': 'x',
          storybook: 'storybook dev -p 6006',
          preview: 'vite preview',
          'watch:css': 'tailwind -w',
        },
      }),
      [at('pnpm-lock.yaml')]: '',
    })
    const found = await suggestRunSteps([{ root: ROOT, name: 'shop' }], fs)
    expect(found.map((s) => s.command)).toEqual([
      'pnpm run dev',
      'pnpm run start',
      'pnpm run storybook',
      'pnpm run preview',
      'pnpm run watch:css',
    ])
    expect(found[0]).toEqual({ projectRoot: ROOT, projectName: 'shop', name: 'dev', command: 'pnpm run dev', source: 'package.json' })
  })

  it('uses npm by default, and npm start for start', async () => {
    const fs = memoryFs({ [at('package.json')]: JSON.stringify({ scripts: { start: 'node .', dev: 'nodemon' } }) })
    const found = await suggestRunSteps([{ root: ROOT, name: 'shop' }], fs)
    expect(found.map((s) => s.command)).toEqual(['npm start', 'npm run dev'])
  })

  it('reads Procfile, compose services, Makefile targets, pyproject scripts and README run lines, each labelled', async () => {
    const fs = memoryFs({
      [at('Procfile')]: 'web: bundle exec rails s\n# comment\nworker: bundle exec sidekiq\n',
      [at('docker-compose.yml')]: 'version: "3"\nservices:\n  db:\n    image: postgres\n    ports:\n      - "5432:5432"\n  redis:\n    image: redis\nvolumes:\n  data:\n',
      [at('Makefile')]: 'VAR := 1\nbuild:\n\tgo build\nrun:\n\tgo run .\ndev-api: deps\n\tair\n',
      [at('pyproject.toml')]: '[project]\nname = "x"\n[project.scripts]\napi = "x.main:run"\n[tool.other]\nnope = 1\n',
      [at('README.md')]:
        '# Shop\n## Running locally\n```bash\n$ npm install\nnpm run dev\n# a comment\n```\n## Deploy\n```bash\nnpm run deploy-server\n```\n',
    })
    const found = await suggestRunSteps([{ root: ROOT, name: 'shop' }], fs)
    expect(found.map((s) => [s.source, s.name, s.command])).toEqual([
      ['Procfile', 'web', 'bundle exec rails s'],
      ['Procfile', 'worker', 'bundle exec sidekiq'],
      ['Docker Compose', 'db', 'docker compose up db'],
      ['Docker Compose', 'redis', 'docker compose up redis'],
      ['Makefile', 'run', 'make run'],
      ['Makefile', 'dev-api', 'make dev-api'],
      ['pyproject.toml', 'api', 'uv run api'],
      ['README', 'npm run dev', 'npm run dev'],
    ])
  })

  it('de-duplicates per project by command, the first source winning, and keeps projects apart', async () => {
    const other = '/repos/api'
    const fs = memoryFs({
      [at('package.json')]: JSON.stringify({ scripts: { dev: 'vite' } }),
      [at('README.md')]: '## Getting started\n```sh\nnpm   run dev\n```\n',
      [join(other, 'package.json')]: JSON.stringify({ scripts: { dev: 'tsx watch' } }),
    })
    const found = await suggestRunSteps(
      [
        { root: ROOT, name: 'shop' },
        { root: other, name: 'api' },
      ],
      fs,
    )
    expect(found.map((s) => [s.projectName, s.source, s.command])).toEqual([
      ['shop', 'package.json', 'npm run dev'],
      ['api', 'package.json', 'npm run dev'],
    ])
  })

  it('a project with nothing, or with unreadable files, offers nothing and never throws', async () => {
    const fs = memoryFs({ [at('package.json')]: '{not json' })
    await expect(suggestRunSteps([{ root: ROOT, name: 'shop' }], fs)).resolves.toEqual([])
    const throwing: SuggestFs = {
      readFile: async () => {
        throw new Error('EACCES')
      },
      exists: async () => false,
    }
    await expect(suggestRunSteps([{ root: ROOT, name: 'shop' }], throwing)).resolves.toEqual([])
  })

  it("reads a conversation's checkout but labels the suggestion with the project", async () => {
    const checkout = '/repos/.shop-threads/blue'
    const fs = memoryFs({ [join(checkout, 'package.json')]: JSON.stringify({ scripts: { dev: 'vite' } }) })
    const found = await suggestRunSteps([{ root: ROOT, name: 'shop', dir: checkout }], fs)
    expect(found.map((s) => [s.projectRoot, s.command])).toEqual([[ROOT, 'npm run dev']])
  })

  it('the fs it is given has no way to write', () => {
    const fs = memoryFs({})
    expect(Object.keys(fs).sort()).toEqual(['exists', 'readFile', 'reads'])
  })
})

describe('parsers', () => {
  it('composeServices reads only the direct children of services', () => {
    expect(composeServices('services:\n  web:\n    build: .\n    depends_on:\n      - db\n  db:\n    image: pg\n')).toEqual(['web', 'db'])
    expect(composeServices('volumes:\n  web:\n')).toEqual([])
  })

  it('pyprojectScripts reads both script tables', () => {
    expect(pyprojectScripts('[tool.poetry.scripts]\nserve = "a:b"\n"quoted-name" = "c:d"\n')).toEqual(['serve', 'quoted-name'])
  })

  it('readmeRunLines ignores code outside a run section and non-shell fences', () => {
    const text = '## Usage\n```bash\nnpm run dev\n```\n## Local development\n```js\nrun()\n```\n```\nyarn dev\n```\n'
    expect(readmeRunLines(text)).toEqual(['yarn dev'])
  })
})

describe('describeCompose', () => {
  const service = (text: string, name: string) => {
    const found = describeCompose(text).services.find((s) => s.name === name)
    if (found === undefined) throw new Error(`no service ${name}`)
    return found
  }

  it('lists the same services composeServices reads, in order', () => {
    const text = 'services:\n  web:\n    build: .\n  "db":\n    image: pg\n  odd:\n    profiles: [debug]\n'
    expect(describeCompose(text).services.map((s) => s.name)).toEqual(composeServices(text))
  })

  it('reads named volumes, short and long, with read-only marks', () => {
    const db = service(
      'services:\n  db:\n    image: postgres:16\n    volumes:\n      - pgdata:/var/lib/postgresql/data\n      - type: volume\n        source: wal\n        target: /wal\n        read_only: true\n      - type: tmpfs\n        target: /tmp\n',
      'db',
    )
    expect(db).toMatchObject({
      readable: true,
      image: 'postgres:16',
      build: null,
      volumes: [
        { volume: 'pgdata', target: '/var/lib/postgresql/data', readOnly: false },
        { volume: 'wal', target: '/wal', readOnly: true },
      ],
      binds: [],
      mountsCode: false,
    })
  })

  it('tells relative, absolute, outside, code and data binds apart', () => {
    const web = service(
      [
        'services:',
        '  web:',
        '    build:',
        '      context: ./web',
        '    volumes:',
        '      - ./web:/usr/src/app',
        '      - ./pgdata:/var/lib/postgresql/data',
        '      - ./config/app.yml:/app/config.yml:ro',
        '      - /var/run/docker.sock:/var/run/docker.sock',
        '      - ~/certs:/certs',
        '      - ../shared:/shared',
        '      - /app/node_modules',
      ].join('\n'),
      'web',
    )
    if (!web.readable) throw new Error('unreadable')
    expect(web.build).toBe('./web')
    expect(web.binds.map((b) => [b.source, b.relative, b.outside, b.code, b.readOnly])).toEqual([
      ['./web', true, false, true, false],
      ['./pgdata', true, false, false, false],
      ['./config/app.yml', true, false, false, true],
      ['/var/run/docker.sock', false, false, false, false],
      ['~/certs', false, false, false, false],
      ['../shared', true, true, false, false],
    ])
    expect(web.anonymousVolumes).toEqual(['/app/node_modules'])
    expect(web.mountsCode).toBe(true)
  })

  it('reads published ports in every common form', () => {
    const api = service(
      [
        'services:',
        '  api:',
        '    image: x',
        '    ports:',
        '      - "5432:5432"',
        '      - 8080:80',
        '      - "127.0.0.1:9000:9000/udp"',
        '      - "3000"',
        '      - "7000-7001:8000-8001"',
        '      - "${PORT:-4000}:4000"',
        '      - target: 443',
        '        published: "8443"',
        '        host_ip: 0.0.0.0',
      ].join('\n'),
      'api',
    )
    if (!api.readable) throw new Error('unreadable')
    expect(api.ports).toEqual([
      { target: 5432, published: 5432, hostIp: null, protocol: 'tcp' },
      { target: 80, published: 8080, hostIp: null, protocol: 'tcp' },
      { target: 9000, published: 9000, hostIp: '127.0.0.1', protocol: 'udp' },
      { target: 3000, published: null, hostIp: null, protocol: 'tcp' },
      { target: 8000, published: 7000, hostIp: null, protocol: 'tcp' },
      { target: 8001, published: 7001, hostIp: null, protocol: 'tcp' },
      { target: 443, published: 8443, hostIp: '0.0.0.0', protocol: 'tcp' },
    ])
    expect(api.unresolvedPorts).toEqual(['${PORT:-4000}:4000'])
  })

  it('picks the app service: the one that mounts the code, else the one of those with a build, else none', () => {
    expect(describeCompose('services:\n  web:\n    image: node\n    volumes:\n      - .:/app\n  db:\n    image: pg\n').appService).toBe('web')
    expect(
      describeCompose('services:\n  web:\n    build: .\n    volumes:\n      - ./:/app\n  worker:\n    image: node\n    volumes:\n      - ./src:/src\n').appService,
    ).toBe('web')
    expect(
      describeCompose('services:\n  a:\n    build: .\n    volumes:\n      - .:/app\n  b:\n    build: .\n    volumes:\n      - .:/app\n').appService,
    ).toBeNull()
    expect(describeCompose('services:\n  db:\n    image: pg\n').appService).toBeNull()
  })

  it('lists what it cannot read as unreadable with a plain reason, never a guess', () => {
    const text = [
      'x-common: &common',
      '  restart: always',
      'services:',
      '  extended:',
      '    extends:',
      '      service: base',
      '  profiled:',
      '    image: x',
      '    profiles: ["debug"]',
      '  merged:',
      '    <<: *common',
      '    image: x',
      '  variable:',
      '    image: x',
      '    volumes:',
      '      - ${DATA_VOLUME}:/data',
      '  fine:',
      '    image: x',
    ].join('\n')
    const services = describeCompose(text).services
    expect(services.map((s) => [s.name, s.readable])).toEqual([
      ['extended', false],
      ['profiled', false],
      ['merged', false],
      ['variable', false],
      ['fine', true],
    ])
    for (const s of services) {
      if (s.readable) continue
      expect(s.reason).toMatch(/^[A-Z].*\.$/)
      expect(s.reason).not.toMatch(/extends|profiles|\$|<<|`/)
    }
  })

  it('reads top-level volumes and which are shared whatever Flow does', () => {
    const description = describeCompose(
      'services:\n  db:\n    image: pg\nvolumes:\n  pgdata:\n  ext:\n    external: true\n  host:\n    driver: local\n    driver_opts:\n      type: none\n      o: bind\n      device: /srv/pg\n',
    )
    expect(description.volumes.map((v) => [v.name, v.shared === null])).toEqual([
      ['pgdata', true],
      ['ext', false],
      ['host', false],
    ])
  })

  it('flags an include it does not follow, and survives comments and block scalars', () => {
    const description = describeCompose(
      'include:\n  - other.yml\nservices:\n  web: # the app\n    build: .\n    command: |\n      npm run dev # keeps: going\n      - not a list\n    volumes: [\".:/app\"]\n',
    )
    expect(description.problems).toHaveLength(1)
    expect(description.services[0]).toMatchObject({ name: 'web', readable: true, mountsCode: true })
  })

  it('readComposeDescription finds the file Compose would, and the project override beside it', async () => {
    const fs = memoryFs({
      [at('docker-compose.yml')]: 'services:\n  db:\n    image: pg\n',
      [at('docker-compose.override.yml')]: 'services: {}\n',
    })
    const found = await readComposeDescription(ROOT, fs)
    expect(found).toMatchObject({ file: 'docker-compose.yml', projectOverride: 'docker-compose.override.yml' })
    expect(found?.description.services.map((s) => s.name)).toEqual(['db'])
    expect(await readComposeDescription(ROOT, memoryFs({}))).toBeNull()
  })

  it('fromCompose suggestions are unchanged by a file the describer cannot read', async () => {
    const fs = memoryFs({ [at('compose.yaml')]: 'services:\n  a:\n    <<: *x\n  b:\n    image: y\n' })
    const found = await suggestRunSteps([{ root: ROOT, name: 'shop' }], fs)
    expect(found.map((s) => [s.source, s.name, s.command])).toEqual([
      ['Docker Compose', 'a', 'docker compose up a'],
      ['Docker Compose', 'b', 'docker compose up b'],
    ])
  })
})

describe('suggestOnceSteps — one-time actions', () => {
  it('offers migration, seed, codegen and test scripts and the tools a project uses, all marked once', async () => {
    const fs = memoryFs({
      [at('package.json')]: JSON.stringify({
        scripts: { dev: 'next dev', 'db:migrate': 'x', seed: 'x', codegen: 'x', test: 'jest', build: 'next build', 'test:watch': 'jest --watch', pretest: 'x' },
      }),
      [at('yarn.lock')]: '',
      [at('alembic.ini')]: '',
      [at('uv.lock')]: '',
      [at('prisma/schema.prisma')]: '',
      [at('Makefile')]: 'migrate:\n\tx\nserve:\n\tx\ndb-seed:\n\tx\n',
    })
    const found = await suggestOnceSteps([{ root: ROOT, name: 'shop' }], fs)
    expect(found.map((s) => `${s.command} (${s.source})`)).toEqual([
      'yarn db:migrate (package.json)',
      'yarn seed (package.json)',
      'yarn codegen (package.json)',
      'yarn test (package.json)',
      'uv run alembic upgrade head (Alembic)',
      'npx prisma migrate dev (Prisma)',
      'npx prisma generate (Prisma)',
      'make migrate (Makefile)',
      'make db-seed (Makefile)',
    ])
    expect(found.every((s) => s.use === 'once' && s.projectName === 'shop')).toBe(true)
  })

  it('reads a conversation checkout, and an unreadable project offers nothing', async () => {
    const fs = memoryFs({ ['/checkout/manage.py']: '' })
    expect((await suggestOnceSteps([{ root: ROOT, dir: '/checkout', name: 'shop' }], fs)).map((s) => s.command)).toEqual([
      'python manage.py migrate',
    ])
    expect(await suggestOnceSteps([{ root: '/none', name: 'none' }], memoryFs({}))).toEqual([])
  })

  it('orders migrations before seeds, codegen and tests', () => {
    const p = (command: string): number => oncePriority({ name: '', command })
    expect(p('npm run db:migrate')).toBeGreaterThan(p('npm run seed'))
    expect(p('npm run seed')).toBeGreaterThan(p('npm run codegen'))
    expect(p('npm run codegen')).toBeGreaterThan(p('npm test'))
  })
})

describe('detectDataCommands', () => {
  it('finds each tool’s non-interactive migration, with uv for Python', async () => {
    const fs = memoryFs({
      [at('uv.lock')]: '',
      [at('alembic.ini')]: '',
      [at('manage.py')]: '',
      [at('prisma/schema.prisma')]: '',
      [at('drizzle.config.ts')]: '',
      [at('bin/rails')]: '',
    })
    const found = await detectDataCommands(ROOT, fs)
    expect(found.migrations.map((item) => `${item.command} (${item.source})`)).toEqual([
      'uv run alembic upgrade head (Alembic)',
      'uv run python manage.py migrate (Django)',
      'npx prisma migrate deploy (Prisma)',
      'npx drizzle-kit migrate (Drizzle)',
      'bin/rails db:migrate (Rails)',
    ])
    expect(found.seeds).toEqual([{ command: 'bin/rails db:seed', source: 'Rails' }])
  })

  it('finds Compose services, package scripts, a Prisma seed and Makefile targets, without duplicates', async () => {
    const fs = memoryFs({
      [at('docker-compose.yml')]: 'services:\n  web:\n    image: x\n  migrations:\n    image: x\n  seed:\n    image: x\n',
      [at('package.json')]: JSON.stringify({
        scripts: { 'db:migrate': 'knex migrate:latest', seed: 'node seed.js', dev: 'next dev', 'migrate:make': 'x' },
        prisma: { seed: 'ts-node prisma/seed.ts' },
      }),
      [at('yarn.lock')]: '',
      [at('Makefile')]: 'migrate:\n\tpython m.py\nseed: migrate\n\tpython s.py\nVAR := 1\nmigrate:\n',
    })
    const found = await detectDataCommands(ROOT, fs)
    expect(found.migrations).toEqual([
      { command: 'docker compose run --rm migrations', source: 'Docker Compose', service: 'migrations' },
      { command: 'yarn db:migrate', source: 'package.json' },
      { command: 'make migrate', source: 'Makefile' },
    ])
    expect(found.seeds).toEqual([
      { command: 'docker compose run --rm seed', source: 'Docker Compose', service: 'seed' },
      { command: 'yarn seed', source: 'package.json' },
      { command: 'npx prisma db seed', source: 'Prisma' },
      { command: 'make seed', source: 'Makefile' },
    ])
  })

  it('finds nothing in a project with none, and survives a broken package.json', async () => {
    expect(await detectDataCommands(ROOT, memoryFs({ [at('package.json')]: '{nope' }))).toEqual({ migrations: [], seeds: [] })
  })

  it('reads the same markers as the one-time chips (one reading)', async () => {
    const fs = memoryFs({ [at('alembic.ini')]: '' })
    const once = await suggestOnceSteps([{ root: ROOT, name: 'shop' }], fs)
    const data = await detectDataCommands(ROOT, fs)
    expect(once.map((item) => item.command)).toContain(data.migrations[0]!.command)
  })
})
