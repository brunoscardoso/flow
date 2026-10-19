import { jest } from '@jest/globals';

const readFileSyncMock = jest.fn<(fd: number, encoding: string) => string>();

jest.unstable_mockModule('node:fs', () => ({
  readFileSync: readFileSyncMock,
}));

const { flagOrStdin, flagOrStdinSync } = await import('./flag-or-stdin.js');

describe('flagOrStdinSync', () => {
  beforeEach(() => {
    readFileSyncMock.mockReset();
  });

  it('returns the flag unchanged when it is not the "-" sentinel', () => {
    expect(flagOrStdinSync('plain text')).toBe('plain text');
    expect(readFileSyncMock).not.toHaveBeenCalled();
  });

  it('returns empty string for an absent flag, without touching stdin', () => {
    expect(flagOrStdinSync(undefined)).toBe('');
    expect(readFileSyncMock).not.toHaveBeenCalled();
  });

  it('reads fd 0 when the flag is exactly "-", stripping a leading BOM', () => {
    readFileSyncMock.mockReturnValue('﻿multi\nline\nbody');
    expect(flagOrStdinSync('-')).toBe('multi\nline\nbody');
    expect(readFileSyncMock).toHaveBeenCalledWith(0, 'utf-8');
  });

  it('trims surrounding whitespace before matching the sentinel', () => {
    readFileSyncMock.mockReturnValue('piped');
    expect(flagOrStdinSync('  -  ')).toBe('piped');
  });

  it('degrades to empty text when stdin cannot be read (no pipe attached)', () => {
    readFileSyncMock.mockImplementation(() => {
      throw new Error('EAGAIN');
    });
    expect(flagOrStdinSync('-')).toBe('');
  });
});

describe('flagOrStdin (async)', () => {
  it('returns the flag unchanged when it is not the "-" sentinel', async () => {
    await expect(flagOrStdin('plain text')).resolves.toBe('plain text');
  });

  it('returns empty string for an absent flag', async () => {
    await expect(flagOrStdin(undefined)).resolves.toBe('');
  });

  it('streams stdin when the flag is exactly "-", stripping a leading BOM', async () => {
    const chunks = ['﻿multi\n', 'line\n', 'body'];
    const fakeStdin = {
      [Symbol.asyncIterator]: async function* (): AsyncGenerator<string> {
        for (const chunk of chunks) yield chunk;
      },
    };
    const original = Object.getOwnPropertyDescriptor(process, 'stdin');
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });
    try {
      await expect(flagOrStdin(' - ')).resolves.toBe('multi\nline\nbody');
    } finally {
      if (original) Object.defineProperty(process, 'stdin', original);
    }
  });
});