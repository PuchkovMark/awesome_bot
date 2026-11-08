# awesome_bot — Optimization & Functional Audit Report

Date: 2026-11-07
Scope: entire project (`src/` ~10,600 lines, 38 TypeScript files; `prisma/schema.prisma` + 10 migrations; 7 test files, 45 tests; `package.json`; README).
Method: read-only audit per `awesome-bot-audit` skill. No project files were modified. Evidence-based: every finding was traced in source or produced by a validation command.

---

## 1. Executive Summary

`awesome_bot` is a well-structured, feature-rich VK AI chatbot with a clean layered architecture (bootstrap → VkService pipeline → domain services → Prisma/SQLite), disciplined environment validation, a provider-agnostic text-generation contract (`AIProvider`), per-user sequential request queues, and user-facing copy consistently in Russian. Strict TypeScript ESM/NodeNext conventions are followed throughout (all relative imports use `.js`).

The most important findings are in **VK message delivery reliability** (millisecond-based `random_id` can silently drop message parts; no incoming-event deduplication), **dependency security** (13 known vulnerabilities, incl. high-severity `axios` and `follow-redirects`), **broken lint tooling** (`eslint-plugin-prettier@4` is incompatible with installed `prettier@3`), and **zero AI cost visibility** (the `ApiUsage` model exists but is never written).

Main risks: silent message loss under load, duplicate side effects after Long Poll redelivery, unbounded in-memory state growth (queues, rate-limit maps), and media endpoints that buffer up to 24 MB per request with no per-user voice quotas.

Best improvement opportunities: fix `random_id` generation, add incoming-event dedup, repair lint, run `npm audit fix`, cache the per-request rebuilt system/capabilities prompts, and start recording `ApiUsage`.

---

## 2. Current Project Assessment

- **Architecture.** Good separation: `vkService` (event pipeline), domain services per subsystem (fun, games, memory, settings, image, voice, search, queue), shared Prisma client, cron jobs isolated in `src/jobs/`. Class + module-level singleton pattern is applied consistently. No circular dependency issues observed. `vkService.ts` is very large (2,300+ lines) and concentrates most routing logic — the main maintainability hotspot.
- **Code quality.** Strict TypeScript compiles cleanly (`npx tsc --noEmit` PASSED). Consistent naming and error logging. Lint is currently un-runnable (see Critical Findings).
- **Reliability.** Per-user `PQueue(concurrency: 1)` preserves per-user ordering; cron jobs use `running` flags against overlap. Weaknesses: no incoming-event dedup, unsafe `random_id`, some failure paths send no user feedback.
- **Performance.** Sequential awaits in the hot message path (5+ DB/VK lookups before dispatch); per-minute jobs iterate all enabled chats serially; media paths hold multiple large buffers simultaneously.
- **AI integration.** Text generation uniformly behind `getAIProvider()`; direct `openai` imports only in media services, which the text contract intentionally does not cover. No task-specific model routing and no usage accounting.
- **User experience.** Rich command surface documented in README; help systems exist per subsystem. Quiet-mode semantics diverge from documentation (see Critical Findings).
- **Maintainability.** Config centralization and validation are strong (`src/config/index.ts`). Dead dev dependencies (`ts-node`, `ts-node-dev`) and a tracked binary dev database add noise.

---

## 3. Critical Findings

No P0 (data loss / exploitable security) defects were confirmed. The following P1 items are the most significant:

| # | Finding | Type | Location | Confidence |
|---|---------|------|----------|------------|
| C1 | `random_id: Date.now() % 1e9` on every send — two sends within the same millisecond (common for splitter parts) collide; VK dedup silently suppresses the later part → **lost message content** | Confirmed defect | `src/services/sender/senderService.ts:112,449,524,604`; duplicated in `src/services/vk/vkService.ts:2346-2350` | 9/10 |
| C2 | No dedup of incoming `message_new` events — Long Poll redelivery/reconnect can re-execute commands, AI calls, questionnaire saves → duplicate replies and duplicate side effects | Confirmed defect | `src/services/vk/vkService.ts:1189-1197` | 8/10 |
| C3 | Quiet mode is bypassed: questionnaire answers (lines 1340-1361) and free-form adventure moves (1384-1408) are handled before the quiet gate, and the gate itself exempts `/profile` and all `/adventure` commands for non-admins — contradicts documented "quiet answers only admin commands" (README:117) | Confirmed defect (or doc mismatch) | `src/services/vk/vkService.ts:1340-1423` | 10/10 |
| C4 | `npm audit`: **13 vulnerabilities (10 high, 3 moderate)** — incl. `axios` 1.18.1 (<1.19.0, high), `follow-redirects` (high), `uuid` via `node-cron@3` (high), `brace-expansion` (high, dev chain), `fast-copy` (moderate) | Confirmed security issue | `package.json` | 10/10 |
| C5 | ESLint cannot run: `eslint-plugin-prettier@4.2.5` calls `prettier.resolveConfig.sync`, removed in installed `prettier@3.9.x` → every lint run crashes (`TypeError` on the first file) | Confirmed defect (tooling) | `package.json:37,39` | 10/10 |
| C6 | ~~`ApiUsage` never written~~ **Corrected after re-verification:** `ApiUsage` IS recorded for conversation, voice, image, game, fun, meme, and search paths (`vkService.recordUsage`, `commandService.ts:1048`, `gameService.ts:228`, `funService.ts:220`, `memeService.ts:237`) and aggregated in `/stats`. The actual gap was the adventure module (turns, retries, hints) — fixed on 2026-11-07 | Corrected | `prisma/schema.prisma:316-332` | 10/10 |

