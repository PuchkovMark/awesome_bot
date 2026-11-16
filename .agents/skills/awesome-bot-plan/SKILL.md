---
name: awesome-bot-plan
description: Create an implementation plan for an already defined awesome_bot task, specifying the work and affected project areas. Use for explicit planning or before implementing a project task, not for standalone review.
---

# Plan a task

Find the relevant `task.md` using the [task workflow](../../../specifications/tasks/README.md), and inspect the [specifications index](../../../specifications/project/README.md), affected code and existing conventions. If the task has not been defined, first use `awesome-bot-task`; do not silently substitute an implementation plan for a task definition.

Write `plan.md` in the same task folder. Describe the sequence of changes, affected files or subsystems, interfaces and data flow where relevant, failure handling, acceptance checks and deployment or migration implications. Keep the plan actionable and proportional to the task; update it when the approach changes. Preserve task documents and unrelated changes. Do not require new or modified tests unless the user explicitly asks; existing checks may be run in an isolated Node.js 22 container.

Use project directory indexes and the [coverage ledger](../../../specifications/project/coverage.md) to locate affected entity contracts and canonical command/tool/model sections. Link these contracts in the plan, identify invariants to preserve and specification updates the implementation will require. Keep proposed behavior in task documents until implemented; specification synchronization remains a separate step when requested.

Record a concise mapping in `plan.md`: acceptance criterion → current contract and source owner → intended change → verification. Use links relative to the task document, including stable section anchors for the single [command](../../../specifications/project/src/services/command/commands.md), [tool](../../../specifications/project/src/services/ai/tools.md) and [model](../../../specifications/project/prisma/models.md) catalogs. For new entities, identify their intended canonical document/section using the existing source-mirrored layout; do not invent per-command, per-tool or per-model files. Read only the affected contracts, not the entire specification tree.

Verify the current behavior in code before choosing the approach. Distinguish intentional contract changes, invariants to preserve, existing implementation limitations and stale documentation. If task requirements and the current baseline differ, explain the intended transition; resolve material ambiguity rather than silently treating either document as the answer.

Trace consequences where relevant: VK routing/help/aliases/callbacks and permission precedence; tool schemas and final provider attachment conditions; direct versus deferred result delivery; data ownership, retention and SQLite migrations; jobs, retries and restart behavior; configuration defaults and consumers. Include dependent callers and cross-cutting documents beyond the directly edited files. Consult the [test map](../../../specifications/project/test/README.md), verify actual assertions and select checks that establish the acceptance criteria. Use [operations](../../../specifications/project/operations.md) for isolated validation; do not plan live VK/provider calls or operational database migrations as routine checks.

If the active mode prohibits file writes, present the plan in chat and write it when allowed. A request for implementation authorizes proceeding with `awesome-bot-implement` after the task and plan are defined, subject to higher-priority restrictions and unresolved decisions. A plan-only request does not authorize implementation.
