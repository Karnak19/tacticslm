# Review guidance

- Check documented procedures against the PR's base branch, not just the feature branch or another PR. Flag commands, files, and workflows that only become valid after an unmerged dependency lands; do not assume merge order makes a currently false procedure safe.
- Validate fresh-clone and no-build paths, especially when tests or server startup depend on generated artifacts. A pre-existing build must not hide boot failures or cause meaningful test suites to be skipped while reporting success.
- Look for duplicated work in CI and local gates. If a composite command already performs typechecking or a test command already covers a file, avoid requiring the same work again unless the second invocation verifies a genuinely different artifact.
- Treat exact toolchain pinning as part of reproducible CI. Do not accept a floating runtime alongside a frozen lockfile; keep the pin rationale accurate when the local version changes.
- Do not preserve data exposure merely because an upstream implementation or client behavior does so. Client-side hiding and parity are not secrecy guarantees; sensitive fields should be withheld at the server boundary until the appropriate reveal state.
- Check documentation links and examples for vendored/available targets; remove examples that point to intentionally absent files rather than leaving dead links.
