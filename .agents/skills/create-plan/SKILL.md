---
name: create-plan
description: Design an awesome_bot feature approach from a human-approved task. Do not use for unapproved tasks, file-by-file implementation steps, or coding.
---

# Create a feature plan

## Read first

All paths are repository-root-relative. Read `AGENTS.md`, the input task in `docs/tasks/`, all related specifications, `docs/decisions.md`, `docs/roadmap.md`, and `docs/templates/plan.md`. Inspect existing code in affected areas. If code is absent, state that instead of assuming its structure.

## Procedure

1. Verify the task was approved by a human and has status `утверждено`. If approval is missing or uncertain, stop and request it; do not plan an unapproved task.
2. Resolve blocking requirement questions with the user. Compare the task with specifications and relevant code.
3. Create `docs/plans/NNN-short-name.md` in the active directory, reusing the task number and slug. Check both active and `completed/` directories for collisions; never overwrite completed work. Follow the document lifecycle in `docs/project.md` (section «Хранение активных и выполненных задач»). Use the Russian template and common header: number, title, status `черновик`, date, related document links.
4. Describe the approach and key decisions, considered alternatives and selection reasons, which specifications would change and how, effects on contracts and data, risks, assumptions, and open questions. State explicitly if specification or data changes are unnecessary.
5. Check architecture and acceptance criteria. Keep specification changes proposed in the plan until synchronization.
6. Present the concrete draft and stop for human approval. Explain that `AGENTS.md` and the project workflow require human approval before implementation planning.

## Output

One Russian draft feature plan, its link, unresolved questions, and a request for human approval.

## Prohibitions

- Do not include code or an ordered file-by-file checklist.
- Do not implement or create an implementation plan in this workflow.
- Do not silently change requirements or specifications, overwrite existing plans, self-approve, or set `утверждено`.
- Do not modify or delete the old bot or unrelated work.
