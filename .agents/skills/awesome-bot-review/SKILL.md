---
name: awesome-bot-review
description: Review requested code changes in awesome_bot for concrete defects, regressions, permission and data isolation errors. Use for review requests, not implementation work.
---

# Review changes

Consult the project [specifications index](../../../specifications/project/README.md) and relevant sections to understand the affected subsystems. Verify claims against current source code; identify materially outdated specifications when the reviewed changes cause them.

Use directory indexes and the [coverage ledger](../../../specifications/project/coverage.md) to locate entity contracts, canonical command/tool/model sections and related jobs. Read the relevant [test map](../../../specifications/project/test/README.md) entries, then verify actual assertions. Distinguish an intentional contract change agreed in the task from a regression; report stale specification paths/sections separately from confirmed code defects. A coverage-ledger claim does not prove runtime correctness or passing tests. Do not rewrite the project specification during a review-only request; use `awesome-bot-spec-update` when synchronization is requested.

Review the requested scope without changing implementation files unless the user separately requests fixes. Inspect the working tree and relevant diff, then trace changed behavior through callers, VK routing, services, persistence, and tests as needed. Verify project assumptions against current code.

For task reviews read `task.md`, `plan.md` and existing `review.md`. Compare acceptance criteria with actual implementation and the plan's verification evidence. State the comparison basis: requested commits/base revision or the selected working-tree scope, including relevant untracked files. Do not attribute every dirty file to the task. Review the current implementation rather than treating a plan status, previous review or successful check from an earlier snapshot as proof.

Use canonical [command](../../../specifications/project/src/services/command/commands.md), [tool](../../../specifications/project/src/services/ai/tools.md) and [model](../../../specifications/project/prisma/models.md) sections alongside source-mirrored service/job contracts. Trace related help/aliases/callbacks, final provider tool arrays and context conditions, direct/deferred delivery, job retries/restart, configuration consumers and data retention where affected. Read only relevant contracts and callers. Report a violated acceptance criterion or preserved invariant when evidence establishes a defect; do not report the agreed replacement of old behavior as a regression.

For a review associated with a task folder, follow the [task workflow](../../../specifications/tasks/README.md) and write or append `review.md` after the review; identify the reviewed changes, checks and limitations. Do not create a task folder solely for an unrelated review. If writing is prohibited, report in chat instead.

Include review date, comparison basis and relevant working-tree state, acceptance-criterion assessment, confirmed findings, actual checks and verification limits. Append a dated section on re-review; recheck previous findings and record whether they remain, are resolved or cannot be verified. Do not erase earlier findings or imply approval of later edits. Keep stale specification paths/sections and unverified questions separate from code findings so subsequent synchronization has a precise scope; do not change coverage claims as a side effect of review.

Check applicable risks: isolation of private and group data, bot versus conversation administrator permissions, message routing and ordering, duplicate events, external failures, background work, and compatibility of SQLite migrations with existing data. For now, do not request new tests or report missing test coverage as a finding unless the user explicitly asks for a test coverage review.

Run focused, non-destructive checks when useful in a Node.js 22 container; use isolated test data and do not apply migrations to the running bot's database. Report only actionable findings with file and line, triggering conditions, and concrete impact, ordered by severity. If none are found, say so and note checks and limitations. Do not expose secrets or private message content.

Inspired by [Sentry Warden code-review](https://www.skills.sh/getsentry/warden/code-review): follow each plausible failure from a reachable entry point through the changed code, check existing guards and callers, and report it only when the triggering inputs and concrete impact are supported by evidence. Separate uncertainty and unverified risks from confirmed findings; avoid hypothetical defects and duplicate reports.
