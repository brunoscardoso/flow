// Per-thread Compose — pure: a description in, names, labels and an override out.

import { describeCompose, DOCKER_VOLUME_NAME } from './compose-describe'
import {
  LABEL_PROJECT,
  projectDataSlug,
  LABEL_THREAD,
  LABEL_VOLUME,
  sanitizeProjectSlug,
  serializeComposeOverride,
  threadComposeOverride,
  threadVolumeName,
  threadVolumePrefix,
} from './compose-thread'

const THREAD = '3f2a9c1e-77b0-4d2e-9a10-5b6c7d8e9f00'
const CHECKOUT = '/Users/me/.flow/threads/shop-blue'

const COMPOSE = [
  'services:',
  '  web:',
  '    build: .',
  '    volumes:',
  '      - .:/app',
  '      - /app/node_modules',
  '      - ./nginx.conf:/etc/nginx/nginx.conf:ro',
  '    ports:',
  '      - "3000:3000"',
  '  db:',
  '    image: postgres:16',
  '    volumes:',
  '      - pgdata:/var/lib/postgresql/data',
  '      - /srv/backups:/backups',
  '    ports:',
  '      - 5432:5432',
  '  cache:',
  '    image: redis',
  '    volumes:',
  '      - type: volume',
  '        source: redisdata',
  '        target: /data',
  '  tools:',
  '    extends:',
  '      service: web',
  'volumes:',
  '  pgdata:',
  '  redisdata: {}',
  '  shared:',
  '    external: true',
].join('\n')

describe('thread volume names', () => {
  it('are flow-<project>-<thread prefix>-<volume>, valid for Docker', () => {
    const name = threadVolumeName('shop', THREAD, 'pgdata')
    expect(name).toBe('flow-shop-3f2a9c1e77b0-pgdata')
    expect(DOCKER_VOLUME_NAME.test(name)).toBe(true)
  })

  it('sanitize the project slug and the volume name', () => {
    expect(sanitizeProjectSlug('My Shop!! (v2)')).toBe('my-shop-v2')
    expect(sanitizeProjectSlug('***')).toBe('project')
    const name = threadVolumeName('My Shop', THREAD, 'odd name')
    expect(name).toBe('flow-my-shop-3f2a9c1e77b0-odd-name')
    expect(DOCKER_VOLUME_NAME.test(name)).toBe(true)
  })

  it('come from the thread id alone — the same thread always gets the same names; another thread never does', () => {
    expect(threadVolumeName('shop', THREAD, 'pgdata')).toBe(threadVolumeName('shop', THREAD, 'pgdata'))
    expect(threadVolumeName('shop', THREAD, 'pgdata')).not.toBe(
      threadVolumeName('shop', '3f2a9c1e-77b1-0000-0000-000000000000', 'pgdata'),
    )
    expect(threadVolumePrefix('shop', THREAD)).toBe('flow-shop-3f2a9c1e77b0-')
  })

  it('refuse a thread id with nothing usable rather than share a name', () => {
    expect(() => threadVolumeName('shop', '---', 'pgdata')).toThrow()
  })
})

