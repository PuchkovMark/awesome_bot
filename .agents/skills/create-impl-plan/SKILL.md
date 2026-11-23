---
name: create-impl-plan
description: Turn a human-approved awesome_bot feature plan into ordered implementation steps and tests. Do not use before feature-plan approval or to start coding.
---

# Create an implementation plan

## Read first

All paths are repository-root-relative. Read `AGENTS.md`, the input feature plan in `docs/plans/`, its task, related specifications, `docs/decisions.md`, `docs/roadmap.md`, and `docs/templates/impl-plan.md`. Inspect affected code and build/test configuration to make paths and checks concrete. Report missing code or configuration rather than inventing existing files.

## Procedure

1. Verify the feature plan is human-approved and has status `утверждено`. Otherwise refuse implementation planning and explain the missing approval; never approve it yourself.
2. Check that its task is approved and that open questions do not block implementation. Surface blockers to the user.
3. Create `docs/impl-plans/NNN-short-name.md` in the active directory, preserving the task number and slug. Check both active and `completed/` directories for collisions; never overwrite completed work. Follow the document lifecycle in `docs/project.md` (section «Хранение активных и выполненных задач»). Use the Russian template and common header: number, title, status `черновик`, date, related document links.
4. Write ordered steps, each with a goal, affected modules/files, tests to write and run, and completion conditions including a successful build, passing tests, and expected behavior. Identify proposed new files as new.
5. Every step must leave the project working; do not postpone all integration and validation until the end. Respect roadmap order and mock network calls in tests.
6. Add a separate final step for `review`, resolution and re-review of findings, and `sync-specs` after passing review. Include moving the completed task and both plans to their corresponding `completed/` directories, recording completion dates, and updating and checking internal and incoming links. Name affected documents, final paths, and final acceptance checks.
7. Verify coverage of the task and feature plan. Present the draft and request human approval before implementation, as required by the project workflow.

## Output

One Russian draft implementation plan, its link, blockers if any, and a request for human approval.

## Prohibitions

- Do not proceed from an unapproved feature plan.
- Do not implement, install dependencies, or change code or specifications.
- Do not expand the approved scope or overwrite existing plans.
- Do not self-approve or set `утверждено`.
- Do not modify or delete the old bot or unrelated work.
