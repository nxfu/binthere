## Summary

What does this change and why?

## Checklist

- [ ] `npm run lint` passes
- [ ] `npm test` passes (all suites green)
- [ ] Crypto/format/AAD changes (if any) updated [`SPEC.md`](./SPEC.md) **first** and regenerated
      the frozen vectors with `node test/genvectors.mjs` (never hand-edited)
- [ ] New behavior has test coverage
- [ ] No secrets, real paste URLs, or key fragments committed

## Notes for reviewers