describe('threadComposeOverride', () => {
  const plan = threadComposeOverride({
    project: describeCompose(COMPOSE),
    projectSlug: 'Shop',
    threadId: THREAD,
    checkout: CHECKOUT,
  })

  it('gives the thread one volume per named data volume, labelled with thread, project and original', () => {
    expect(plan.volumes).toEqual([
      {
        original: 'pgdata',
        name: 'flow-shop-3f2a9c1e77b0-pgdata',
        labels: { [LABEL_THREAD]: THREAD, [LABEL_PROJECT]: 'shop', [LABEL_VOLUME]: 'pgdata' },
        services: ['db'],
      },
      {
        original: 'redisdata',
        name: 'flow-shop-3f2a9c1e77b0-redisdata',
        labels: { [LABEL_THREAD]: THREAD, [LABEL_PROJECT]: 'shop', [LABEL_VOLUME]: 'redisdata' },
        services: ['cache'],
      },
    ])
    expect(plan.dataServices).toEqual(['db', 'cache'])
  })

  it('mounts the checkout where the code is, with an absolute path', () => {
    expect(plan.appService).toBe('web')
    expect(plan.codeMounts).toEqual([{ service: 'web', source: '.', target: '/app', checkoutSource: CHECKOUT }])
    expect(plan.override.services.web!.volumes).toEqual([{ type: 'bind', source: CHECKOUT, target: '/app' }])
  })

  it('reports absolute binds as shared and relative ones as already per thread', () => {
    expect(plan.sharedBinds).toEqual([
      { service: 'db', source: '/srv/backups', target: '/backups', reason: expect.stringContaining('every conversation shares') },
    ])
    expect(plan.threadBinds).toEqual([{ service: 'web', source: './nginx.conf', target: '/etc/nginx/nginx.conf' }])
    expect(plan.anonymousVolumes).toEqual([{ service: 'web', target: '/app/node_modules' }])
  })

  it('lists unreadable services with their reason and still labels them', () => {
    expect(plan.unreadable).toEqual([{ service: 'tools', reason: expect.stringContaining("another service's settings") }])
    expect(plan.override.services.tools).toEqual({ labels: { [LABEL_THREAD]: THREAD, [LABEL_PROJECT]: 'shop' } })
  })

  it('redirects volumes through their top-level name, and labels every service', () => {
    expect(plan.override.volumes).toEqual({
      pgdata: { name: 'flow-shop-3f2a9c1e77b0-pgdata', labels: plan.volumes[0]!.labels },
      redisdata: { name: 'flow-shop-3f2a9c1e77b0-redisdata', labels: plan.volumes[1]!.labels },
    })
    expect(Object.keys(plan.override.services)).toEqual(['web', 'db', 'cache', 'tools'])
    expect(plan.override.services.db).toEqual({ labels: { [LABEL_THREAD]: THREAD, [LABEL_PROJECT]: 'shop' } })
  })

  it('leaves shared volumes alone and says why', () => {
    const shared = threadComposeOverride({
      project: describeCompose('services:\n  db:\n    image: pg\n    volumes:\n      - ext:/data\nvolumes:\n  ext:\n    external: true\n'),
      projectSlug: 'shop',
      threadId: THREAD,
      checkout: CHECKOUT,
    })
    expect(shared.volumes).toEqual([])
    expect(shared.override.volumes).toEqual({})
    expect(shared.sharedVolumes).toEqual([{ volume: 'ext', reason: expect.stringContaining('outside the Compose file') }])
  })

  it('a relative bind that climbs out of the project is not per thread', () => {
    const outside = threadComposeOverride({
      project: describeCompose('services:\n  api:\n    build: .\n    volumes:\n      - ../shared:/shared\n'),
      projectSlug: 'shop',
      threadId: THREAD,
      checkout: CHECKOUT,
    })
    expect(outside.sharedBinds.map((bind) => bind.source)).toEqual(['../shared'])
    expect(outside.codeMounts).toEqual([])
  })

  it('refuses a relative checkout', () => {
    expect(() =>
      threadComposeOverride({ project: describeCompose(COMPOSE), projectSlug: 'shop', threadId: THREAD, checkout: 'threads/x' }),
    ).toThrow()
  })

  it('is deterministic', () => {
    const again = threadComposeOverride({ project: describeCompose(COMPOSE), projectSlug: 'Shop', threadId: THREAD, checkout: CHECKOUT })
    expect(again).toEqual(plan)
  })
})

describe('serializeComposeOverride', () => {
  it('writes the fixed shape as quoted YAML', () => {
    const text = serializeComposeOverride({
      services: {
        web: { labels: { [LABEL_THREAD]: 't-1' }, volumes: [{ type: 'bind', source: '/a b/#x', target: '/app', read_only: true }] },
        on: { labels: {} },
      },
      volumes: { pgdata: { name: 'flow-shop-t1-pgdata', labels: { [LABEL_VOLUME]: 'pgdata' } } },
    })
    expect(text).toBe(
      [
        '# Written by Flow for one conversation; rewritten on every run.',
        'services:',
        '  "web":',
        '    labels:',
        '      "dev.planflow.thread": "t-1"',
        '    volumes:',
        '      - type: "bind"',
        '        source: "/a b/#x"',
        '        target: "/app"',
        '        read_only: true',
        '  "on":',
        '    labels: {}',
        'volumes:',
        '  "pgdata":',
        '    name: "flow-shop-t1-pgdata"',
        '    labels:',
        '      "dev.planflow.volume": "pgdata"',
        '',
      ].join('\n'),
    )
  })

  it('writes empty maps for an override with nothing in it', () => {
    expect(serializeComposeOverride({ services: {}, volumes: {} })).toContain('services: {}\nvolumes: {}\n')
  })

  it("reads back through Flow's own Compose reader with the same volumes", () => {
    const plan = threadComposeOverride({ project: describeCompose(COMPOSE), projectSlug: 'shop', threadId: THREAD, checkout: CHECKOUT })
    const reread = describeCompose(serializeComposeOverride(plan.override))
    expect(reread.services.map((service) => service.name)).toEqual(['web', 'db', 'cache', 'tools'])
    const web = reread.services[0]!
    expect(web.readable && web.binds.map((bind) => [bind.source, bind.target])).toEqual([[CHECKOUT, '/app']])
    expect(reread.volumes.map((volume) => volume.name)).toEqual(['pgdata', 'redisdata'])
  })
})

