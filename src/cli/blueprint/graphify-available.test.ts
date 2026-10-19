import { graphifyAvailable, type DetectExec } from './graphify-available';

describe('graphifyAvailable (#142)', () => {
  it('is available when `which graphify` succeeds', () => {
    const exec: DetectExec = (command) => {
      expect(command).toBe('which graphify');
      // resolves (no throw) = found
    };
    expect(graphifyAvailable(exec)).toBe(true);
  });

  it('is unavailable when `which graphify` exits non-zero (throws)', () => {
    const exec: DetectExec = () => {
      throw new Error('exit 1');
    };
    expect(graphifyAvailable(exec)).toBe(false);
  });
});
