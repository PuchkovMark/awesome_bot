---
name: systematic-debugging
description: Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes
---

# Systematic Debugging

## Project-specific instructions

Read the [project index](../../../specifications/project/README.md), [coverage ledger](../../../specifications/project/coverage.md) and affected directory indexes to locate canonical entity contracts. Verify documented behavior against current code, including material uncommitted changes. The specification describes the baseline; task requirements may intentionally change it. Plans and review comments do not prove implementation, and a coverage-ledger claim does not prove runtime correctness.

Use the single catalogs for [commands](../../../specifications/project/src/services/command/commands.md), [model tools](../../../specifications/project/src/services/ai/tools.md) and [Prisma models](../../../specifications/project/prisma/models.md). Read only relevant sections and follow their links to owners and jobs. Consult the [test map](../../../specifications/project/test/README.md), then inspect actual assertions; distinguish static evidence from checks executed now.

A diagnosis-only request does not authorize code changes, instrumentation or implementation. When fixes are requested, follow task definition → planning → implementation through the [task workflow](../../../specifications/tasks/README.md), reusing existing documents. Use applicable task/plan/implement skills without an unnecessary approval stop. Follow repository testing rules and current user instructions; use existing checks or safe manual reproduction when new tests are outside scope. Specification synchronization remains a separate step through `awesome-bot-spec-update` when requested.

Run Node.js-dependent checks in a suitable Node.js 22 container, following [operations](../../../specifications/project/operations.md). Use isolated data and mocked/local external services where possible. Do not start the live bot, send VK messages, invoke paid providers or run migrations against operational data merely to reproduce a bug. Do not read live secrets or private message content to fill an evidence gap. Preserve unrelated working-tree changes.

### Project-specific tracing

Choose the path relevant to the symptom; do not inspect every subsystem for each bug:

- VK: event → mentions/prefixes and branch precedence → queue/rate limits → command, questionnaire, game or AI handler → sender/splitter/voice. Check early returns, duplicate events and ordering against [architecture](../../../specifications/project/src/architecture.md) and the owning contracts.
- Tools/AI: exact public name and schema → final provider tool array and availability conditions → execution/validation → state changes → returned result versus direct VK delivery. Check duplicate-reply suppression and distinguish main-model, questionnaire, active-decision, digest and subagent contexts.
- Data/permissions: trace actor, conversation and user identifiers from entry to every read/write; preserve private/group isolation and distinguish bot administrators from conversation administrators. For SQL, migrations or slow queries, also use `sql-database-assistant`; never experiment on the running bot's SQLite database.
- Jobs/subagents: registration → schedule/time zone → selection → state transition/locks → retry/restart → delivery. Compare persisted states with actual callers; inspect idempotency and failures between external delivery and DB updates. See [jobs](../../../specifications/project/src/jobs/README.md).
- Startup/build/configuration: bootstrap → DI → effective configuration and feature conditions → provider/dependency initialization. Check defaults and precedence through [configuration](../../../specifications/project/src/config/index.md), without reading credential values.

Use the shared structured logger for authorized instrumentation. Prefer operation names, timings, counts, error codes and redacted state metadata. Never dump environment variables, complete prompts, message bodies, provider payloads, tokens or raw database records. Supporting examples involving stderr or full inputs do not override this rule. Remove temporary instrumentation when it is no longer needed.

## Overview

**Core principle:** ALWAYS find root cause before attempting fixes. Symptom fixes are failure.

Scale investigation to the issue: a direct source trace may establish a simple cause; a race or external failure may require controlled reproduction. Distinguish confirmed causes, hypotheses and unknowns.

## The Iron Law

```
NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST
```

If you haven't completed Phase 1, you cannot propose fixes.

## When to Use

Use for ANY technical issue:
- Test failures
- Bugs in production
- Unexpected behavior
- Performance problems
- Build failures
- Integration issues

**Use this ESPECIALLY when:**
- Under time pressure (emergencies make guessing tempting)
- "Just one quick fix" seems obvious
- You've already tried multiple fixes
- Previous fix didn't work
- You don't fully understand the issue

**Don't skip when:**
- Issue seems simple (simple bugs have root causes too)
- You're in a hurry (rushing guarantees rework)
- Manager wants it fixed NOW (systematic is faster than thrashing)

## The Four Phases

You MUST complete each phase before proceeding to the next.

### Phase 1: Root Cause Investigation

**BEFORE attempting ANY fix:**

