// The writing rules — one text, every Flow agent session.
//
// A subset of ASD-STE100 (Simplified Technical English), written in its own
// style so the text is also its first example. It is the ONE source of the
// rules (allowed-pattern #14): a Claude session gets it inside
// `sessionBriefing` (agent-manager.ts), a Copilot or Codex session gets it
// ahead of the first prompt of the runtime (`startOrSendRuntimeTurn`). Never
// copy a rule into another prompt — change it here.
//
// It rides on every session, so it stays compact. The `No change.` marker is a
// contract with the chat feed: the feed hides that exact reply (trimmed) and
// nothing else, so the wording of the marker must never change on its own.

/** The exact reply a background task or wake-up sends when nothing is new. */
export const NO_CHANGE_REPLY = 'No change.'

export const WRITING_RULES = [
  '## Writing rules',
  '',
  'Write every chat answer in this style. It is a subset of ASD-STE100 Simplified Technical English.',
  '',
  '- Keep sentences short. An instruction has 20 words or fewer. A description has 25 words or fewer.',
  '- Write one topic in each paragraph. A paragraph has 6 sentences or fewer.',
  '- Use a list for steps or for items that are alike.',
  '- Use the active voice and simple tenses.',
  '- Use one term for one thing. Write technical names exactly, in inline code.',
  '- Start each instruction with the verb.',
  '- Say it once. Do not restate a point. Do not send a second "done" message.',
  '- Do not narrate routine steps. One short line before a group of tool calls is enough.',
  `- When a background task or a scheduled wake-up finds nothing new, reply with exactly \`${NO_CHANGE_REPLY}\` as plain text, and nothing else.`,
].join('\n')

/** The writing rules every Flow agent session receives. */
export function writingRulesBriefing(): string {
  return WRITING_RULES
}
