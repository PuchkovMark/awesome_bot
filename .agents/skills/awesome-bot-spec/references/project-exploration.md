# awesome_bot exploration map and documentation contracts

Read this reference when using awesome-bot-spec. The paths below are starting points verified during skill maintenance, not an authoritative inventory. Rediscover current registrations and callers on each run; document additions, removals, and conditions from current code. All source paths below are relative to the repository root.

## Source map

| Area | Starting points | Questions to resolve |
| --- | --- | --- |
| Lifecycle | `src/bootstrap.ts`, `src/di/container.ts`, `src/db/client.ts`, `src/jobs/scheduler.ts` | What starts where, what is recovered/dropped, and what stops on shutdown? Include jobs registered by VK startup rather than bootstrap. |
| VK routing | `src/services/vk/vkService.ts`, `vkMention.ts`, `src/services/detector/`, `src/services/queue/` | Trace `message_new` and `message_event`, mentions/replies, private/group messages, active/normal/quiet modes, questionnaire branches, rate limits, queues and maintenance. Preserve branch order and early returns. |
| Command discovery | `src/services/command/commandService.ts`, `commandAliases.ts`, `commandHelp.ts`, domain `handleCommand` methods | Reconcile executable branches, aliases, help, role checks, command tools, buttons and multiword commands. Help alone is incomplete evidence. |
| Main-model tools | Tool construction and `provider.send` in `vkService.ts`; `src/services/ai/tools/`; `AIProvider.ts` | Find exact tool names and argument schemas, then resolve the final request's conditional tool arrays. Include questionnaire-only and active-response decision branches. Distinguish definitions from actual exposure. |
| Provider execution | `providerFactory.ts`, `opencodeProvider.ts`, `chatCompletion.ts`, `textModels.ts`, `effort.ts` | Follow model aliases, persisted overrides, effort, request/session options, tool execution loop, limits, retries, errors and usage accounting. API compatibility does not mean OpenAI is the text provider. |
| Advertised capabilities | `src/services/ai/capabilityService.ts`, help and prompt construction in `vkService.ts` | Compare advertised features with executable paths and contextual restrictions. Automatic search in `searchIntentService.ts`/`searchService.ts` is a separate path, not necessarily a model tool. |
| Delivery | `src/services/sender/`, `src/services/splitter/`, `tools/messageDeliveryTool.ts`, post-provider branches in `vkService.ts` | Distinguish returned tool text from messages/files already sent to VK. Trace delivery guards, suppression of duplicate replies, mentions, recipients, splitting, attachments and voice. |
| Background history | `subagentService.ts`, `subagentTools.ts`, `chatDigestService.ts`, `subagentResultDeliveryService.ts`, `src/jobs/subagentDeliveryJob.ts` | Record SQL history scope, participant resolution, chunking, tool restrictions, persisted job states, concurrency, cancellation/interruption and final delivery. Do not assume background reports allow user actions. |
| History and memory | `src/services/memory/`, `tools/localChatHistoryTool.ts`, `src/jobs/cleanupJob.ts`, `longTermMemoryJob.ts` | Distinguish prompt history, retained SQL messages, summaries, long-term memory, embeddings and action drafts; trace retention, confirmation and isolation. |
| Domain features | `src/services/games/`, `fun/`, `reminders/`, `settings/`, `member/`, `membership/` | Enumerate subcommands, callback flows, settings, state transitions, roles, persistence and scheduled work. Include profiles/questionnaires, personality versions, location/time zones, membership events, games, meme voting and reminders. |
| Media | `src/services/image/`, `document/`, `voice/`, `src/services/vk/vkFileDownload.ts`, attachment/image tools | Distinguish generation, editing, analysis, OCR, documents, transcription and speech output. Trace attachment selection, download validation, size/type limits, permissions and direct delivery. |
| Persistence and operations | `prisma/schema.prisma`, migrations, `src/config/index.ts`, `.env.example`, `Dockerfile`, `docker-compose.yml`, `package.json`, `test/` | Resolve data contracts, indexes, migration behavior, defaults, effective settings, container mounts, scripts and evidence from existing tests. Never inspect production data or disclose configured secrets to fill documentation. |

## Required deliverables for a full-project request