1. **Read Error Messages Carefully**
   - Don't skip past errors or warnings
   - They often contain the exact solution
   - Read stack traces completely
   - Note line numbers, file paths, error codes

2. **Reproduce Consistently**
   - Can you trigger it reliably?
   - What are the exact steps?
   - Does it happen every time?
   - If not reproducible → gather more data, don't guess

3. **Check Recent Changes**
   - What changed that could cause this?
   - Git diff, recent commits
   - New dependencies, config changes
   - Environmental differences

4. **Gather Evidence in Multi-Component Systems**

   **WHEN system has multiple components (CI → build → signing, API → service → database):**

   **Use existing evidence first; add scoped, redacted instrumentation only when needed and authorized:**
   ```
   For EACH component boundary:
     - Record safe metadata at component entry and exit
     - Avoid logging private inputs or complete outputs
     - Verify environment/config propagation
     - Check state at each layer

   Run once to gather evidence showing WHERE it breaks
   THEN analyze evidence to identify failing component
   THEN investigate that specific component
   ```

   **Generic example (not an awesome_bot procedure; do not dump project environment or invoke external signing tools):**
   ```bash
   # Layer 1: Workflow
   echo "=== Secrets available in workflow: ==="
   echo "IDENTITY: $([ -n "${IDENTITY:-}" ] && echo SET || echo UNSET)"

   # Layer 2: Build script
   echo "=== Env vars in build script: ==="
   printenv IDENTITY >/dev/null 2>&1 && echo "IDENTITY in environment" || echo "IDENTITY not in environment"

   # Layer 3: Signing script
   echo "=== Keychain state: ==="
   security list-keychains
   security find-identity -v

   # Layer 4: Actual signing
   codesign --sign "$IDENTITY" --verbose=4 "$APP"
   ```

   **This reveals:** Which layer fails (secrets → workflow ✓, workflow → build ✗)

5. **Trace Data Flow**

   **WHEN error is deep in call stack:**

   See `root-cause-tracing.md` in this directory for the complete backward tracing technique.

   **Quick version:**
   - Where does bad value originate?
   - What called this with bad value?
   - Keep tracing up until you find the source
   - Fix at source, not at symptom

### Phase 2: Pattern Analysis

**Find the pattern before fixing:**

1. **Find Working Examples**
   - Locate similar working code in same codebase
   - What works that's similar to what's broken?

2. **Compare Against References**
   - If implementing pattern, read reference implementation COMPLETELY
   - Don't skim - read every line
   - Understand the pattern fully before applying

3. **Identify Differences**
   - What's different between working and broken?
   - List every difference, however small
   - Don't assume "that can't matter"

4. **Understand Dependencies**
   - What other components does this need?
   - What settings, config, environment?
   - What assumptions does it make?

### Phase 3: Hypothesis and Testing

**Scientific method:**

1. **Form Single Hypothesis**
   - State clearly: "I think X is the root cause because Y"
   - Write it down
   - Be specific, not vague

2. **Test Minimally**
   - Make the SMALLEST possible change to test hypothesis
   - One variable at a time
   - Don't fix multiple things at once

3. **Verify Before Continuing**
   - Did it work? Yes → Phase 4
   - Didn't work? Form NEW hypothesis
   - DON'T add more fixes on top

4. **When You Don't Know**
   - Say "I don't understand X"
   - Don't pretend to know
   - Ask for help
   - Research more

### Phase 4: Implementation

**Fix the root cause, not the symptom:**

1. **Establish a Reproduction or Concrete Failing Path**
   - Prefer a focused existing test or isolated deterministic reproduction.
   - Follow current repository rules and user instructions for regression tests.
   - If reproduction is unavailable, record the source evidence and verification limit; do not claim the failure was reproduced.

2. **Implement Single Fix**
   - Address the root cause identified
   - ONE change at a time
   - No "while I'm here" improvements
   - No bundled refactoring

3. **Verify Fix**
   - Test passes now?
   - No other tests broken?
   - Issue actually resolved?
   - Run appropriate existing checks in a Node.js 22 container with isolated data.
   - Report commands actually run and their results; do not equate static inspection with a passing runtime scenario.

4. **If Fix Doesn't Work**
   - STOP
   - Count: How many fixes have you tried?
   - If < 3: Return to Phase 1, re-analyze with new information
   - If repeated attempts fail, reassess assumptions and architecture using the accumulated evidence (step 5 below).
   - Do not stack speculative patches or expand into an unrelated redesign.