---

## 4. Technical Optimizations

### T1. Monotonic/unique `random_id` — **P1 · S**
- Current: `Date.now() % 1e9` (see C1).
- Recommendation: use a monotonically increasing 32-bit counter (e.g. `(Date.now() << 8 | counter++ & 0xff) % 2**31` or `crypto.randomInt(0, 2**31-1)`), in one shared helper; remove the duplicated logic in `vkService.sendMessage`.
- Expected: eliminates silent loss of split parts and attachments. Risk: none.

### T2. Incoming event deduplication — **P1 · M**
- Current: pipeline processes every delivered `message_new` unconditionally (C2).
- Recommendation: keep a bounded LRU/set of processed message ids (`context.id` per peer) with short TTL; skip already-seen ids.
- Expected: idempotent processing across Long Poll redelivery. Risk: low; must scope by peer.

### T3. Repair lint toolchain — **P1 · S**
- Current: C5.
- Recommendation: upgrade `eslint-plugin-prettier` to ^5 (supports Prettier 3) or pin Prettier 2; keep `npm run lint --fix` semantics but document the no-fix variant.
- Expected: lint/CI usable again. Risk: formatting churn on first run.

### T4. Fix known vulnerabilities — **P1 · S**
- Current: C4. `npm audit fix` resolves axios/follow-redirects/brace-expansion/fast-copy without breaking changes; `uuid` requires `node-cron@4` (breaking) or accepts the transitive risk.
- Expected: removes high-severity advisories. Risk: low for non-breaking fixes; test cron expressions after any `node-cron` major bump.

### T5. Bound in-memory queue/rate-limit state — **P2 · S**
- Current: `requestQueue.ts:7-20` never evicts idle per-user `PQueue` instances; `rateLimitService.ts:14-47` bounds `requests` to 10k users but `lastNotified` is only cleaned for evicted users. (Confirmed defects, 9/10 and 7/10.)
- Recommendation: delete a user's queue when it drains (p-queue `onIdle`), and evict `lastNotified` alongside `requests`.
- Expected: stable memory on long-running processes.

### T6. Reduce sequential lookups in the message hot path — **P2 · M**
- Current: per incoming message the pipeline performs, before dispatch, a VK display-name lookup, admin DB lookup, chat-settings DB lookup, questionnaire lookup, and active-adventure lookup (`vkService.ts:1237-1345`), then re-loads the maintenance setting inside the queued task (1519-1529). Personality button handling serializes six independent checks (`vkService.ts:182-205`). (Confirmed performance cost, 9/10.)
- Recommendation: parallelize independent reads (`Promise.all`), cache chat settings/admin flags with short TTL, single-load maintenance per process tick.
- Expected: noticeably lower latency for every message. Risk: cache invalidation semantics must be explicit.

### T7. Add missing composite index for chat-context reads — **P3 · S**
- Current: `getRecentConversationUsers`/`getRecentChatContext` filter by `(conversationId, role, createdAt)`; schema only has `(conversationId, createdAt)` and `(userId, conversationId, createdAt)` (`prisma/schema.prisma:35-36`, `memoryService.ts:141-166,231-249`). Also `distinct` user query has no `take`. (Potential bottleneck, 7-8/10.)
- Recommendation: add `@@index([conversationId, role, createdAt])` via migration; cap the `distinct` query.
- Expected: cheaper context reads as message volume grows. Risk: none (SQLite index).

