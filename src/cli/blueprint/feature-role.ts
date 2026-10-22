/**
 * A feature's ROLE — the kind of thing it is (UI, API, data…), drawn as an icon.
 *
 * Two keys, two writers: `role` is the person's word and `learnedRole` is what a
 * learn pass concluded; neither writer may overwrite the other. When both are
 * absent the role is GUESSED from the feature's anchors, so every card has an
 * icon on day one. The guess is the fallback, never the record.
 *
 * Pure, no imports — the app re-exports it (`app/src/shared/feature-role.ts`),
 * the precedent `understood.ts` set (allowed-pattern #14). The test/doc
 * exclusion below is a local copy of the idea in `extractors/scan.ts`
 * (`isTestFile`, `classifyTier`), which cannot be imported: it pulls in node:fs.
 */

export const FEATURE_ROLES = Object.freeze([
  'ui',
  'api',
  'logic',
  'data',
  'config',
  'jobs',
  'integration',
  'service',
  'function',
  'mobile',
  'neutral',
] as const);

export type FeatureRole = (typeof FEATURE_ROLES)[number];

export type FeatureRoleSource = 'person' | 'learn' | 'guess';

export const FEATURE_ROLE_LABELS: Readonly<Record<FeatureRole, string>> = Object.freeze({
  ui: 'User interface',
  api: 'API',
  logic: 'Logic',
  data: 'Data',
  config: 'Configuration',
  jobs: 'Background jobs',
  integration: 'Integration',
  service: 'Service',
  function: 'Function',
  mobile: 'Mobile',
  neutral: 'Other',
});

export function isFeatureRole(value: unknown): value is FeatureRole {
  return typeof value === 'string' && (FEATURE_ROLES as readonly string[]).includes(value);
}

/** Path words per role. A word is a whole path segment (or a filename word), never a substring. */
const PATH_WORDS: ReadonlyArray<readonly [FeatureRole, ReadonlySet<string>]> = [
  ['ui', new Set(['renderer', 'components', 'ui', 'screens', 'views', 'pages', 'web', 'frontend', 'styles'])],
  ['jobs', new Set(['jobs', 'workers', 'worker', 'cron', 'queue', 'queues', 'daemon', 'heartbeat', 'scheduler'])],
  ['config', new Set(['config', 'settings', 'flowconfig'])],
  ['mobile', new Set(['mobile', 'ios', 'android', 'native'])],
  ['function', new Set(['utils', 'util', 'helpers', 'lib', 'mappers', 'mapper'])],
  ['service', new Set(['services', 'service', 'main', 'server'])],
  ['data', new Set(['db', 'store', 'stores', 'schema', 'migrations', 'models', 'sql', 'sqlite', 'repository'])],
  ['api', new Set(['api', 'routes', 'ipc', 'endpoints', 'handlers'])],
];

const CODE_EXTENSION = /\.[cm]?[jt]sx?$|\.(?:py|go|rs|java|kt|swift|rb|php|cs|css|scss|sql)$/;

/** Tests and docs say nothing about what a feature is. */
function isNonVoting(posix: string): boolean {
  return (
    /(?:^|\/)(?:__tests__|__mocks__|e2e|fixtures|test|tests|spec|specs|docs)\//.test(posix) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(posix) ||
    /\.(?:md|mdx|txt|png|jpe?g|gif|svg)$/i.test(posix)
  );
}

/**
 * The role one path votes for. PRECEDENCE: the DEEPEST segment that is a role
 * word wins (`app/src/main/renderer-bridge/db/x.ts` → data), a filename's own
 * words counting as the deepest segment. A code path with no word is `logic`;
 * anything else does not vote.
 */
function voteForPath(path: string): FeatureRole | null {
  const posix = path.replace(/\\/g, '/').replace(/^\.\//, '');
  if (posix === '' || isNonVoting(posix)) return null;
  const segments = posix.split('/').filter((s) => s !== '');
  const last = segments.pop();
  if (last === undefined) return null;
  const base = last.replace(/\.[^.]+$/, '');
  const ordered = [...segments.map((s) => [s.toLowerCase()]), base.toLowerCase().split(/[-_.]/)];
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    for (const word of ordered[i] ?? []) {
      for (const [role, words] of PATH_WORDS) {
        if (words.has(word)) return role;
      }
    }
  }
  const isCode = CODE_EXTENSION.test(last) || segments.includes('src') || segments.length > 0;
  return isCode ? 'logic' : null;
}

function voteForAnchor(anchor: string): FeatureRole | null {
  const typed = /^([a-z]+):(.*)$/.exec(anchor);
  if (typed === null) return voteForPath(anchor);
  const [, kind = '', rest = ''] = typed;
  if (kind === 'endpoint') return 'api';
  if (kind === 'datastore') return 'data';
  if (kind === 'integration') return 'integration';
  if (kind === 'module' || kind === 'file') return voteForPath(rest);
  return null;
}

/** One role from a feature's or part's anchors. Most votes wins; a tie or no vote is `neutral`. */
export function guessFeatureRole(anchors: readonly string[]): FeatureRole {
  const tally = new Map<FeatureRole, number>();
  for (const anchor of anchors) {
    const role = voteForAnchor(anchor);
    if (role !== null) tally.set(role, (tally.get(role) ?? 0) + 1);
  }
  let best: FeatureRole = 'neutral';
  let bestCount = 0;
  let tied = false;
  for (const role of FEATURE_ROLES) {
    const count = tally.get(role) ?? 0;
    if (count === 0) continue;
    if (count > bestCount) {
      best = role;
      bestCount = count;
      tied = false;
    } else if (count === bestCount) {
      tied = true;
    }
  }
  return tied ? 'neutral' : best;
}

function normalise(value: string | null | undefined): FeatureRole | null {
  if (typeof value !== 'string') return null;
  const clean = value.trim().toLowerCase();
  return isFeatureRole(clean) ? clean : null;
}

/** A valid person role, else a valid learned role, else the guess. Off-list values count as absent. */
export function resolveFeatureRole(input: {
  role?: string | null;
  learnedRole?: string | null;
  anchors: readonly string[];
}): { role: FeatureRole; source: FeatureRoleSource } {
  const person = normalise(input.role);
  if (person !== null) return { role: person, source: 'person' };
  const learned = normalise(input.learnedRole);
  if (learned !== null) return { role: learned, source: 'learn' };
  return { role: guessFeatureRole(input.anchors), source: 'guess' };
}