describe('published ports for the migration guard', () => {
  it('lists only ports with a definite number, with their bind address', () => {
    const plan = threadComposeOverride({
      project: describeCompose(
        [
          'services:',
          '  db:',
          '    image: postgres',
          '    ports:',
          '      - "127.0.0.1:5433:5432"',
          '      - "6000"',
          '      - "${PG_PORT}:5432"',
          '  odd:',
          '    image: x',
          '    profiles: [debug]',
          '',
        ].join('\n'),
      ),
      projectSlug: 'shop',
      threadId: THREAD,
      checkout: CHECKOUT,
    })
    expect(plan.publishedPorts).toEqual([{ service: 'db', published: 5433, target: 5432, hostIp: '127.0.0.1', protocol: 'tcp' }])
    expect(plan.readableServices).toEqual(['db'])
  })
})

// ─── a real project's file, warts and all (forbidden-pattern #19) ───────────

describe('a messy, realistic Compose file end to end', () => {
  const MESSY = [
    "# a real project's file, warts and all",
    'name: shop',
    'x-env: &default-env',
    '  TZ: UTC',
    '  LOG_LEVEL: info',
    '',
    'services:',
    '  api:',
    '    build:',
    '      context: .',
    '      dockerfile: docker/Dockerfile.dev',
    '    image: "shop-api:${TAG:-dev}"',
    '    environment:',
    '      DATABASE_URL: postgres://shop:shop@db:5432/shop',
    '    env_file: .env',
    '    volumes:',
    '      - .:/srv/app:cached',
    '      - /srv/app/node_modules',
    '      - type: bind',
    '        source: ./config',
    '        target: /srv/app/config',
    '        read_only: true',
    '    ports:',
    '      - target: 8000',
    '        published: 8000',
    '        protocol: tcp',
    '      - "${DEBUG_PORT:-5678}:5678"',
    '    depends_on:',
    '      - db',
    '  db:',
    '    image: postgres:${PG_VERSION:-16}',
    '    volumes:',
    '      - type: volume',
    '        source: pgdata',
    '        target: /var/lib/postgresql/data',
    '      - /Users/someone/dumps:/dumps:ro',
    '    ports:',
    '      - "127.0.0.1:5432:5432"',
    '  cache:',
    '    image: redis:7',
    '    command: ["redis-server", "--appendonly", "yes"]',
    '    volumes:',
    '      - redisdata:/data',
    '  worker:',
    '    <<: *default-env',
    '    image: shop-api',
    '  docs:',
    '    image: nginx',
    '    profiles: ["docs"]',
    '    volumes:',
    '      - ../shared-docs:/usr/share/nginx/html:ro',
    '  admin:',
    '    extends:',
    '      file: common.yml',
    '      service: admin',
    '  search:',
    '    image: opensearch',
    '    volumes:',
    '      - searchdata:/usr/share/opensearch/data',
    '  assets:',
    '    image: busybox',
    '    volumes:',
    '      - ../shared-assets:/assets',
    'volumes:',
    '  pgdata: {}',
    '  redisdata:',
    '    driver: local',
    '  searchdata:',
    '    external: true',
    '    name: company-search',
  ].join('\n')
  const SLUG = projectDataSlug('/Users/me/work/shop')
  const plan = threadComposeOverride({ project: describeCompose(MESSY), projectSlug: SLUG, threadId: THREAD, checkout: CHECKOUT })

  const plain = (sentence: string): void => {
    expect(sentence).toMatch(/^[A-Z].*\.$/)
    expect(sentence).not.toMatch(/`|\/|--|\$|<<|extends|profiles|external|flowconfig|[a-z]+_[a-z_]+|planflow/i)
  }

  it('splits readable from unreadable services, each unreadable one with a plain reason', () => {
    expect(plan.readableServices).toEqual(['api', 'db', 'cache', 'search', 'assets'])
    expect(plan.unreadable.map((entry) => entry.service)).toEqual(['worker', 'docs', 'admin'])
    for (const entry of plan.unreadable) plain(entry.reason)
    expect(plan.appService).toBe('api')
    expect(plan.problems).toEqual([])
  })

  it('gives the thread its own copy of the data volumes only — never an external one', () => {
    expect(plan.volumes.map((volume) => [volume.original, volume.services])).toEqual([
      ['pgdata', ['db']],
      ['redisdata', ['cache']],
    ])
    expect(plan.dataServices).toEqual(['db', 'cache'])
    for (const volume of plan.volumes) {
      expect(volume.name).toMatch(DOCKER_VOLUME_NAME)
      expect(volume.name.startsWith(threadVolumePrefix(SLUG, THREAD))).toBe(true)
    }
    expect(plan.sharedVolumes.map((entry) => entry.volume)).toEqual(['searchdata'])
    for (const entry of plan.sharedVolumes) plain(entry.reason)
  })

  it('mounts the checkout where the code is, and says which host folders every thread shares', () => {
    expect(plan.codeMounts.map((mount) => [mount.target, mount.checkoutSource])).toEqual([
      ['/srv/app', CHECKOUT],
      ['/srv/app/config', `${CHECKOUT}/config`],
    ])
    expect(plan.sharedBinds.map((bind) => [bind.service, bind.source])).toEqual([
      ['db', '/Users/someone/dumps'],
      ['assets', '../shared-assets'],
    ])
    for (const bind of plan.sharedBinds) plain(bind.reason)
    expect(plan.anonymousVolumes).toEqual([{ service: 'api', target: '/srv/app/node_modules' }])
  })

  it('proves only ports with a definite number — never one written with a variable', () => {
    expect(plan.publishedPorts.map((entry) => [entry.service, entry.published, entry.hostIp])).toEqual([
      ['api', 8000, null],
      ['db', 5432, '127.0.0.1'],
    ])
  })

  it("the override reads back through Flow's own reader: every service labelled, the code at the checkout, the same volumes", () => {
    const reread = describeCompose(serializeComposeOverride(plan.override))
    expect(reread.services.map((service) => [service.name, service.readable])).toEqual(
      ['api', 'db', 'cache', 'worker', 'docs', 'admin', 'search', 'assets'].map((name) => [name, true]),
    )
    const api = reread.services[0]!
    expect(api.readable && api.binds.map((bind) => [bind.source, bind.target, bind.readOnly])).toEqual([
      [CHECKOUT, '/srv/app', false],
      [`${CHECKOUT}/config`, '/srv/app/config', true],
    ])
    expect(reread.volumes.map((volume) => [volume.name, volume.shared])).toEqual([
      ['pgdata', null],
      ['redisdata', null],
    ])
    const text = serializeComposeOverride(plan.override)
    expect(text).not.toContain('company-search')
    expect(text).not.toContain('searchdata')
    for (const service of ['api', 'db', 'cache', 'worker', 'docs', 'admin', 'search', 'assets']) {
      expect(plan.override.services[service]?.labels).toEqual({ [LABEL_THREAD]: THREAD, [LABEL_PROJECT]: SLUG })
    }
  })

  it('names stay the same when the thread is renamed (they come from its id), and differ for two projects sharing a folder name', () => {
    const again = threadComposeOverride({ project: describeCompose(MESSY), projectSlug: SLUG, threadId: THREAD, checkout: '/Users/me/.flow/threads/renamed' })
    expect(again.volumes.map((volume) => volume.name)).toEqual(plan.volumes.map((volume) => volume.name))
    const other = projectDataSlug('/Users/me/oss/shop')
    expect(other).not.toBe(SLUG)
    expect(other.startsWith('shop-')).toBe(true)
    const theirs = threadComposeOverride({ project: describeCompose(MESSY), projectSlug: other, threadId: THREAD, checkout: CHECKOUT })
    for (const [index, volume] of theirs.volumes.entries()) expect(volume.name).not.toBe(plan.volumes[index]!.name)
  })
})
