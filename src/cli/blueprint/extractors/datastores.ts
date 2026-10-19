/**
 * Datastore extractor — detects data stores from four signals:
 *
 * 1. ORM configs: `schema.prisma` (models become tables), `drizzle.config.*`,
 *    `knexfile.*`.
 * 2. Migration directories: any directory named `migrations` (prisma/drizzle
 *    dirs are folded into their ORM nodes).
 * 3. Raw `.sql` files: `CREATE TABLE` names are attributed to the enclosing
 *    ORM/migration node when possible, otherwise aggregated into a generic
 *    SQL node.
 * 4. Database client usage: imports/requires (and package.json deps) of
 *    better-sqlite3, pg, mysql2, mongodb, redis/ioredis, etc.
 *
 * Node id convention: `datastore:<name>` (migration dirs get
 * `datastore:migrations:<dir>` for uniqueness). Table names land in
 * `meta.tables`. Output is deterministic and unreadable files never throw.
 */

import { join } from 'node:path';
import type { BlueprintNode } from '../types.js';
import {
  collectDependencyNames,
  isSourceFile,
  isTestFile,
  readFileSafe,
  readPackageJsonSafe,
  sortNodes,
  walkRepo,
  type ExtractorFragment,
  type RepoScan,
} from './scan.js';

/** One database client mapping: package name → datastore. */
interface DatastoreClient {
  /** Package name imported/required or declared as a dependency. */
  dep: string;
  /** Datastore name used in the node id (`datastore:<name>`). */
  name: string;
  /** Human-readable label. */
  label: string;
}

/** Curated map of database client packages. */
const DATASTORE_CLIENTS: DatastoreClient[] = [
  // prisma: the schema signal creates the node (name 'prisma'); this entry
  // exists so @prisma/client IMPORTERS attach as importingFiles → real
  // per-module `uses` edges (#orphan cards — the schema dir owns no code).
  { dep: '@prisma/client', name: 'prisma', label: 'Prisma' },
  { dep: 'better-sqlite3', name: 'sqlite', label: 'SQLite (better-sqlite3)' },
  { dep: 'sqlite3', name: 'sqlite', label: 'SQLite (sqlite3)' },
  { dep: 'pg', name: 'postgres', label: 'PostgreSQL (pg)' },
  { dep: 'postgres', name: 'postgres', label: 'PostgreSQL (postgres)' },
  { dep: 'mysql2', name: 'mysql', label: 'MySQL (mysql2)' },
  { dep: 'mysql', name: 'mysql', label: 'MySQL (mysql)' },
  { dep: 'mongodb', name: 'mongodb', label: 'MongoDB (mongodb)' },
  { dep: 'mongoose', name: 'mongodb', label: 'MongoDB (mongoose)' },
  { dep: 'redis', name: 'redis', label: 'Redis (redis)' },
  { dep: 'ioredis', name: 'redis', label: 'Redis (ioredis)' },
];

/** Prisma model declarations inside schema.prisma. */
const PRISMA_MODEL_PATTERN = /^\s*model\s+(\w+)\s*\{/gm;

/** CREATE TABLE statements inside raw .sql files. */
const CREATE_TABLE_PATTERN = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?([\w.]+)[`"']?/gi;

/** Directory names that mark an ORM root, folded into the ORM node. */
const PRISMA_DIR_NAME = 'prisma';
const DRIZZLE_DIR_NAME = 'drizzle';
const MIGRATIONS_DIR_NAME = 'migrations';

/** Whether a repo-relative posix path contains a directory segment. */
function hasDirSegment(relPath: string, dirName: string): boolean {
  return relPath.split('/').slice(0, -1).includes(dirName);
}

/** The repo-relative path of the nearest directory named `dirName`, if any. */
function dirOfSegment(relPath: string, dirName: string): string | null {
  const segments = relPath.split('/');
  const index = segments.lastIndexOf(dirName);
  if (index === -1 || index === segments.length - 1) {
    return null;
  }
  return segments.slice(0, index + 1).join('/');
}

/** Build an import/require detector for a package name. */
function importPatternFor(packageName: string): RegExp {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:from\\s+|require\\s*\\(\\s*)[\`'"]${escaped}[\`'"]`);
}