5. **If 3+ Fixes Failed: Question Architecture**

   **Pattern indicating architectural problem:**
   - Each fix reveals new shared state/coupling/problem in different place
   - Fixes require "massive refactoring" to implement
   - Each fix creates new symptoms elsewhere

   **STOP and question fundamentals:**
   - Is this pattern fundamentally sound?
   - Are we "sticking with it through sheer inertia"?
   - Should we refactor architecture vs. continue fixing symptoms?

   Discuss with the user when evidence requires a consequential change outside the agreed scope or a missing decision blocks progress; continue independent investigation within scope.

   Repeated failures justify reassessment; their count alone does not prove an architectural defect.

## Red Flags - STOP and Follow Process

If you catch yourself thinking:
- "Quick fix for now, investigate later"
- "Just try changing X and see if it works"
- "Add multiple changes, run tests"
- "Skip all evidence and claim success"
- "It's probably X, let me fix that"
- "I don't fully understand but this might work"
- "Pattern says X but I'll adapt it differently"
- "Here are the main problems: [lists fixes without investigation]"
- Proposing solutions before tracing data flow
- **"One more fix attempt" (when already tried 2+)**
- **Each fix reveals new problem in different place**

**ALL of these mean: STOP. Return to Phase 1.**

**If repeated fixes failed:** Reassess evidence and assumptions (see Phase 4.5).

## your human partner's Signals You're Doing It Wrong

**Watch for these redirections:**
- "Is that not happening?" - You assumed without verifying
- "Will it show us...?" - You should have added evidence gathering
- "Stop guessing" - You're proposing fixes without understanding
- "Ultra-think this" - Question fundamentals, not just symptoms
- "We're stuck?" (frustrated) - Your approach isn't working

**When you see these:** STOP. Return to Phase 1.

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "Issue is simple, don't need process" | Simple issues have root causes too. Process is fast for simple bugs. |
| "Emergency, no time for process" | Systematic debugging is FASTER than guess-and-check thrashing. |
| "Just try this first, then investigate" | First fix sets the pattern. Do it right from the start. |
| "I'll verify later" | Establish concrete failure evidence and an appropriate verification path before claiming resolution; follow repository test rules. |
| "Multiple fixes at once saves time" | Can't isolate what worked. Causes new bugs. |
| "Reference too long, I'll adapt the pattern" | Partial understanding guarantees bugs. Read it completely. |
| "I see the problem, let me fix it" | Seeing symptoms ≠ understanding root cause. |
| "One more speculative fix" | Reassess evidence and assumptions before another change; failure count alone does not prove an architectural defect. |

## Quick Reference

| Phase | Key Activities | Success Criteria |
|-------|---------------|------------------|
| **1. Root Cause** | Read errors, reproduce, check changes, gather evidence | Understand WHAT and WHY |
| **2. Pattern** | Find working examples, compare | Identify differences |
| **3. Hypothesis** | Form theory, test minimally | Confirmed or new hypothesis |
| **4. Implementation** | Reproduce/trace, authorized fix, appropriate checks | Evidence supports resolution; verification limits stated |

## When Process Reveals "No Root Cause"

If systematic investigation reveals issue is truly environmental, timing-dependent, or external:

1. You've completed the process
2. Document what you investigated
3. If fixes are authorized, choose handling supported by evidence (retry, timeout, error message); verify idempotency before retrying side effects.
4. Add scoped redacted monitoring only when useful and authorized; otherwise report what evidence is missing.

If evidence remains insufficient, report the affected path, observations, ruled-out hypotheses, missing evidence and next safe check. Do not invent a cause or claim resolution.

## Supporting Techniques

These techniques are part of systematic debugging and available in this directory:

- [Root-cause tracing](root-cause-tracing.md) — read when the symptom appears far from its source.
- [Defense in depth](defense-in-depth.md) — read when multiple reachable boundaries need distinct validation; avoid duplicating guards without a concrete reason.
- [Condition-based waiting](condition-based-waiting.md) — read for asynchronous races; use bounded deadlines, cancellation and meaningful errors. Preserve timeouts required by the actual contract.

The helper script and TypeScript example in this directory are optional generic examples. Inspect them before use; do not run them automatically or assume their Jest-style examples match this project's node:test setup. Keep reproduction artifacts isolated and do not modify operational data.

Report the symptom, confirmed cause or unresolved hypothesis, affected source/specification paths, authorized changes, checks actually performed and remaining limits. Use Russian for user-facing reports.