### T8. Trim over-fetching in proposal history — **P3 · S**
- Current: up to 200 messages loaded then regex-filtered down to 10 in JS (`memoryService.ts:206-228`). (Confirmed avoidable cost, 9/10.)
- Recommendation: filter in SQL (Prisma `contains` per pattern or raw query) or fetch in smaller batches with early exit.

### T9. Make per-minute jobs scale with chat count — **P2 · M**
- Current: `memeDayJob.ts:52-95` and `adventureVoteJob.ts:10-28` run every minute, processing all enabled chats / expired votes serially; the `running` flag skips whole cycles when the previous tick overruns, delaying all later items. (Confirmed scalability bottleneck, 8-9/10.)
- Recommendation: process due items with small bounded concurrency and per-item error isolation; consider per-chat next-due scheduling instead of full scans.

### T10. Remove dead dev dependencies and the tracked dev database — **P3 · S**
- Current: `ts-node` and `ts-node-dev` are unused by any script (runtime uses `tsx`); `prisma/dev.db` (binary, contains real message history) is tracked and grows each commit (700→725 KB in the current tree).
- Recommendation: drop unused deps; gitignore `dev.db` and provide a seed script instead.
- Expected: smaller install, no private data in git history going forward. Risk: removing tracked DB needs a one-time history decision.

---

## 5. Performance Improvements

| ID | Item | Evidence | Type | Priority / Effort |
|----|------|----------|------|-------------------|
| P-1 | `random_id` collisions drop splitter parts | `senderService.ts:112` | Confirmed defect | P1 / S |
| P-2 | Sequential DB/VK lookups before dispatch | `vkService.ts:1237-1345` | Confirmed performance cost | P2 / M |
| P-3 | Media memory pressure: image edit holds original + resized + upload wrapper + response buffers (source ≤20 MB) | `imageGenerationService.ts:45-55` | Confirmed | P2 / S |
| P-4 | Document analysis keeps 8 MB buffer + base64 string (+33%) live simultaneously | `documentAnalysisService.ts:73-105` | Confirmed (10/10) | P2 / S |
| P-5 | Voice downloads ≤24 MB into memory per request; no concurrency cap | `voiceService.ts:63-77` | Confirmed | P2 / S |
| P-6 | Per-minute cron scans all chats serially | `memeDayJob.ts:52-95` | Confirmed bottleneck | P2 / M |
| P-7 | Context reads: up to 30 messages serialized per AI call; 200-row over-fetch; unbounded `distinct` | `memoryService.ts:107-249` | Potential bottleneck | P3 / S |
| P-8 | Missing `(conversationId, role, createdAt)` index | `schema.prisma:35-36` | Potential bottleneck | P3 / S |

Notes: for P-3/P-4/P-5, streaming to disk/temp files or re-encoding sequentially (release buffers between steps) plus a small global media-processing semaphore would cap worst-case memory; no invented throughput numbers are claimed — these are structural observations.

---

## 6. AI and Cost Optimization

| ID | Item | Evidence | Type | Priority / Effort |
|----|------|----------|------|-------------------|
| A-1 | **Adventure AI calls were not usage-tracked** (turns, JSON retries, hints); all other major paths already record `ApiUsage` | `adventureService.ts` | Confirmed gap — **fixed 2026-11-07** | P1 / S |
| A-2 | Full system prompt = capabilities + personality + user/chat instructions rebuilt for **every** request; capabilities block (`capabilityService.ts:14-67`) is large and static per config | `vkService.ts:2098-2178`; `characterService.ts:425-432` | Confirmed (9/10) | P2 / M |
| A-3 | Extra intent-classification AI call (maxTokens 120) before every search-eligible message | `searchIntentService.ts:7-32`; `vkService.ts:2195-2260` | Confirmed (9/10) | P2 / S |
| A-4 | JSON-retry duplicates full generation at higher maxTokens (adventure 1800→2200; meme plan 700) | `adventureService.ts:206-239`; `memeService.ts:394-414` | Confirmed (9/10) | P2 / S |
| A-5 | No task-based model routing — intent, hints, summaries, fun all use the main configured model | `searchIntentService.ts:17-20`; `commandService.ts:1518-1536`; `funService.ts:211` | Confirmed (8/10) | P2 / M |
| A-6 | Images always `quality: 'high'` 1024×1024; no preview/economy mode; identical prompts not cached | `imageGenerationService.ts:22-69` | Confirmed (9/10) | P2 / S |
| A-7 | Global SDK retries (`AI_MAX_RETRIES=2`) multiply billable requests on expensive paths | `openaiProvider.ts:13-29`; `opencodeProvider.ts:17-34` | Confirmed (8/10) | P3 / S |
| A-8 | Voice transcription/TTS lack per-user quotas (images have 20/day and admin gate; voice only on/off) | `config/index.ts:98-107`; `voiceService.ts:72-108` | Confirmed gap (8/10) | P2 / S |

