/**
 * Integration extractor — detects external integrations from three signals:
 *
 * 1. SDK dependencies in the root package.json, matched against a curated
 *    map of known hosted-API SDKs (stripe, @anthropic-ai/*, openai, ...).
 * 2. HTTP client call sites (fetch/axios/got/undici) with literal URL first
 *    arguments — one integration node per distinct external host.
 * 3. Webhook mounts — route registrations whose path contains "webhook".
 *
 * Node id conventions: `integration:<name>` for SDKs and hosts,
 * `integration:webhook:<path>` for webhook mounts. Output is deterministic:
 * files are visited in sorted order and nodes are stable-sorted by id.
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

/** One curated SDK mapping: dependency name (or prefix) → integration. */
interface KnownSdk {
  /** Dependency name to match; a prefix when `prefix` is true. */
  dep: string;
  /** Match `dep` as a name prefix instead of an exact name. */
  prefix?: boolean;
  /** Integration name used in the node id (`integration:<name>`). */
  name: string;
  /** Human-readable label. */
  label: string;
}

/** Curated map of dependency names/prefixes that indicate a hosted API SDK. */
const KNOWN_SDK_INTEGRATIONS: KnownSdk[] = [
  { dep: 'stripe', name: 'stripe', label: 'Stripe' },
  { dep: 'openai', name: 'openai', label: 'OpenAI' },
  { dep: '@anthropic-ai/', prefix: true, name: 'anthropic', label: 'Anthropic' },
  { dep: '@slack/', prefix: true, name: 'slack', label: 'Slack' },
  { dep: 'twilio', name: 'twilio', label: 'Twilio' },
  { dep: 'sendgrid', name: 'sendgrid', label: 'SendGrid' },
  { dep: '@sendgrid/', prefix: true, name: 'sendgrid', label: 'SendGrid' },
  { dep: 'aws-sdk', name: 'aws', label: 'AWS' },
  { dep: '@aws-sdk/', prefix: true, name: 'aws', label: 'AWS' },
  { dep: 'octokit', name: 'github', label: 'GitHub' },
  { dep: '@octokit/', prefix: true, name: 'github', label: 'GitHub' },
  { dep: 'firebase', name: 'firebase', label: 'Firebase' },
  { dep: 'firebase-admin', name: 'firebase', label: 'Firebase' },
  { dep: '@supabase/', prefix: true, name: 'supabase', label: 'Supabase' },
  { dep: '@google-cloud/', prefix: true, name: 'google-cloud', label: 'Google Cloud' },
  { dep: '@azure/', prefix: true, name: 'azure', label: 'Azure' },
  { dep: '@sentry/', prefix: true, name: 'sentry', label: 'Sentry' },
  { dep: 'algoliasearch', name: 'algolia', label: 'Algolia' },
  { dep: 'pusher', name: 'pusher', label: 'Pusher' },
  // #901 — modern AI/observability stacks (orbit-app validation target)
  { dep: 'ai', name: 'ai-sdk', label: 'AI SDK' },
  { dep: '@ai-sdk/', prefix: true, name: 'ai-sdk', label: 'AI SDK' },
  { dep: '@opentelemetry/exporter-', prefix: true, name: 'opentelemetry', label: 'OpenTelemetry' },
];

/**
 * HTTP client calls whose first argument is a literal http(s) URL —
 * fetch, axios/axios.<method>, got/got.<method>, and undici.<method>,
 * in single-quote, double-quote, or template-literal form.
 */
