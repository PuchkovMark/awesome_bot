---
name: create-task
description: Create an awesome_bot task from a user idea or roadmap item. Do not use for solution design, implementation planning, coding, or trivial corrections.
---

# Create a task

## Read first

All paths are repository-root-relative. Read `AGENTS.md`, `docs/project.md`, `docs/roadmap.md`, affected `docs/specs/` files, and `docs/templates/task.md`. Inspect names recursively in `docs/tasks/`, `docs/plans/`, and `docs/impl-plans/`, including their `completed/` directories, to avoid number collisions. Follow the document lifecycle in `docs/project.md` (section «Хранение активных и выполненных задач»).

## Procedure

1. Identify the input idea or roadmap item and its scope. Separate stated requirements from unanswered questions.
2. Ask the user about unclear requirements rather than guessing. Record unresolved questions; do not claim readiness while blocking questions remain.
3. Allocate the next free number above the highest active or completed task or plan number, starting at 001. Never reuse completed numbers. Create the draft in the active directory using at least three digits: `docs/tasks/NNN-short-name.md`.
4. Fill the Russian task template: problem or goal, expected behavior, verifiable acceptance criteria, explicit exclusions, affected specifications, open questions. Fill the common header: number, title, status `черновик`, date, related document links.
5. Link only existing documents, verify links, and present the task for human review and approval. Related plans will reuse its number and slug.

## Output

One Russian draft task using the template, plus a concise Russian reply linking it and listing open questions.

## Prohibitions

- Do not propose solutions or implementation steps, write code, or change specifications.
- Do not invent requirements or overwrite existing tasks.
- Do not self-approve or set `утверждено`; only a human approves.
- Do not modify or delete the old bot or unrelated work.