Write durable specifications under `specifications/project/`, not only a long chat response. Keep `specifications/README.md` as navigation and `specifications/tasks/` for individual task artifacts. Update the project index and reuse existing material. Follow the entity-per-file directory layout in SKILL.md: each service and job has a canonical file in its corresponding directory; all commands and subcommands share specifications/project/src/services/command/commands.md with dedicated section anchors; all main-model and subagent tools share specifications/project/src/services/ai/tools.md with a section per exact public tool name; all Prisma models share specifications/project/prisma/models.md with a section per exact model name. Catalogs and thematic overviews link to entity files and describe shared flows. The following subjects must be readily discoverable:

- Architecture, lifecycle and ordered message/callback routing.
- Complete command and subcommand catalog, including aliases and permission matrix.
- Complete model-tool catalog and availability matrix by execution context.
- AI provider, prompts, context, history, memory and subagent execution.
- Data contracts and authorization/isolation invariants.
- Feature scenarios, state machines and background jobs.
- Configuration, deployment and verification.
- Agent navigation map, coverage ledger and unresolved questions.

A full-project specification is not complete when it contains only overview paragraphs such as “games are in games/” or “see the schema for exact fields.” Inspect the implementation and record behavior needed to change it. Use directory index tables for discovery and individual entity files for contracts; avoid repeating identical shared rules in every entry.

### Command contract

Document each executable command and materially different subcommand in its own section of the single commands.md catalog; do not split commands into separate files. Include canonical name; exact aliases (including localized/multiword forms); `/` versus `!` and addressing rules; syntax, defaults and invalid inputs; private/group availability; actor roles (creator, bot admin, conversation admin, participant); handler and downstream services; observable output and delivery; side effects; confirmation/cancellation; errors and external dependencies. Include a normal example and a denied/invalid example where behavior differs. Record callback payload/action and server-side checks for related buttons. Do not infer that an alias list or an execution-tool allowlist proves direct reachability.

### Tool contract

Keep all main-model and subagent tools in the single tools.md catalog, with a dedicated anchored section per exact exposed `AITool.name`; do not create per-tool specification files. List parameter fields with type, required status, defaults/enums/limits, additional-properties rules and semantic validation. Describe result format and statuses, failure behavior, actor/conversation binding, authorization, repeat-call restrictions, external calls, persistence and delivery. Include representative valid arguments and result shape grounded in code; label illustrative examples. Explain whether the tool returns analysis, sends a message, changes state, or starts deferred work. Document the execution path and suppressions preventing a second response. Include availability rows for ordinary chat, active decisions, questionnaire-only requests and background subagents where those contexts exist. Explicitly identify unused definitions and helpers rather than presenting them as available tools.

### Persistence, configuration and job contracts

Keep all Prisma models in the single models.md catalog with a dedicated anchored section per exact model name; do not create per-model specification files. For each model, record purpose, important fields/types/defaults, keys/indexes/relations, ownership scope, writers/readers, retention and deletion implications. Explain JSON serialized into SQLite string fields and persisted state values. Detail all fields affecting public contracts or invariants; group purely mechanical fields concisely. Document the difference between intended schema relations and checks enforced only in application code.

For configuration, enumerate keys read by code and compare them with `.env.example`: type, default, required conditions, consumer, feature impact and precedence against saved settings. Use placeholder values for credentials. Do not copy live environment values.

For each scheduled/deferred process, record trigger, schedule/time zone, registration site, selection and state transitions, locks/concurrency, duplicate protection, retry/error behavior, restart/shutdown and delivery. State when a safeguard is absent rather than inventing one.

### Evidence and completion report

Maintain a durable coverage table mapping each entity identity to its source symbol and canonical specification file, with discovered entity counts by category, documented counts and explained exclusions. Verify one canonical file per entity other than commands, tools and Prisma models, one canonical section per command in commands.md, per tool in tools.md and per Prisma model in models.md, and index reachability for both files and catalog anchors. Do not hard-code expected counts in this skill. Link implementation at the detailed contract level, not just once per document. Map existing tests to the specific behavior they establish and label static inspection separately from executed checks.

For every inventory, reconcile definitions with registrations and execution branches in both directions. Cross-check advertised help/capabilities against runtime behavior and document discrepancies without fixing code. List unresolved facts with the affected behavior and source still needing inspection. If the task cannot be completed in the current pass, save verified documents and the remaining-work ledger and report partial coverage honestly.

The final chat response should provide linked documents, the main behavior covered, inventory counts, verification performed and remaining gaps. Put exhaustive technical details in the linked specifications so agents can reuse them without the conversation.
