# OpenClaw v2026.8.1 patch notes

## Compaction summary format

`openclaw-compaction-summary-format.patch` backports the generic summary-format
fix from [OpenClaw PR #138850](https://github.com/openclaw/openclaw/pull/138850),
merged on September 5, 2026 and included in upstream `v2026.9.4`. It does not
include that PR's unrelated local-model capability or context-budget changes.

The old core prompt required `Goal` / `Progress` headings while safeguard added
another exact format under `Additional focus`. The patch introduces a separate
`summaryPrompt` argument: caller-owned formats replace the default template;
identifier rules, operator focus, and quality feedback remain additive. History
and dropped-history summaries use the safeguard's five sections, while a split
turn prefix uses `Original Request` / `Early Progress` / `Context for Suffix`.
The format propagates through chunk updates, stage merges, and fallback calls.
Callers that do not supply a format keep the existing default template.

Regression coverage includes the real safeguard-to-provider prompt path, core
split-turn compaction, and format propagation through chunking and fallback.
For the new standalone coverage, run:

```sh
node node_modules/vitest/vitest.mjs run --config test/vitest/vitest.agents-core.config.ts src/agents/compaction.summary-format.test.ts
```

In ten live calls to the incident's official `deepseek-flash` route, three of
five baseline calls mixed templates, versus none of the five patched calls.
The corpus used recovered request fragments plus synthetic history, not a full
session replay. Both resulting short final summaries passed the quality audit;
this experiment does not establish that the incident's full failure is fixed.

Keep the section-order patch below as a separate safeguard. Upstream `v2026.9.4`
still has the fixed-order retention parser. Remove the format patch when the
pinned runtime includes the equivalent upstream fix, and rebuild the runtime
before shipping either patch.

## Compaction summary section order

`openclaw-compaction-summary-section-order.patch` aligns the summary retention
parser with the quality audit: complete required sections may occur in any
order. Previously, reordering a valid summary disabled protected budgeting and
fell back to prefix truncation, which could remove the exact-identifiers section
and make automatic compaction fail with `guard_blocked`.

The patch retains the 16,000 UTF-16 code-unit limit and quality checks. Missing
or duplicate required sections still fail validation. The regression covers all
120 section permutations with oversized summary content and suffix context.

This defect reproduces the `missing_section,missing_identifiers` combination
seen in the September 14 incident. The exported logs do not contain the model's
raw summary, so they establish the quality-gate failure but do not prove that
section order caused that particular incident. Memory flush was skipped in the
reported failing turns because the current compaction cycle was already marked
as flushed.

Validate from the patched OpenClaw checkout:

```sh
node node_modules/vitest/vitest.mjs run --config test/vitest/vitest.agents-core.config.ts src/agents/agent-hooks/compaction-safeguard.test.ts
```

Rebuild the bundled runtime before packaging this fix. Remove the patch when
the pinned upstream retention parser accepts the same section ordering as its
quality audit.

## Auth migration config commit

`openclaw-auth-migration-config-commit.patch` adds an optional
`persistConfig(cfg): Promise<void>` callback to the upstream auth migration
owner. LobsterAI uses it to persist migrated auth metadata before the owner
archives the original credential files. This boundary is internal to the owner;
writing configuration after the function returns is too late to preserve retry
behavior when the config write fails.

The callback runs only when the current candidate changes configuration, after
any required SQLite import has been verified. It also covers AWS SDK markers
that have no credential rows and config-only credentials that have no source
JSON files. The original source and its existing archive history remain intact
if the callback rejects. Existing callers without the callback are unchanged.

The host callback must persist with optimistic concurrency checks, surface a
failed commit, and retry with freshly loaded configuration. It must not replace
the owner's credential parser or write authentication SQLite tables itself.
LobsterAI holds the upstream stopped-Gateway maintenance lock around this work.

Validation from the LobsterAI checkout, after applying patches and rebuilding
the startup migration helper:

```sh
OPENCLAW_STARTUP_MIGRATION_RUNTIME=<runtime-dir> npm test -- openclawAuthProfileMigration
```

Fixtures use temporary state and synthetic credentials. Required cases include
ordinary non-main-agent migration, marker-only config persistence, failed config
commit followed by retry, and repeated startup without unrelated config changes.
Remove the patch once the pinned upstream owner provides an equivalent commit
boundary.
