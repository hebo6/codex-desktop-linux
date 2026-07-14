# Contributing

Thank you for helping improve Codex Desktop Linux

## Before you start

- Search existing issues before proposing a change
- Open an issue before starting a large feature, protocol upgrade, or architectural change
- Keep changes focused and avoid unrelated formatting or generated-file edits
- Do not include credentials, private repository content, or machine-specific paths in commits, fixtures, screenshots, or logs

Security vulnerabilities must follow [SECURITY.md](SECURITY.md) and must not be discussed in a public issue

## Development setup

Follow the [development instructions](README.md#development) in the main README

The project pins JavaScript and Rust dependencies. Use the committed lockfiles and do not update dependencies unless the change requires it

## Required checks

Run the following checks before opening a pull request

```bash
pnpm test
pnpm build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

Update or run focused tests for the behavior being changed. Do not update visual baselines unless the pull request intentionally changes the reviewed interface

## Protocol changes

Files under `protocol/schema` and `src/protocol/generated` are generated artifacts and must not be edited manually

Protocol upgrades start from an upstream Codex checkout at the exact target commit. Set `CODEX_SOURCE_DIR` to that checkout and follow [docs/protocol-baseline.md](docs/protocol-baseline.md)

## Pull requests

- Explain the user-visible problem and the chosen solution
- Include validation evidence and screenshots for intentional interface changes
- Document known limitations and follow-up work
- Keep GitHub-facing titles, descriptions, comments, and commit messages in English
- Confirm that no new third-party material lacks a compatible license or attribution

By submitting a contribution, you agree that it is licensed under the project's [Apache License 2.0](LICENSE)
