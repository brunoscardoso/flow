/**
 * Tests for prompts utilities
 */

import { jest } from '@jest/globals';

// Mock readline/promises
const mockQuestion = jest.fn<(q: string) => Promise<string>>();
const mockClose = jest.fn();

/**
 * `close` handlers the interface under test registered.
 *
 * THE FAKE HAS TO CARRY THE EVENT SURFACE NOW. `prompts.ts` races every
 * question against the interface's `close` event, because that is what EOF on a
 * piped stdin actually raises (#1795) — a fake with only `question` and `close`
 * would prove a module that cannot exist.
 */
let closeHandlers: Array<() => void> = [];

/**
 * The two facts an ended stdin leaves behind, both of which `prompts.ts` reads.
 *
 * `close` fires ONCE, on whichever interface was live when the stream ended.
 * `readableEnded` stays true forever after — which is the only thing a LATER
 * question can consult, and the half that had to be modelled here before this
 * fake could tell the fixed module from the broken one.
 */
const fakeStdin = { readableEnded: false };
const stdoutWrites: string[] = [];

jest.unstable_mockModule('node:process', () => ({
  stdin: fakeStdin,
  stdout: {
    write: (chunk: string): boolean => {
      stdoutWrites.push(chunk);
      return true;
    },
  },
}));

/** Raise `close` and leave the stream ended, the way a piped stdin does. */
function endStdin(): void {
  fakeStdin.readableEnded = true;
  const handlers = closeHandlers;
  closeHandlers = [];
  for (const handler of handlers) handler();
}

jest.unstable_mockModule('node:readline/promises', () => ({
  createInterface: jest.fn(() => ({
    question: mockQuestion,
    close: mockClose,
    once: (event: string, handler: () => void) => {
      if (event === 'close') closeHandlers.push(handler);
    },
  })),
}));

const { askBusinessContext } = await import('./prompts.js');

describe('askBusinessContext', () => {
  beforeEach(() => {
    mockQuestion.mockReset();
    mockClose.mockReset();
    closeHandlers = [];
    fakeStdin.readableEnded = false;
    stdoutWrites.length = 0;
  });

  it('should return user answers from 3 prompts', async () => {
    mockQuestion
      .mockResolvedValueOnce('A CLI tool for workflows')
      .mockResolvedValueOnce('Developers')
      .mockResolvedValueOnce('Automates repetitive tasks');

    const result = await askBusinessContext();

    expect(result).toEqual({
      whatItDoes: 'A CLI tool for workflows',
      targetAudience: 'Developers',
      problemItSolves: 'Automates repetitive tasks',
    });
    expect(mockQuestion).toHaveBeenCalledTimes(3);
    expect(mockClose).toHaveBeenCalled();
  });

  it('should use readmeHint as default for first question when user presses enter', async () => {
    mockQuestion
      .mockResolvedValueOnce('')  // empty = use default
      .mockResolvedValueOnce('Teams')
      .mockResolvedValueOnce('Saves time');

    const result = await askBusinessContext('A great project');

    expect(result.whatItDoes).toBe('A great project');
    expect(result.targetAudience).toBe('Teams');
    expect(result.problemItSolves).toBe('Saves time');
  });

  it('should allow user to override readmeHint', async () => {
    mockQuestion
      .mockResolvedValueOnce('Custom description')
      .mockResolvedValueOnce('End users')
      .mockResolvedValueOnce('Makes life easier');

    const result = await askBusinessContext('A great project');

    expect(result.whatItDoes).toBe('Custom description');
  });

  it('should return empty strings when user provides no input and no hint', async () => {
    mockQuestion
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('');

    const result = await askBusinessContext();

    expect(result.whatItDoes).toBe('');
    expect(result.targetAudience).toBe('');
    expect(result.problemItSolves).toBe('');
  });

  it('should close readline interface even on error', async () => {
    mockQuestion.mockRejectedValueOnce(new Error('readline error'));

    await expect(askBusinessContext()).rejects.toThrow('readline error');
    expect(mockClose).toHaveBeenCalled();
  });

  it('takes the empty answer on EOF rather than never settling (#1795)', async () => {
    // What a piped stdin does at the end of its input: the question's promise
    // stays PENDING forever and `close` fires instead. Awaiting the first one
    // alone is how `init` came to exit 0 mid-install, having printed a prompt
    // and nothing after it.
    mockQuestion.mockImplementation(() => {
      queueMicrotask(endStdin);
      return new Promise<string>(() => {
        // never settles — this is the bug, not a simplification of it
      });
    });

    await expect(askBusinessContext('A great project')).resolves.toEqual({
      // Each caller's own documented default still applies to the empty answer.
      whatItDoes: 'A great project',
      targetAudience: '',
      problemItSolves: '',
    });
    expect(mockClose).toHaveBeenCalled();
  });

  it('lets an answer that arrived win over the close that follows it (#1795)', async () => {
    // `close` comes AFTER the line, not instead of it — a piped answer is still
    // an answer, and racing the two must not turn it into a default.
    mockQuestion
      .mockResolvedValueOnce('A CLI tool')
      .mockImplementationOnce(() => {
        queueMicrotask(endStdin);
        return new Promise<string>(() => {});
      })
      .mockImplementationOnce(() => new Promise<string>(() => {}));

    await expect(askBusinessContext()).resolves.toEqual({
      whatItDoes: 'A CLI tool',
      targetAudience: '',
      problemItSolves: '',
    });
  });

  it('still prints a question it answers for you — no transcript ends mid-line (#1795)', () => {
    // How this stayed invisible: the log's last line was the prompt, with
    // nothing after it and a success code. A question that defaults itself says
    // so, so a reader can follow what happened.
    fakeStdin.readableEnded = true;
    mockQuestion.mockImplementation(() => new Promise<string>(() => {}));

    return askBusinessContext().then(() => {
      expect(stdoutWrites.join('')).toContain('Who is the target audience?');
      expect(mockQuestion).not.toHaveBeenCalled();
    });
  });
});