Recommendations with the best cost/benefit ratio: A-1 (instrument first — without data, other savings are unverifiable), A-2 (cache static prompt fragments keyed by settings version; inject the long capabilities text only for help/capability questions), A-3 (run deterministic triggers/URL/date heuristics before the classifier), A-6 (default quality + prompt-hash cache).

---

## 7. Functional Improvements

- **F1 (P1):** Align quiet mode with its documentation (or vice versa): decide whether questionnaire answers, adventure moves, `/profile`, `/adventure` are intentional quiet-mode exceptions; if yes, document them in README:117 and the `/help` text; if no, move the quiet gate above those blocks. Evidence: `vkService.ts:1340-1423`. Effort S.
- **F2 (P2):** Send a fallback error message when the queued message handler throws outside narrowly handled branches — currently the user gets silence (`vkService.ts:2318-2328`, confirmed 8/10). Effort S.
- **F3 (P3):** Include `replyOptions` in the voice-failure reply so chat threads stay linked (`vkService.ts:1261-1277`, confirmed 7/10). Effort S.
- **F4 (P2):** Fix the two pre-existing failing tests in `test/core.test.ts:158-159` (assertions `/модуль включён в конфигурации/` and `/OPENAI_API_KEY/` no longer match the capabilities prompt) — stale assertions erode trust in the suite. Confirmed failing on clean HEAD. Effort S.
- **F5 (P3):** `prisma migrate diff` shows only cosmetic auto-index renames — no schema drift; keep the habit of checking this in CI. No action needed.

---

## 8. New Feature Ideas

