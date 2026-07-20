// clipboard.js — copy text to the system clipboard with zero dependencies.
// First choice is the platform's native tool (clip.exe / pbcopy / wl-copy /
// xclip / xsel) fed over stdin — never argv, so the secret URL/token stays
// out of process listings. When no tool works, fall back to OSC 52: the
// escape sequence asks the terminal emulator itself to set the clipboard,
// which also works over SSH (Windows Terminal, iTerm2, kitty, xterm).
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import os from 'node:os';
import process from 'node:process';

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

/** OSC 52 "set clipboard" sequence carrying `text` as base64. */
export function osc52(text) {
  return `${ESC}]52;c;${Buffer.from(text, 'utf8').toString('base64')}${BEL}`;
}

export function tools(platform, release = '') {
  if (platform === 'win32') return [['clip', []]];
  if (platform === 'darwin') return [['pbcopy', []]];
  const linux = [
    ['wl-copy', []],
    ['xclip', ['-selection', 'clipboard']],
    ['xsel', ['--clipboard', '--input']],
  ];
  // WSL reports platform 'linux' but the Linux-native tools are usually
  // absent; Windows interop exposes clip.exe, so try that first.
  if (/microsoft/i.test(release)) linux.unshift(['clip.exe', []]);
  return linux;
}

function pipeTo(cmd, args, text) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    } catch {
      resolve(false);
      return;
    }
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
    child.stdin.on('error', () => {});
    child.stdin.end(text);
  });
}

/**
 * Copy `text` to the clipboard; resolves true on success. A native tool
 * confirms via its exit code; the OSC 52 fallback is fire-and-forget (the
 * terminal decides silently), so it optimistically counts as success.
 */
export async function copyToClipboard(text, io) {
  for (const [cmd, args] of tools(process.platform, os.release())) {
    if (await pipeTo(cmd, args, text)) return true;
  }
  if (io.stderrIsTTY === true) {
    io.stderr(osc52(text));
    return true;
  }
  return false;
}
