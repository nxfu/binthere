// theme.js — ANSI paint functions matching the website's brand (iron-gall blue
// accent, wax-seal red for destruction), with graceful degradation: truecolor
// when the terminal advertises it, basic 16-color otherwise, plain text when
// stderr is not a TTY, NO_COLOR is set, or TERM=dumb (Emacs shell buffers and
// friends render escape sequences as literal garbage).
const ESC = String.fromCharCode(0x1b);

export function makeTheme(io) {
  const on = io.stderrIsTTY === true && io.env.NO_COLOR === undefined && io.env.TERM !== 'dumb';
  const truecolor = io.env.COLORTERM === 'truecolor' || io.env.COLORTERM === '24bit'
    || io.env.WT_SESSION !== undefined;
  const paint = (code) => (s) => (on ? `${ESC}[${code}m${s}${ESC}[0m` : s);
  return {
    on,
    truecolor,
    bold: paint('1'),
    dim: paint('2'),
    // Brand colors brightened for readability on dark terminals.
    accent: paint(truecolor ? '38;2;106;148;186' : '34'),
    danger: paint(truecolor ? '38;2;192;85;74' : '31'),
  };
}
