import { runShell } from './shell';
import { describe, it, expect } from 'vitest';
import path from 'path';

const workdir = path.resolve(__dirname, '../../');

describe('runShell', () => {
  it('should execute a command successfully', async () => {
    const result = await runShell(workdir, 'echo Hello, World!');
    expect(result).toBe('Hello, World!\n[exit 0]');
  });

  it('should handle command errors', async () => {
    const result = await runShell(workdir, 'nonexistent-command');
    expect(result).toContain('[exit 1]');
  });

  it('should handle timeouts', async () => {
    const result = await runShell(workdir, 'sleep 2');
    expect(result).toContain('[timed out after 60s]');
  });
});