const HTTP_CALL_URL_PATTERN =
  /\b(?:fetch|axios(?:\.\w+)?|got(?:\.\w+)?|undici\.\w+)\s*\(\s*[`'"](https?:\/\/[^`'"\s]+)/g;

/** Route registrations whose path literal contains "webhook". */
const WEBHOOK_ROUTE_PATTERN =
  /\.(?:get|post|put|delete|patch|all|use)\s*\(\s*[`'"]([^`'"]*webhook[^`'"]*)[`'"]/gi;

/** Hostnames that indicate a local/loopback target, not an external service. */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

/**
 * Shape of a plausible external hostname: dot-separated alphanumeric/hyphen
 * labels. Filters out placeholder literals (empty labels, bare words) that
 * URL parsing would otherwise accept as hostnames.
 */
const VALID_HOSTNAME_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

/** Match declared dependencies against the curated SDK map. */
function detectSdkIntegrations(dependencyNames: string[]): BlueprintNode[] {
  const byName = new Map<string, BlueprintNode>();

  for (const depName of dependencyNames) {
    for (const sdk of KNOWN_SDK_INTEGRATIONS) {
      const matches = sdk.prefix === true ? depName.startsWith(sdk.dep) : depName === sdk.dep;
      if (!matches) {
        continue;
      }
      if (!byName.has(sdk.name)) {
        byName.set(sdk.name, {
          id: `integration:${sdk.name}`,
          kind: 'integration',
          label: sdk.label,
          sourceFile: 'package.json',
          meta: { dependency: depName, importSpec: sdk.dep, importPrefix: sdk.prefix === true },
        });
      }
      break;
    }
  }

  return [...byName.values()];
}

/** Extract the hostname from a literal URL; null for invalid or local URLs. */
function externalHostOf(url: string): string | null {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    // Not a parseable URL literal (e.g. template with interpolation) — skip
    return null;
  }
  if (LOCAL_HOSTNAMES.has(hostname) || !VALID_HOSTNAME_PATTERN.test(hostname)) {
    return null;
  }
  return hostname;
}

/**
 * Detect external integrations for a repository.
 * Returns integration nodes (no edges) plus coverage notes; never throws on
 * unreadable files — they are skipped and counted. `repoScan` (optional)
 * reuses a pre-computed `walkRepo` result; omitted, this walks itself.
 */
export function extractIntegrations(repoRoot: string, repoScan?: RepoScan): ExtractorFragment {
  const coverageNotes: string[] = [];
  const nodes: BlueprintNode[] = [];

  // Signal 1 — SDK dependencies from package.json
  const packageJson = readPackageJsonSafe(repoRoot);
  if (packageJson === null) {
    coverageNotes.push('integrations: no readable package.json at repo root — SDK detection skipped');
  } else {
    const sdkNodes = detectSdkIntegrations(collectDependencyNames(packageJson));
    nodes.push(...sdkNodes);
    coverageNotes.push(`integrations: ${sdkNodes.length} SDK dependency match(es) from package.json`);
  }

  // Signals 2 + 3 — HTTP call sites and webhook mounts in source files.
  // The same pass also finds each SDK integration's IMPORTING FILES (#orphan
  // integrations): a package.json-anchored node has no owning module, so it
  // rendered edge-less and unlearnable — anchoring at real import sites gives
  // it a home module and per-module `uses` edges.
  const scan = repoScan ?? walkRepo(repoRoot);
  const sourceFiles = scan.files.filter((relPath) => isSourceFile(relPath) && !isTestFile(relPath)); // #538: skip test/fixture files
  const hostNodes = new Map<string, BlueprintNode>();
  const webhookNodes = new Map<string, BlueprintNode>();
  let unreadableFiles = 0;
  const MAX_IMPORTING_FILES = 12;
  const sdkNodes = nodes.filter((node) => typeof node.meta?.importSpec === 'string');
  const importersByNode = new Map<string, string[]>(sdkNodes.map((node) => [node.id, []]));

  for (const relPath of sourceFiles) {
    const content = readFileSafe(join(repoRoot, relPath));
    if (content === null) {
      unreadableFiles += 1;
      continue;
    }

    for (const sdkNode of sdkNodes) {
      const importers = importersByNode.get(sdkNode.id);
      if (importers === undefined || importers.length >= MAX_IMPORTING_FILES) continue;
      const spec = String(sdkNode.meta?.importSpec ?? '');
      const escaped = spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const close = sdkNode.meta?.importPrefix === true ? '' : `['"]`;
      const pattern = new RegExp(`(?:from\\s+|require\\(\\s*|import\\(\\s*)['"]${escaped}${close}`);
      if (pattern.test(content)) importers.push(relPath);
    }

    for (const match of content.matchAll(HTTP_CALL_URL_PATTERN)) {
      const host = externalHostOf(match[1]);
      if (host !== null && !hostNodes.has(host)) {
        hostNodes.set(host, {
          id: `integration:${host}`,
          kind: 'integration',
          label: host,
          sourceFile: relPath,
          meta: { host, detectedVia: 'http-call' },
        });
      }
    }

    for (const match of content.matchAll(WEBHOOK_ROUTE_PATTERN)) {
      const route = match[1];
      if (!webhookNodes.has(route)) {
        webhookNodes.set(route, {
          id: `integration:webhook:${route}`,
          kind: 'integration',
          label: `Webhook ${route}`,
          sourceFile: relPath,
          meta: { route, detectedVia: 'webhook-mount' },
        });
      }
    }
  }

  nodes.push(...hostNodes.values(), ...webhookNodes.values());
  for (const sdkNode of sdkNodes) {
    const importers = importersByNode.get(sdkNode.id) ?? [];
    if (importers.length > 0) {
      sdkNode.sourceFile = importers[0];
      sdkNode.meta = { ...sdkNode.meta, importingFiles: importers };
    }
  }
  coverageNotes.push(
    `integrations: ${hostNodes.size} external host(s) from HTTP client call sites`,
    `integrations: ${webhookNodes.size} webhook mount(s)`,
  );
  if (unreadableFiles > 0) {
    coverageNotes.push(`integrations: ${unreadableFiles} unreadable source file(s) skipped`);
  }
  if (scan.unreadableDirs.length > 0) {
    coverageNotes.push(`integrations: ${scan.unreadableDirs.length} unreadable director(ies) skipped`);
  }

  return { nodes: sortNodes(nodes), edges: [], coverageNotes };
}