/**
 * Detect data stores for a repository.
 * Returns datastore nodes (no edges) plus coverage notes; unreadable files
 * are skipped and counted, never thrown on. `repoScan` (optional) reuses a
 * pre-computed `walkRepo` result; omitted, this walks itself.
 */
export function extractDatastores(repoRoot: string, repoScan?: RepoScan): ExtractorFragment {
  const coverageNotes: string[] = [];
  const nodesById = new Map<string, BlueprintNode>();
  const scan = repoScan ?? walkRepo(repoRoot);
  let unreadableFiles = 0;

  const readTracked = (relPath: string): string | null => {
    const content = readFileSafe(join(repoRoot, relPath));
    if (content === null) {
      unreadableFiles += 1;
    }
    return content;
  };

  const addTables = (nodeId: string, tables: string[]): void => {
    const node = nodesById.get(nodeId);
    if (node === undefined || tables.length === 0) {
      return;
    }
    const existing = Array.isArray(node.meta?.tables) ? node.meta.tables : [];
    const merged = [...new Set([...existing, ...tables])].sort();
    nodesById.set(nodeId, { ...node, meta: { ...node.meta, tables: merged } });
  };

  // Signal 1 — ORM configs
  const prismaSchemas = scan.files.filter((f) => f.endsWith('schema.prisma'));
  for (const relPath of prismaSchemas) {
    const content = readTracked(relPath);
    if (content === null) {
      continue;
    }
    const models = [...content.matchAll(PRISMA_MODEL_PATTERN)].map((m) => m[1]).sort();
    if (!nodesById.has('datastore:prisma')) {
      nodesById.set('datastore:prisma', {
        id: 'datastore:prisma',
        kind: 'datastore',
        label: 'Prisma',
        sourceFile: relPath,
        meta: {},
      });
    }
    addTables('datastore:prisma', models);
  }

  const drizzleConfigs = scan.files.filter((f) => /(^|\/)drizzle\.config\.\w+$/.test(f));
  if (drizzleConfigs.length > 0) {
    nodesById.set('datastore:drizzle', {
      id: 'datastore:drizzle',
      kind: 'datastore',
      label: 'Drizzle',
      sourceFile: drizzleConfigs[0],
      meta: {},
    });
  }

  const knexfiles = scan.files.filter((f) => /(^|\/)knexfile\.\w+$/.test(f));
  if (knexfiles.length > 0) {
    nodesById.set('datastore:knex', {
      id: 'datastore:knex',
      kind: 'datastore',
      label: 'Knex',
      sourceFile: knexfiles[0],
      meta: {},
    });
  }

  // Signal 2 — migration directories (excluding prisma/drizzle dirs, which
  // fold into their ORM nodes)
  const migrationDirs = new Set<string>();
  for (const relPath of scan.files) {
    const migrationsDir = dirOfSegment(relPath, MIGRATIONS_DIR_NAME);
    if (
      migrationsDir !== null &&
      !hasDirSegment(relPath, PRISMA_DIR_NAME) &&
      !hasDirSegment(relPath, DRIZZLE_DIR_NAME)
    ) {
      migrationDirs.add(migrationsDir);
    }
  }
  for (const dir of [...migrationDirs].sort()) {
    nodesById.set(`datastore:migrations:${dir}`, {
      id: `datastore:migrations:${dir}`,
      kind: 'datastore',
      label: `Migrations (${dir})`,
      sourceFile: dir,
      meta: {},
    });
  }

  // Signal 3 — raw .sql files: CREATE TABLE names attributed to the
  // enclosing ORM/migration node, else aggregated into a generic SQL node
  const sqlFiles = scan.files.filter((f) => f.endsWith('.sql'));
  const looseSqlTables = new Set<string>();
  let firstLooseSqlFile: string | null = null;

  for (const relPath of sqlFiles) {
    const content = readTracked(relPath);
    if (content === null) {
      continue;
    }
    const tables = [...content.matchAll(CREATE_TABLE_PATTERN)].map((m) => m[1]);

    const migrationsDir = dirOfSegment(relPath, MIGRATIONS_DIR_NAME);
    if (hasDirSegment(relPath, DRIZZLE_DIR_NAME) && nodesById.has('datastore:drizzle')) {
      addTables('datastore:drizzle', tables);
    } else if (hasDirSegment(relPath, PRISMA_DIR_NAME) && nodesById.has('datastore:prisma')) {
      addTables('datastore:prisma', tables);
    } else if (migrationsDir !== null && nodesById.has(`datastore:migrations:${migrationsDir}`)) {
      addTables(`datastore:migrations:${migrationsDir}`, tables);
    } else {
      for (const table of tables) {
        looseSqlTables.add(table);
      }
      if (firstLooseSqlFile === null) {
        firstLooseSqlFile = relPath;
      }
    }
  }

  if (firstLooseSqlFile !== null) {
    nodesById.set('datastore:sql', {
      id: 'datastore:sql',
      kind: 'datastore',
      label: 'SQL files',
      sourceFile: firstLooseSqlFile,
      meta: { tables: [...looseSqlTables].sort() },
    });
  }

  // Signal 4 — database client usage (imports first for a real sourceFile,
  // package.json dependency as fallback). Test/fixture files skipped (#538/#901)
  // so a mock client in `redis.server.test.ts` never anchors the datastore node.
  const sourceFiles = scan.files.filter((relPath) => isSourceFile(relPath) && !isTestFile(relPath));
  const packageJson = readPackageJsonSafe(repoRoot);
  const dependencyNames = packageJson === null ? [] : collectDependencyNames(packageJson);
  let clientCount = 0;

  const MAX_IMPORTING_FILES = 12;
  for (const client of DATASTORE_CLIENTS) {
    const id = `datastore:${client.name}`;
    // Importing files feed per-module `uses` edges even when an earlier signal
    // (e.g. the prisma schema, whose dir owns no code files) created the node —
    // otherwise the datastore renders as an edge-less orphan (#orphan cards).
    const pattern = importPatternFor(client.dep);
    const importers: string[] = [];
    for (const relPath of sourceFiles) {
      if (importers.length >= MAX_IMPORTING_FILES) break;
      const content = readFileSafe(join(repoRoot, relPath));
      if (content !== null && pattern.test(content)) {
        importers.push(relPath);
      }
    }
    const existing = nodesById.get(id);
    if (existing !== undefined) {
      if (importers.length > 0) {
        existing.meta = { ...existing.meta, importingFiles: importers };
      }
      continue;
    }
    const importingFile: string | null = importers[0] ?? null;

    if (importingFile !== null) {
      nodesById.set(id, {
        id,
        kind: 'datastore',
        label: client.label,
        sourceFile: importingFile,
        meta: { client: client.dep, importingFiles: importers },
      });
      clientCount += 1;
    } else if (dependencyNames.includes(client.dep)) {
      nodesById.set(id, {
        id,
        kind: 'datastore',
        label: client.label,
        sourceFile: 'package.json',
        meta: { client: client.dep },
      });
      clientCount += 1;
    }
  }

  coverageNotes.push(
    `datastores: ${prismaSchemas.length} prisma schema(s), ${drizzleConfigs.length} drizzle config(s), ${knexfiles.length} knexfile(s)`,
    `datastores: ${migrationDirs.size} migration director(ies), ${sqlFiles.length} raw .sql file(s)`,
    `datastores: ${clientCount} database client(s) detected`,
  );
  if (unreadableFiles > 0) {
    coverageNotes.push(`datastores: ${unreadableFiles} unreadable file(s) skipped`);
  }

  return { nodes: sortNodes([...nodesById.values()]), edges: [], coverageNotes };
}
