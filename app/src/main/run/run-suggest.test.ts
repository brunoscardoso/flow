// Run suggestions — an in-memory fs; nothing on disk is read or written.

import { join } from 'path'

import { composeServices, oncePriority, pyprojectScripts, readmeRunLines, suggestOnceSteps, suggestRunSteps, type SuggestFs } from './run-suggest'

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
