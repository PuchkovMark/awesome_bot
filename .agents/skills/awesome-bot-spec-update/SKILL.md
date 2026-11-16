---
name: awesome-bot-spec-update
description: Synchronize existing awesome_bot specifications with actual code changes or an implemented task, including VK commands, model tools, permissions, data and jobs. Use for incremental documentation maintenance; use awesome-bot-spec for comprehensive exploration and initial detailed specifications.
---

# Update awesome_bot specifications

Determine scope from the request, code changes, or completed task. Read project rules, the [specifications index](../../../specifications/README.md), [project index](../../../specifications/project/README.md), [coverage ledger](../../../specifications/project/coverage.md), affected directory indexes and entity documents, implementation, and relevant tests. If a task exists, read its `task.md`, `plan.md`, and `review.md`; their absence does not prevent synchronization. Inspect the working tree, preserve others' changes, and do not attribute every discovered change to the current task. Use the specified comparison scope or explicitly state the comparison basis you selected. Without a useful Git baseline, compare the requested current implementation with its existing specifications; untracked specifications are still the maintained baseline. Do not treat all untracked documentation as new or replace it wholesale.

Write specifications in Russian, preserving exact command, tool, model, and symbol names. General specifications describe implemented behavior in `specifications/project/`; requirements, plans and reviews stay in `specifications/tasks/`. A task document does not replace a project contract. Use the existing complete specification as the baseline for incremental maintenance, not as a reason to repeat full-project exploration.

Trace changed behavior from registration/invocation to result, including callers, availability, state, and errors. Map change → affected contract → documents. Check consequences beyond directly modified files:

- VK commands: syntax, aliases, parameters, examples, routing, precedence, conversation type, permissions, responses, side effects, and related catalog and help text.
- Model tools: public names, argument schemas, results/errors, attachment to the main model or subagents, provider/configuration conditions, permissions, limits, and result delivery.
- Data and features: Prisma models and migrations, isolation by conversation/user, state transitions, external APIs, background jobs, schedules, retention, and deletion.
- Operations: configuration keys and defaults, startup, dependencies, checks, and migration requirements.

## Preserve the specification layout

Update existing sections, related catalogs, examples, diagrams, the code map, and indexes. Reuse established canonical paths and anchors. Follow the “Specification directory layout” section of [awesome-bot-spec](../awesome-bot-spec/SKILL.md) when adding or moving entities:

- Services, infrastructure modules, helpers with substantive contracts, and jobs mirror source paths beneath `specifications/project/`, replacing `.ts` with `.md`. Independently documented services/jobs sharing a module use a module-named directory and individual entity files, with the mapping recorded in its index. Do not create documents for every local function or type.
- All VK commands, subcommands and aliases belong in `specifications/project/src/services/command/commands.md`, with stable canonical command headings and nested subcommands.
- All main-model and subagent tools belong in `specifications/project/src/services/ai/tools.md`, with a section per exact public `AITool.name` and an availability matrix. Factories and helpers do not automatically represent exposed tools; substantive shared helpers may have source-mirrored documents.
- All Prisma models belong in `specifications/project/prisma/models.md`, with a section per exact model name. Update `prisma/migrations.md` when migration history changes.
- Keep directory `README.md` indexes linked to entity files and child directories. Overviews describe shared flows and link to canonical contracts; do not create per-command, per-tool or per-model files or duplicate full contracts in overviews.

For added entities, retain the existing contract depth: identity/source symbol, responsibilities, inputs/outputs, scenarios and errors, permissions, state/side effects, dependencies, configuration, tests and limitations as applicable. For catalog additions, preserve schemas, examples and detailed behavior rather than adding only a summary row. For removals or renames, update incoming links, catalog contents, availability matrices and indexes; remove obsolete current contracts or explicitly identify retained historical descriptions. Search for old identities and paths across specifications and related user documentation. Preserve useful details outside the change scope. Update user documentation when the behavior it describes has changed.

## Evidence and completion

Describe the actual implementation, including material uncommitted changes. Support substantive claims with relative code links and exact symbol names; identify relevant tests and actual limitations. Plans and review comments do not prove implementation. Explicitly mark ambiguous or unverified behavior. Update dates/revisions only for documents actually rechecked, without implying a new exploration of the entire project.

Update affected entries and counts in `specifications/project/coverage.md`, including canonical entity paths or catalog section anchors and explained exclusions. Reconcile changed definitions with registrations and callers in both directions; derive counts from the current scope rather than copying a historical total. Update `specifications/project/test/README.md` when existing tests or their documented contract mapping change. Absence of a runtime test is an implementation/verification limitation, not automatically a documentation gap. Preserve the previous full-project inspection date and scope as historical evidence; distinguish this incremental verification from that snapshot and do not renew a claim of full coverage without rechecking it.

Do not change application code, configuration, database schema, or tests as part of this documentation task. Check relative file links and section anchors in changed documents and incoming links affected by moves/removals. Verify index reachability, unique canonical ownership and consistency between changed entity contracts, catalogs, overviews, coverage and test mappings. Static synchronization does not require starting the bot or triggering external actions; use a Node.js 22 container if existing checks are needed. Report the comparison basis, changed documents and contracts, checks actually performed, and remaining gaps. Use [awesome-bot-spec](../awesome-bot-spec/SKILL.md) for deep exploration. If the active mode prohibits writes, present the necessary changes without writing files.
