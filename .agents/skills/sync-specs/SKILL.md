---
name: sync-specs
description: Synchronize awesome_bot specifications and completion statuses after a feature passes review against its approved plan. Do not use for unreviewed work, unexplained behavior changes, or coding.
---

# Synchronize specifications

## Read first

All paths are repository-root-relative. Read `AGENTS.md`, `docs/project.md`, `docs/roadmap.md`, `docs/decisions.md`, the task and both plans, the completed review report, affected specifications, current code/tests, and the relevant diff.

## Procedure

1. Verify implementation is complete, plans were human-approved, and review passed without unresolved findings. Otherwise stop and state the missing evidence or required corrections.
2. Compare code, the approved feature plan, and specifications. List divergences; distinguish plan-authorized changes from unexplained differences.
3. Present unexplained differences to the human with locations, actual versus specified behavior, and the missing decision. Do not silently rewrite requirements to match code or mark the feature complete while differences remain unresolved.
4. For changes explained by the approved plan, update affected specifications to describe the resulting system state. Keep each requirement in one responsible document and cross-link instead of duplicating. Keep change history out of specifications.
5. Verify task acceptance and implementation-plan completion; check the final `completed/` destinations for conflicts before changing statuses or moving anything. Update the matching roadmap item, task, and both plans to `выполнено` only after implementation, review, and synchronization are complete and the completion move can proceed. Do not complete a whole roadmap stage for a partially completed task. Follow `docs/roadmap.md`; surface unresolved status ambiguities instead of inventing statuses.
6. As the final completion operation, follow `docs/project.md` (section «Хранение активных и выполненных задач»): record completion dates and move the task and both plans together to `docs/tasks/completed/`, `docs/plans/completed/`, and `docs/impl-plans/completed/`. Preserve their number and filename; do not leave duplicate active copies or overwrite existing destinations. If evidence is missing or a destination conflicts, resolve it before marking completion or moving documents.
7. In the same change, update relative links inside moved documents and all incoming repository links, including roadmap and decision-log links. Preserve historical prose. Link all three completed documents from the roadmap item. Check that link targets exist; avoid applying the move twice when documents are already in `completed/`.
8. Add a dated decision and reason to `docs/decisions.md` if a significant decision was made, grounded in the approved plan or human resolution.
9. Report changed documents at their final locations, statuses, and outstanding decisions in Russian.

## Output

Updated Russian specifications and lifecycle documents, plus a concise Russian response linking changes and listing unresolved differences. When blocked, provide discrepancies and required human decisions without claiming completion.

## Prohibitions

- Do not change code, tests, or runtime configuration.
- Do not silently accept unexplained differences or invent requirements.
- Do not overwrite unrelated work, self-approve, or set `утверждено`.
- Do not mark incomplete or unsuccessfully reviewed work `выполнено`.
- Do not modify or delete the old bot.
