---
name: awesome-bot-review
description: Review code changes in the awesome_bot repository for correctness, regressions, access-control mistakes, data-handling issues, and missing tests. Use when asked to review, audit, or inspect a pull request or code changes in this project.
---

# awesome_bot Project Review

Perform a read-only, evidence-based review of the requested changes. Do not edit files, commit changes, or fix findings unless the user separately asks for implementation.

## Review process

1. Read the repository's `.github/copilot-instructions.md` and any more specific instructions that apply to changed files.
2. Establish the review scope from the user's request and the relevant diff. Check the working tree before interpreting changes; do not attribute pre-existing modifications to the current change.
3. Read the changed code and trace affected behavior through its callers, command/event routing, persistence, and related tests. Inspect only enough surrounding code to verify the behavior.
4. Check for concrete correctness and regression risks, including edge cases and failure paths. Do not report style preferences, speculative concerns, or issues unrelated to the change.
5. Run focused, non-destructive tests or checks when useful and available. Prefer the smallest relevant test command. Do not run `npm run lint`, because it uses `--fix`; use `npx eslint 'src/**/*.{ts,js}'` only when lint validation is relevant. Never inspect `.env` files or expose credentials.
6. Report only actionable findings. If there are no findings, say so and briefly note what was inspected or tested. Separate confirmed findings from test limitations or unrelated pre-existing failures.

## Repository invariants to verify

- This is a strict TypeScript ESM project using `NodeNext`; relative TypeScript imports use `.js` extensions.
- Keep text generation behind the `AIProvider` contract and provider factory. Do not leak provider-specific API details into unrelated services.
- Check permissions at the command or event boundary. Bot administrators and VK conversation administrators are distinct roles; do not treat them as interchangeable.
- Preserve conversation-mode behavior (`active`, `normal`, and `quiet`) and ensure command routing does not accidentally consume a message intended for another handler.
- Keep personal message context separate from shared group context. Ordinary context expires within 24 hours; group messages may be retained up to 7 days only when that conversation's weekly-meme setting is enabled.
- Preserve per-user request ordering and rate limits implemented by `src/services/queue/requestQueue.ts`.
- Persist schema changes through `prisma/schema.prisma` and migrations. Preserve SQLite-compatible serialization conventions for structured settings.
- Avoid logging API keys, access tokens, private message content, or other sensitive values.
- User-facing bot messages and documentation are primarily in Russian.

## Finding format

For each finding, include:

- Severity: Critical, High, Medium, or Low.
- Exact file and line(s) in the changed code.
- The triggering condition and concrete user or system impact.
- Why the behavior is incorrect, with evidence from the relevant call path or invariant.
- Confidence from 1 to 10.

Order findings by severity, then confidence. Keep each finding focused on one issue. Do not present a possible fix as a finding unless the underlying bug is established.
