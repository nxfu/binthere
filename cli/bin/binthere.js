#!/usr/bin/env node
import process from 'node:process';
import { run } from '../src/cli.js';
import { SHOW_CURSOR, RESET_BG } from '../src/tui/screen.js';

// The wizard hides the cursor, repaints the terminal background (OSC 11) and
// puts stdin in raw mode; its try/finally restores all three — but a signal
// (external SIGINT/SIGTERM/SIGHUP) or process.exit() bypasses finally and
// would strand the user's terminal. Restore unconditionally on the way out:
// the sequences are idempotent and no-ops on an untouched terminal.
const restoreTerminal = () => {
  if (process.stderr.isTTY) process.stderr.write(SHOW_CURSOR + RESET_BG);
  if (process.stdin.isTTY && process.stdin.isRaw) process.stdin.setRawMode(false);
};
process.on('exit', restoreTerminal);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    restoreTerminal();
    // Re-raise with the default disposition so the exit status stays correct.
    process.removeAllListeners(sig);
    process.kill(process.pid, sig);
  });
}

// `binthere get … | head` closes stdout mid-write on Unix; exit quietly like
// any well-behaved pipeline citizen instead of crashing with an uncaught
// EPIPE. A vanished stderr is ignored — stdout may still have a consumer.
process.stdout.on('error', (e) => {
  if (e.code === 'EPIPE') process.exit(0);
  throw e;
});
process.stderr.on('error', (e) => {
  if (e.code !== 'EPIPE') throw e;
});

process.exitCode = await run(process.argv.slice(2));
