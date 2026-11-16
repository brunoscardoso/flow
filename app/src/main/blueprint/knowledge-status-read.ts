/**
 * The app's reader of knowledge status — the CLI's pure rules
 * (`shared/knowledge-status.ts`) over the two files the CLI writes:
 * `brain/.structure/knowledge-status.jsonl` and `knowledge-provenance.jsonl`.
 * Each is read once per reader, asynchronously (allowed-pattern #19).
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import {
  foldKnowledgeStatus,
  knowledgeItemIdInput,
  knowledgeStatusReaderFrom,
  parseProvenanceRecords,
  type KnowledgeStatusReader,
} from '../../shared/knowledge-status'

const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex')

/** A reader over the two files' text — pure apart from the digest. */
export function knowledgeStatusReaderFromText(statusText: string, provenanceText: string): KnowledgeStatusReader {
  return knowledgeStatusReaderFrom(
    foldKnowledgeStatus(statusText.split('\n')),
    parseProvenanceRecords(provenanceText, sha256Hex),
    (item) => sha256Hex(knowledgeItemIdInput(item)).slice(0, 16),
  )
}

/** A reader over `flowDir`'s files. A missing file reads as empty (everything unstamped is solid). */
export async function readKnowledgeStatusReader(flowDir: string): Promise<KnowledgeStatusReader> {
  const read = (name: string): Promise<string> =>
    fs.readFile(join(flowDir, 'brain', '.structure', name), 'utf8').catch(() => '')
  const [statusText, provenanceText] = await Promise.all([
    read('knowledge-status.jsonl'),
    read('knowledge-provenance.jsonl'),
  ])
  return knowledgeStatusReaderFromText(statusText, provenanceText)
}
