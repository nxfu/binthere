// secret.js — resolve a secret (password / delete token) for any command.
// Secrets come from a --*-env variable (scripts: keeps them out of argv/shell
// history/ps) or an interactive hidden prompt — never a bare flag value.
import { UsageError } from './errors.js';

export function resolveSecret({ envVar, promptWanted, promptLabel, io }) {
  if (envVar !== undefined) {
    const value = io.env[envVar];
    if (value === undefined || value === '') {
      throw new UsageError(`environment variable ${envVar} is not set (or empty)`);
    }
    return Promise.resolve(value);
  }
  if (promptWanted) {
    if (!io.stdinIsTTY) {
      throw new UsageError('no TTY to prompt on — use --password-env / --token-env instead');
    }
    return io.promptHidden(promptLabel);
  }
  return Promise.resolve('');
}