1. **Conversation recap on demand for newcomers** — `/catchup` summarizes what a user missed since their last message in a group (data already retained 24 h; reuse `getRecentChatContext` + summary pipeline). Value: high engagement in active groups. Complexity M. Cost: one summary call per invocation; cache per user+window. Risk: low.
2. **Per-chat AI budget meter** — once `ApiUsage` is recorded (A-1), `/stats cost` shows per-feature spend; admins set soft daily caps. Value: makes cost controls real. Complexity M. Cost: negligible. Risk: none.
3. **Adventure "recap card" image** — on `/adventure end`, generate one illustration from the journal highlights (image pipeline already exists). Value: shareable artifact, boosts virality. Complexity S-M. Cost: one image per finished adventure. Risk: content quality variance.
4. **Smart quiet-mode digest** — while a chat is in `quiet`, collect messages and let an admin ask `/summary` for what was missed (summary feature exists; this just markets the quiet+digest combo and resolves C3's UX tension). Complexity S. Cost: on demand only.
5. **Meme tournament bracket** — weekly meme winners (`MemeDayVote` data exists) enter a monthly bracket vote. Value: retention loop on top of existing meme infra. Complexity M. Cost: none (no AI needed for voting). Risk: low.

---

## 9. Security and Reliability

- **C4 (P1):** 13 known vulnerabilities; fix via `npm audit fix` (+ evaluate `node-cron@4` for `uuid`).
- **C3 (P1):** quiet-mode permission boundary diverges from documentation — either code or docs must change.
- **Input handling:** no evidence of sensitive data in logs (only `textLength`, ids); API keys never logged. Prompt-injection surface exists by design (group text enters shared context used in prompts) — acceptable for the product, but keep admin-only commands free of AI-synthesized arguments.
- **Rate limiting:** per-user minute limits exist and are preserved through the queue; missing voice quotas (A-8) are the main abuse gap.
- **Error recovery:** outer handler catch logs but does not notify the user (F2); VK API send failures are caught per part.
- **DB consistency:** schema matches migrations; cascade deletes present on relations inspected; `GameSession` mutations guarded by per-conversation locks.

---

## 10. Testing Recommendations

Current: 45 tests across 7 files (passing 44/46 incl. unrelated suites; 2 pre-existing failures). Missing coverage, in priority order:

1. **senderService `random_id` uniqueness** + splitter integration (would have caught C1). **P1.**
2. **Quiet-mode routing matrix** — admin/non-admin × quiet/normal/active × command/free-form/questionnaire/adventure (locks C3 semantics). **P1.**
3. **Incoming-event dedup behavior** once T2 lands. **P1.**
4. **memoryService cleanup** — with/without `ChatSettings` rows; weekly-meme on/off transitions (current Low finding #3 from review: `cleanupOldContext` misses settings-less conversations, `memoryService.ts:278-289`, confidence 6/10). **P2.**
5. **requestQueue eviction** once T5 lands. **P2.**
6. **memeDayJob/adventureVoteJob** overlap and batch-delay behavior. **P3.**

---

## 11. Prioritized Implementation Roadmap

**Quick Wins (S, immediate value):**
1. T1 — unique `random_id` (fixes silent message loss).
2. T3 — repair ESLint (plugin ^5).
3. T4 — `npm audit fix` for non-breaking advisories.
4. F2 + F3 — user-visible error feedback fixes.
5. F4 — fix stale test assertions.
6. T10 — remove `ts-node`/`ts-node-dev`, gitignore `dev.db`.

**High Priority:**
7. T2 — incoming-event dedup.
8. F1 — resolve quiet-mode semantics (code or docs).
9. A-1 — write `ApiUsage` on every provider/media call.
10. T5 — evict idle queues; clean rate-limit maps.

**Medium Priority:**
11. T6 — parallelize/cache hot-path lookups.
12. A-2 — cache static prompt fragments; conditional capabilities prompt.
13. A-3 — deterministic search triggers before the classifier.
14. A-8 — voice quotas; A-6 — image economy mode + prompt cache.
15. T9 — bounded-concurrency cron processing.

**Long-Term:**
16. A-5 — task-based model routing (needs A-1 data first).
17. P-3/P-4/P-5 — streaming/bounded media buffers.
18. Split `vkService.ts` pipeline stages into composable middleware modules.
19. New features from section 8 (start with #1 and #2).

---

## 12. Recommendations to Avoid

- **Do not** replace the stack (Prisma→other ORM, pino→other logger, vk-io→raw API): no demonstrated problem justifies it.
- **Do not** rewrite the service layer into a generic plugin/DI framework: `src/di/container.ts` plus singletons already cover current needs; a framework would add indirection without consumers.
- **Do not** add a vector store / semantic memory: at 24 h retention and ≤30-message windows it would raise cost and complexity with negligible benefit.
- **Do not** merge personal and group context "for better answers": the separation is an intentional privacy invariant.
- **Do not** introduce Redis/external queues at current scale: in-process `p-queue` + SQLite are proportionate; revisit only with measured multi-instance needs.
- **Do not** lower `AI_MAX_RETRIES` to 0 or remove retries entirely: transient-failure tolerance matters more than the marginal duplicate-cost risk (use per-feature budgets instead, A-7).

---

## 13. Final Recommendations

Start with reliability and tooling (Quick Wins 1-6): they are small, independently shippable, and remove the only confirmed user-facing data-loss path (C1). Then close the cost-visibility gap (A-1) before any cost-tuning work, because every other AI optimization is unverifiable without it. Resolve the quiet-mode discrepancy (F1) as a product decision, not just a code edit. Defer model routing and media streaming until usage data confirms where money and memory actually go. Keep the architecture; invest in tests around routing, sending, and cleanup where regressions are currently invisible.

---

## Validation Results

| Command | Result | Notes |
|---------|--------|-------|
| `npx tsc --noEmit` | **PASSED** | Clean compile, strict mode |
| `npm test` (`node --import tsx --test test/*.test.ts`) | **FAILED (pre-existing)** | 45 tests, 2 failures in `test/core.test.ts:158-159`; confirmed identical on clean HEAD via detached worktree — stale assertions, not regressions |
| `npx eslint 'src/**/*.{ts,js}'` | **BLOCKED** | Toolchain crash: `eslint-plugin-prettier@4` incompatible with `prettier@3` (see C5) |
| `prisma migrate diff` (migrations → schema) | **PASSED** | Only cosmetic auto-index renames; no schema drift |
| Relative-import `.js` extension check (ripgrep PCRE) | **PASSED** | No violations |
| `npm audit` | **FAILED** | 13 vulnerabilities (10 high, 3 moderate) — see C4 |
| `npm outdated` | informational | Majors available for eslint 10, openai 7, pino 10, prisma 7/8-rc, node-cron 4; no upgrade performed |

## Audit Limitations

- No runtime traffic, latency, or cost measurements exist in-repo; all performance/cost findings are structural, labeled accordingly, with no invented numbers.
- The memory-cleanup edge case (settings-less conversations) is mitigated in practice because `getChatSettings` upserts a settings row on every processed message; residual risk rated 6/10.
- VK Long Poll redelivery behavior (C2) depends on VK-side semantics; the absence of any dedup in code is confirmed, the redelivery frequency is environment-dependent.
- Lint-dependent checks (e.g. unused-variable sweeps beyond `tsc`) could not run due to C5.
