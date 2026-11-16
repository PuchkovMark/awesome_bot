---
name: awesome-bot-task
description: Define a new awesome_bot development task and record its agreed scope and acceptance criteria before implementation planning. Use when creating or clarifying a project task, not for standalone review or specification maintenance.
---

# Define a task

Consult the [specifications index](../../../specifications/README.md), [project index](../../../specifications/project/README.md), relevant existing code and the user's request. Use directory indexes and the [coverage ledger](../../../specifications/project/coverage.md) to locate canonical entity documents and command/tool/model catalog sections; read only the relevant contracts and verify them against code. Link those contracts from the task as its current-behavior baseline; keep proposed behavior in the task rather than rewriting the project specification before implementation. Establish the problem, desired behavior, scope, constraints, acceptance criteria and material decisions. Ask about important ambiguities only when they cannot be resolved from the project or conversation; do not invent requirements. Keep implementation steps for the planning stage.

Follow the [task workflow](../../../specifications/tasks/README.md): create a task folder and `task.md`, or reuse the existing folder when continuing an identified task. Preserve earlier task documents and unrelated changes. If the active mode prohibits file writes, present the task in chat and write it when allowed.

## Task content and handoff

Write `task.md` in Russian, preserving exact public names and source symbols. Keep it proportional to the task, but establish the following information for planning:

- Problem and current behavior, supported by relevant canonical specification sections and verified source owners. Distinguish implementation facts, stale documentation, existing limitations and assumptions; a coverage claim or planned feature does not establish runtime behavior.
- Desired observable behavior and its difference from the baseline, with triggering inputs, context and expected results where useful. Identify contracts intentionally changed and invariants to preserve. Do not turn unrelated defects discovered during inspection into requirements.
- Scope, explicit exclusions and relevant constraints. Consider permissions, private/group ownership, compatibility of existing data, external dependencies and configuration only where the requested behavior touches them.
- Stable acceptance-criterion identifiers, such as `AC-1`, with independently checkable outcomes. Include denied/invalid inputs, failures, repeat events or restart behavior when material to the change. Avoid vague criteria such as “works correctly,” invented performance thresholds or mandating tests beyond current user/repository scope.
- Agreed decisions, unresolved material questions and explicitly labeled assumptions. Do not present unanswered questions as approved requirements. Continue independent work where possible; clarify decisions that block the dependent scope.

Link current contracts relative to the actual task document. Commands/subcommands and aliases belong to the single [command catalog](../../../specifications/project/src/services/command/commands.md); main-model/subagent tools to the [tool catalog](../../../specifications/project/src/services/ai/tools.md); Prisma models to the [model catalog](../../../specifications/project/prisma/models.md). Use their stable section anchors and source-mirrored service/job documents rather than creating competing contract descriptions. For new entities, identify the affected area and proposed behavior without claiming that a canonical implemented contract already exists.

Check relevant adjacent surfaces before finalizing scope: VK routing/help/callbacks and actor roles; actual provider tool attachment and execution contexts; direct versus deferred delivery; persisted state, retention and jobs; configuration defaults and consumers. Use the [test map](../../../specifications/project/test/README.md) to locate existing evidence and inspect assertions when relying on them. Describe required outcomes here; leave implementation sequence and detailed verification commands to `awesome-bot-plan`. Do not run the bot, call live VK/providers or access operational data merely to define a task.

Before handing off, ensure each criterion follows from the user's request or an agreed decision and can be mapped by the planner to contract/source → intended change → verification. Report material specification discrepancies as baseline observations, not as silently expanded scope. When continuing an existing task, record consequential requirement changes and identify which parts of an existing plan/review need rechecking; do not rewrite earlier review history or mark implementation complete during task definition.

Creating a task alone does not authorize implementation. If the user requested implementation, continue to `awesome-bot-plan` after defining the task without an unnecessary approval stop; pause for genuinely missing information or higher-priority restrictions.
