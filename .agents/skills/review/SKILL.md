---
name: review
description: Review completed awesome_bot branch changes against the task, plans, specifications, and tests. Do not use to implement fixes, plan features, or synchronize specifications.
---

# Review implementation

## Read first

All paths are repository-root-relative. Read `AGENTS.md`, the related task and both plans, `docs/project.md`, `docs/roadmap.md`, `docs/decisions.md`, and affected specifications. Inspect the current branch diff, relevant unchanged code, tests, and build/lint/test configuration. Establish the comparison base and distinguish pre-existing changes from the feature.

## Procedure

1. Identify the implemented feature and its documents. Documents normally remain active until `sync-specs` completes; for a retrospective review, also check the corresponding `completed/` directories. Follow the document lifecycle in `docs/project.md` (section «Хранение активных и выполненных задач»). Ask for missing references if scope cannot be established; do not guess.
2. Check every task acceptance criterion against code and evidence. Compare with approved plans; flag unexplained scope changes.
3. Check no platform libraries/types in core/tools, chat isolation in all history queries and tool calls, journaling before response decisions and logging of replies, UTC storage and chat timezone handling. Read the specifications for exact contracts.
4. Check tests for new behavior and meaningful failures. Run appropriate available build, lint, and focused tests, mocking VK and LLM calls. Report commands and outcomes. If checks cannot run, state the limitation without claiming success.
5. Look for unrelated changes and code/specification divergence. Report pre-existing differences separately without attributing them to the feature.
6. For each finding give severity (`блокирующее`, `важное`, `мелкое`), precise file/line or document location, and explanation with the violated requirement or consequence. If there are no findings, explicitly say so; distinguish this from unexecuted checks.

## Output

A Russian report in the response: scope and documents, findings with severity/location/explanation, acceptance and verification results, limitations, and explicit passing or unresolved review status for subsequent synchronization. No report file is required.

## Prohibitions

- Do not edit code, tests, specifications, or statuses.
- Do not invent findings or claim checks passed without running them.
- Do not approve plans for the human or widen feature scope.
- Do not modify or delete the old bot or unrelated work.
