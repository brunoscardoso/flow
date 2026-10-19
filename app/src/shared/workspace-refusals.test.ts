import { WORKSPACE_CLI_REFUSALS } from './workspaces-contract'
import { WORKSPACE_REFUSAL_SENTENCES, workspaceRefusalDetail } from './workspace-refusals'

/**
 * The sentences are the whole product surface of a refusal: a person never sees
 * the reason code, only the line it maps to. These pin the two properties that
 * actually went wrong in the field.
 */
describe('workspace refusal sentences', () => {
  it('has a sentence for every reason the CLI can refuse with', () => {
    const missing = WORKSPACE_CLI_REFUSALS.filter((reason) => WORKSPACE_REFUSAL_SENTENCES[reason] === undefined)
    expect(missing).toEqual([])
  })

  /**
   * LIVE INCIDENT (2026-10-16). Joining a Workspace by pasting a repository
   * address refused with `malformed-workspace`, whose sentence reads "A
   * Workspace on this computer can't be read." The repository was a freshly
   * created one holding a README and no `workspace.json` — nothing on the
   * person's computer was wrong at all, and they went looking for a local
   * reset. One reason code was answering for two opposite subjects.
   */
  it('says the REPOSITORY is not a Workspace, without blaming this computer', () => {
    const sentence = workspaceRefusalDetail('not-a-workspace-repo')

    // The positive first: it is about a repository, and it says what to do.
    expect(sentence).toContain('That repository')
    expect(sentence).toContain('empty repository')

    // Only then is the absence evidence of anything (allowed-pattern #28).
    expect(sentence).not.toContain('on this computer')
    expect(sentence).not.toBe(workspaceRefusalDetail('malformed-workspace'))
    expect(workspaceRefusalDetail('malformed-workspace')).toContain('on this computer')
  })

  it('keeps every sentence free of commands, paths and setting names (forbidden-pattern #12)', () => {
    for (const [reason, sentence] of Object.entries(WORKSPACE_REFUSAL_SENTENCES)) {
      expect(`${reason}: ${sentence}`).not.toMatch(/planflow-ai|npm run|`|\.json\b|--[a-z]/)
    }
  })
})
