/**
 * Which Tier-2 claim files can actually be ADJUDICATED (#1130).
 *
 * The trust-tier contract counts foreign images as Tier-2 claims alongside
 * docs, and the learn pass offered every claim file to the model. But the
 * learn/verify sessions are caged TEXT readers (Read/Grep/Glob, no vision), so
 * an image could only ever come back `unverifiable` — the prompt said so
 * outright ("For images, return `unverifiable` unless the code plainly confirms
 * their content"). The cost was prompt budget spent on rows that could never
 * resolve, and a Docs-by-trust-tier list full of permanently-unverified image
 * entries whose Verify button did nothing.
 *
 * Images keep their claim TIER — that classification is right; an image beside
 * the code is still an unverified statement about it — but every surface that
 * adjudicates filters them through this one predicate.
 */

/** Image extensions that carry a claim tier but cannot be read by a text agent. */
const CLAIM_IMAGE_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.svg',
  '.gif',
  '.webp',
  '.avif',
  '.ico',
] as const

/** True when a repo-relative path is a claim-tier image (case-insensitive). */
export function isClaimImagePath(relPath: string): boolean {
  const lowered = relPath.split('\\').join('/').toLowerCase()
  return CLAIM_IMAGE_EXTENSIONS.some((extension) => lowered.endsWith(extension))
}

/** Only the claim files a text-reading agent can actually adjudicate. */
export function adjudicableClaimPaths<T extends { path: string }>(files: readonly T[]): T[] {
  return files.filter((file) => !isClaimImagePath(file.path))
}
