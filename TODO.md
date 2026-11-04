# binthere implementation TODO

**Repository:** https://github.com/nxfu/binthere  
**Live website:** https://binthere.gaury.dev

This file tracks unfinished work. Items listed as implemented below are already in code and under review; do not reimplement them. Open PRs are not merged or released, so keep their merge dependencies in mind.

## Implemented, pending merge

These changes have been implemented and committed on task branches. They remain unpublished to the stable `main` branch until their PRs are merged.

| Work | PR | State / dependency |
| --- | --- | --- |
| Privacy-preserving anonymous paste statistics | [#3](https://github.com/nxfu/binthere/pull/3) | Open; targets `main` |
| Accurate burn-after-read failure handling | [#4](https://github.com/nxfu/binthere/pull/4) | Open; targets `main` |
| Scheduled GitHub star-count snapshots | [#5](https://github.com/nxfu/binthere/pull/5) | Open; based on #3 |
| Fixed one-time, 24-hour paste lifecycle | [#6](https://github.com/nxfu/binthere/pull/6) | Open; based on #3 |
| Configurable self-hosted site identity | [#7](https://github.com/nxfu/binthere/pull/7) | Open; based on #5 |
| Architecture and self-hosting documentation updates | [#8](https://github.com/nxfu/binthere/pull/8) | Open; based on #3 |
| Playwright browser tests and CI integration | [#9](https://github.com/nxfu/binthere/pull/9) | Open; based on #3 |
| Composer size feedback and format selector | [#10](https://github.com/nxfu/binthere/pull/10) | Open; based on #9 |
| Conventional, explicit CLI interaction | [#11](https://github.com/nxfu/binthere/pull/11) | Open; based on #6 |

The original `feature/anonymous-paste-statistics` checkout may still show some of these edits as uncommitted. The corresponding task branches and PRs contain the reviewed commits; preserve the original checkout until those changes are intentionally reconciled.

## Phase 1: Core correctness, security, and reliability

**Priority:** Fix remaining safety and reliability gaps before expanding functionality.

### 1. Make CLI output-file handling non-destructive

**Priority:** P1 · Medium  
**Areas:** `cli/src/commands/get.js`, `cli/test/cli.test.js`

`get --out` currently opens the destination with write/truncate semantics before a burn paste is consumed. Refuse to overwrite existing files by default. If `--force` is added, define its behavior carefully. Preserve the pre-consume writability check and restrictive `0600` permissions. Handle symlinks and path edge cases safely, and clean up any temporary files after failures.

**Tests:** Existing destination, explicit overwrite, permissions, symlinks, failed consume, and cleanup behavior.

### 2. Add bounded browser API requests

**Priority:** P2 · Medium  
**Areas:** `public/js/api.js`, `public/js/app.js`

Add sensible request timeouts for creation, metadata peeks, burn consumption, deletion, and other API calls that can wait indefinitely. Clean up abort controllers and timers, prevent stale results from updating UI state, and make timeout recovery understandable. A timeout after a consume request is sent remains ambiguous; never treat a local abort as proof the server rolled back the operation.

### 3. Expand browser tests for failure and destructive operations

**Priority:** P2 · Medium  
**Areas:** `browser-tests/flows.spec.js`, `public/js/app.js`

PR #9 adds basic browser flows for create, reveal, burn, download, password retry, and CSP behavior. Remaining coverage should exercise create failures while preserving editor content; 404, 410, and 5xx read/consume distinctions; burn cancellation; lost or timed-out consume responses; delete failures; keyboard accessibility; reduced motion; and loading/timeout recovery.

Keep tests isolated on local Worker state. Never create production pastes during tests.

### 4. Decide on legacy Unicode-password compatibility

**Priority:** P2 · Medium  
**Areas:** `public/js/crypto.js`, `cli/vendor/crypto.js`, `SPEC.md`, test vectors

Investigate whether older v1 pastes using decomposed Unicode password bytes may still exist. The current implementation normalizes passwords to NFC, while older clients may have used original bytes. If useful, add a reader-only fallback, preserve current behavior for new pastes, and test both paths with dedicated vectors. Keep browser and CLI consistent. If the benefit is negligible, document the decision and leave the protocol unchanged.

Do not silently redefine frozen v1 behavior or modify existing vectors.

## Phase 2: Product and protocol opportunities

### 5. Evaluate larger protocol opportunities

**Priority:** P2/P3 · Large to Very Large  
**Areas:** Future protocol specification, browser and CLI clients, backend storage

Treat these as investigations, not commitments.

- **Versioned Argon2id:** Define browser/mobile resource limits, keep v1 decryption compatibility, and produce a full specification and deterministic interoperable vectors before implementation.
- **Encrypted file sharing:** Evaluate demand, chunked authenticated encryption, size limits, Cloudflare storage, resumability, cost, expiry, and deletion. Do not retrofit attachments into frozen v1 text pastes.

Proceed only when the expected value justifies the complexity and maintenance cost.

## Phase 3: Documentation, developer experience, and release readiness

### 6. Revamp the README

**Priority:** P2 · Medium  
**Area:** `README.md`

The current README has received incremental updates, but still needs a cohesive user-focused presentation. Review the BitChord README as an organizational reference without copying content or branding. Include a polished introduction, zero-knowledge explanation, feature highlights, screenshots where useful, quick start, accurate CLI usage, self-hosting links, architecture/security references, contribution guidance, and a realistic roadmap.

### 7. Create a beginner-friendly self-hosting guide

**Priority:** P1/P2 · Medium  
**Areas:** New self-hosting documentation, `README.md`, `wrangler.toml.example`

Document prerequisites, account setup, install/clone/configuration, KV and Durable Object setup, local development, deployment, custom domains, verification, updates, troubleshooting, quotas, and possible charges. Provide copy-ready commands and distinguish required from optional configuration. Explain how to create fresh resources without relying on maintainer IDs, and include a deployment verification checklist.

### 8. Complete contributor, security, and architecture documentation

**Priority:** P2 · Small to Medium  
**Areas:** `CONTRIBUTING.md`, `ARCHITECTURE.md`, `SPEC.md`, `SECURITY.md`, test configuration

PR #8 updates architecture and product documentation. Remaining work should correct contributor instructions, document automated browser coverage and manual gaps, finish deployment requirements, and update security guidance when behavior changes. Keep documents aligned with implementation and avoid claiming untested coverage.

### 9. Maintain a realistic product roadmap

**Priority:** P2 · Small  
**Area:** `README.md`

Review the current public roadmap against shipped and in-progress code. Remove completed or implausible ideas, retain useful unfinished work, and categorize it as planned, under consideration, or long-term. Do not promise undesigned features.

### 10. Qualify hosting and pricing claims

**Priority:** P2 · Small  
**Areas:** `README.md`, self-hosting guide, deployment documentation

The README currently describes the service as hostable “completely free.” Clarify that low-traffic use may fit within Cloudflare free quotas, but quotas and service limits apply and excess usage may cost money or be constrained. Link to official Workers, KV, and Durable Objects pricing. Avoid hardcoding quota values that can become stale, and distinguish maintainer deployment costs from self-hosting costs.

### 11. Establish a clean and verified release baseline

**Priority:** P1 · Medium  
**Areas:** Repository, CI, deployment

Several implementation PRs are open and the original feature checkout contains uncommitted work. Before a release, reconcile those changes deliberately, review the final diff, run the full tests/lint/browser suite, verify crypto vendor parity and vectors, and confirm the intended release commit is deployed. Do not create destructive production pastes during verification. Record checks that cannot be run.

## Ongoing implementation rules

- Preserve frozen v1 crypto compatibility and browser/CLI interoperability.
- Keep burn-after-read validation and consumption ordering safe.
- Avoid unnecessary dependencies and speculative complexity.
- Add tests for meaningful behavior changes and keep documentation synchronized.
- Mark work complete only after implementation and verification; move implemented but unmerged work to the pending-merge table above.
- Preserve existing user changes. Do not commit, push, merge, or deploy without authorization.
