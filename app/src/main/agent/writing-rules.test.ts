import { NO_CHANGE_REPLY, WRITING_RULES, writingRulesBriefing } from './writing-rules'

/** The sentences of a text: headings and list markers dropped, split on end marks. */
function sentencesOf(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*(#+|-|\d+\.)\s+/, '').trim())
    .filter((line) => line.length > 0 && !line.startsWith('Writing rules'))
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0)
}

function wordCount(sentence: string): number {
  return sentence.split(/\s+/).filter((word) => word.length > 0).length
}

describe('writing rules', () => {
  it('is one text: the briefing is the constant', () => {
    expect(writingRulesBriefing()).toBe(WRITING_RULES)
  })

  it('names every rule the chat depends on', () => {
    const text = writingRulesBriefing()
    expect(text).toContain('ASD-STE100')
    expect(text).toContain('20 words or fewer')
    expect(text).toContain('25 words or fewer')
    expect(text).toContain('6 sentences or fewer')
    expect(text).toContain('Use a list for steps')
    expect(text).toContain('active voice and simple tenses')
    expect(text).toContain('one term for one thing')
    expect(text).toContain('inline code')
    expect(text).toContain('Start each instruction with the verb')
    expect(text).toContain('Say it once')
    expect(text).toContain('second "done" message')
    expect(text).toContain('Do not narrate routine steps')
    expect(text).toContain('If `start_subtask` exists')
    expect(text).toContain('Give a subtask only files the current work does not touch')
  })

  it('carries the exact `No change.` marker the feed hides', () => {
    expect(NO_CHANGE_REPLY).toBe('No change.')
    expect(writingRulesBriefing()).toContain('reply with exactly `No change.`')
  })

  it('follows itself: no sentence of the rules is longer than 25 words', () => {
    const sentences = sentencesOf(writingRulesBriefing())
    expect(sentences.length).toBeGreaterThan(10)
    const long = sentences.filter((sentence) => wordCount(sentence) > 25)
    expect(long).toEqual([])
  })

  it('stays compact — it rides on every session', () => {
    expect(writingRulesBriefing().length).toBeLessThan(1200)
  })
})
