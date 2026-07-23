<div align="center">

<p align="center">
  <img src="https://raw.githubusercontent.com/nxfu/binthere/main/public/img/wordmark-dark.svg" width="275" alt="binthere wordmark">
</p>

<h1 align="center"><strong>Say it once. <em>Sealed.</em></strong></h1>

<p align="center">Zero-knowledge, end-to-end encrypted notes that disappear after one read — from your terminal.</p>

<p align="center">
  <a href="https://binthere.gaury.dev">Try it live</a> ·
  <a href="https://github.com/nxfu/binthere#readme">Project README</a> ·
  <a href="https://github.com/nxfu/binthere/blob/main/SPEC.md">Documentation</a> ·
  <a href="https://github.com/nxfu/binthere/issues">Report a bug</a>
</p>

</div>

Command-line client for [binthere](https://github.com/nxfu/binthere) — a zero-knowledge,
end-to-end encrypted pastebin. Content is encrypted locally with AES-256-GCM **before** any
network request; the decryption key travels in the URL `#fragment` and is never sent to the
server. The CLI implements the same frozen protocol as the web client
([`SPEC.md`](https://github.com/nxfu/binthere/blob/main/SPEC.md)), verified against the same
pinned test vectors.

Zero runtime dependencies — Node ≥ 20 built-ins only (WebCrypto, `CompressionStream`,
`fetch`, `node:util` `parseArgs`).

<p align="center">
  <a href="https://www.npmjs.com/package/binthere"><img alt="npm" height="28" src="https://ziadoua.github.io/m3-Markdown-Badges/badges/npm/npm3.svg"></a>
  <a href="https://github.com/nxfu/binthere/blob/main/cli/package.json"><img alt="Node.js" height="28" src="https://ziadoua.github.io/m3-Markdown-Badges/badges/NodeJS/nodejs3.svg"></a>
  <img alt="JavaScript" height="28" src="https://ziadoua.github.io/m3-Markdown-Badges/badges/Javascript/javascript3.svg">
  <a href="./LICENSE"><img alt="MIT License" height="28" src="https://ziadoua.github.io/m3-Markdown-Badges/badges/LicenceMIT/licencemit3.svg"></a>
</p>

## Install

```bash
npm install -g binthere
# or run without installing:
npx binthere --help
```

Every note has the same lifecycle as the website: **it deletes after one read, or after
24 hours** — whichever comes first. There is nothing to configure.

## Usage

### Interactive: just type `binthere`

On a terminal, a bare `binthere` opens a full-screen menu — the wordmark materialises in
glyph by glyph, then pick an action with the arrow keys (or `1`–`3`) and confirm with Enter:

```text
 binthere

     ✦
 ██▄ █ █▄ █ ▀█▀ █▄█ ██▀ █▀▄ ██▀
 █▄█ █ █ ▀█  █  █ █ █▄▄ █▀▄ █▄▄

 Zero-knowledge encrypted notes.
 encrypted locally · one read · gone in 24 hours

 server  https://binthere.gaury.dev

 ╭───────────────────────────────────────────────────────────╮
 │ ❯ 1 Create a note   write, seal, and get a one-time link  │
 │   2 View a note     paste a share URL — reading burns it  │
 │   3 Delete a note   remove it early with the delete token │
 ╰───────────────────────────────────────────────────────────╯

 ↑↓ move  ·  ↵ select  ·  1-3 jump  ·  ^c quit
```

- **Create** — write (or paste) your note on its own screen, press **Ctrl+Q** to seal it,
  optionally add a password, and get the share link, a scannable **terminal QR code**, and
  the delete token on a result screen (the typed note is cleared from view; a shine beam
  sweeps the wordmark now and then while you decide). Press **c**
  there to copy the link to the clipboard, **t** for the delete token — via the platform's
  native tool (`clip` / `pbcopy` / `wl-copy` / `xclip` / `xsel`, fed over stdin so secrets
  never hit argv), with an OSC 52 escape fallback that works over SSH.
- **View** — paste a share URL; the note is decrypted locally after the usual
  destructive-read confirmation (a wrong password never burns it).
- **Delete** — paste the share URL or id and the delete token from create time.

All decoration is drawn on stderr; only machine-readable output (the share URL on create,
the plaintext on view) goes to stdout, so `binthere | pbcopy` (macOS) or `binthere | clip`
(Windows) still copies just the link. Colors follow the website's palette, degrade to
16-color terminals, and switch off entirely under `NO_COLOR` or when stderr is not a TTY.

### Scripting

```bash
# Encrypt stdin, print the share URL
git diff | binthere create

# When stdin is piped — or --text is given — "create" is the default command
cat notes.md | binthere
binthere -t "meet at 6"

# From a file, password-protected, machine-readable output
binthere create --file secrets.txt --password --json

# Fetch and decrypt ("view" is an alias for "get"; -y skips the burn confirmation)
binthere get 'https://binthere.gaury.dev/p/<id>#<key>'
binthere view 'https://binthere.gaury.dev/p/<id>#<key>' -y

# Delete with the token printed at create time
BT_TOKEN=... binthere delete <share-url-or-id> --token-env BT_TOKEN
```

### `binthere create [flags]`

Reads content from stdin (or `--text` / `--file`), encrypts it locally, uploads only
ciphertext, and prints the share URL on **stdout** — the delete token and lifecycle note go
to **stderr**, so `binthere create | pbcopy` copies just the link.

| Flag | Meaning |
| --- | --- |
| `-t, --text <string>` | Use the given string as the note content |
| `-f, --file <path>` | Read content from a file instead of stdin |
| `--fmt <fmt>` | `plaintext` (default), `code`, `markdown` (affects web rendering) |
| `--password` | Prompt for a password (hidden; never a flag value) |
| `--password-env <VAR>` | Read the password from an environment variable (for scripts) |
| `-q, --qr` | Also print a scannable QR code (to stderr) |
| `-j, --json` | Print `{url, id, deletetoken, expire, burn}` as JSON |

### `binthere get <share-url | ->` (alias: `view`)

Fetches and decrypts a note; plaintext goes to stdout (or `--out <path>`). Pass `-` to read
the share URL from stdin.

Reading uses the same safe flow as the browser: a non-consuming metadata peek verifies the
password **before** the single destructive read, so a wrong password never burns the note.
The destructive read asks for confirmation on a TTY (`--yes` skips it).

| Flag | Meaning |
| --- | --- |
| `-o, --out <path>` | Write plaintext to a file instead of stdout |
| `-y, --yes` | Skip the burn-after-read confirmation |
| `--password-env <VAR>` | Read the password from an environment variable |

### `binthere delete <share-url | id>`

Deletes a paste using its delete token (prompted, or `--token-env <VAR>`). The token is sent
only in the `X-Delete-Token` header, never in a URL.

### Global

| Flag / env | Meaning |
| --- | --- |
| `-s, --server <url>` | API origin for `create`/`delete` (default `$BINTHERE_SERVER`, then `https://binthere.gaury.dev`); `get` takes it from the share URL |
| `--help`, `--version` | The usual |

HTTPS is enforced for every server except `localhost` / `127.0.0.1` (for `wrangler dev`).

**Exit codes:** `0` ok · `1` crypto/API error · `2` usage error. Distinct messages
distinguish "not found / expired" (404) from "already burned" (410).

### Self-hosted instances

The CLI defaults to the public server at `https://binthere.gaury.dev`, but it speaks the same
frozen protocol as any [self-hosted binthere](https://github.com/nxfu/binthere#self-hosting),
so you can point it at your own deployment. There are three ways to set the server, in order
of precedence:

- **`-s, --server <url>`** — per-command, e.g.
  `binthere create --server https://paste.example.com`.
- **`$BINTHERE_SERVER`** — set it once in your shell to make every `create`/`delete` use your
  instance: `export BINTHERE_SERVER=https://paste.example.com`.
- **The share URL** — `get`/`view`/`delete` read the origin straight from the URL you pass, so
  fetching from a self-hosted instance needs no extra config:
  `binthere get 'https://paste.example.com/p/<id>#<key>'`.

```bash
# One-off against your own instance
binthere create -t "hello" --server https://paste.example.com

# Or make it the default for the session
export BINTHERE_SERVER=https://paste.example.com
git diff | binthere            # uploads to paste.example.com
```

HTTPS is required for every server except `localhost` / `127.0.0.1`, so a local
`npm run dev` / `wrangler dev` instance works over plain HTTP:
`binthere create --server http://127.0.0.1:8787`.

## Security notes

- **The share URL is the secret.** Anyone with the full URL (and the password, if set) can
  read the paste. Command-line arguments are visible to other local processes and may land
  in shell history — on shared machines prefer `echo '<url>' | binthere get -` so the URL
  never appears in argv.
- **`--text` puts the note itself in argv** (shell history, process listings). It's for
  quick throwaway notes — pipe stdin or use `--file` for anything sensitive.
- **Passwords and delete tokens are never accepted as plain flag values** — only via a
  hidden interactive prompt or `--password-env` / `--token-env`, so they cannot leak into
  shell history or process listings.
- The fragment key never leaves the process except inside the printed share URL; it is
  never sent to the server in any request.
- The zero-knowledge boundary and its limits (metadata, deployment compromise) are
  documented in the project's
  [`SECURITY.md`](https://github.com/nxfu/binthere/blob/main/SECURITY.md).

## How it relates to the repo

This package lives in the [`cli/`](https://github.com/nxfu/binthere/tree/main/cli)
subdirectory of the binthere repo. The modules in `vendor/` are byte-identical copies of the
repo's shared `public/js/{bytes,format,crypto,qrcode}.js` (the crypto files are the single
source of truth for protocol v1; `qrcode.js` is vendored as `qrcode.cjs` for Node's CommonJS
loader); a CI test fails on any drift, and `node scripts/sync-shared.mjs` re-aligns them.

**Publishing is monorepo-only:** `npm publish` runs a prepack gate (vendor-drift check +
test suite) that reads the repo's `public/js/` and the root install's vitest, so it must run
from a full clone of the repo — never from a standalone copy of this directory. Releases are
normally cut by CI from a `cli-v*` tag; see the repo's CONTRIBUTING.md "Releasing".

## License

[MIT](./LICENSE) © 2026 nxfu

---

<p align="center">
  Built to be shared once and forgotten.<br>
  If binthere is useful to you, consider giving it a ⭐ — it helps others find it.
</p>
