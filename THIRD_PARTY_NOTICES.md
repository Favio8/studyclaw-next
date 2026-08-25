# Third-Party Notices

This repository reuses source code from the DeepSeek Harness (dsh) project and
its vendored dependencies, all MIT licensed. The original copyright and license
notices are retained in the copied files and directories.

## deepseek-harness (dsh)

- Source: https://github.com/deepseek-ai/deepseek-harness (local copy used as the upstream)
- License: MIT — Copyright (c) 2026 DeepSeek
- Reused parts: `vendor/*` (cordis family), `packages/runtime-diagnostics/invariants`,
  `packages/storage/*` (storage hub + domain + json + sqlite backends), workspace
  registry algorithms, RPC contract patterns, and engineering scaffolding
  (tsconfig / vitest / workspace configuration).
- Agent parity work also follows the MIT-licensed DSH `packages/core/agent`,
  `packages/core/agent-loop`, `packages/core/tools`, `packages/client/ui-model-selection`,
  `packages/client/ui-tool`, and `packages/client/ui-settings-*` contracts. StudyClaw
  implementations are adapted to its existing package boundaries and learning preset.

## vendored cordis ecosystem (`vendor/`)

- Upstream: cordis 4.0.0-rc.7 and cosmokit / schemastery, MIT licensed,
  vendored and locally modified by the dsh project under the
  `@deepseek-ai/*` scope names (see `vendor/README.md` for the 18 local
  modifications list).
- License: MIT — original copyrights retained per package.

## runtime dependencies

- `zod` — MIT
- `js-yaml` — MIT
- `supports-color` — MIT
- `@standard-schema/spec` — CC-BY 4.0 / MIT
- `node-addon-require-builtin` — MIT
