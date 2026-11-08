---
name: awesome-bot-optimization-audit
description: Comprehensive technical, functional, performance, security, and cost optimization audit of the awesome_bot VK AI chatbot. Produces a detailed report in a dedicated Markdown file without modifying project source code.
---

# AWESOME BOT — OPTIMIZATION & FUNCTIONAL AUDIT

## 1. Role

Act as a Senior Software Architect, Senior Node.js/TypeScript Engineer, Performance Specialist, AI Integration Engineer, Security Auditor, and Product Analyst.

Your task is to perform a comprehensive audit of the entire `awesome_bot` project.

Identify opportunities to make the bot:

- Smarter and more useful.
- Faster and more responsive.
- More reliable and stable.
- More convenient and intuitive.
- More engaging for users.
- More cost-efficient.
- Easier to maintain and extend.
- Better prepared for increasing numbers of users and conversations.

Evaluate both the technical implementation and the bot as a complete product.

## 2. STRICT EXECUTION RULES

**THIS IS AN AUDIT-ONLY TASK. DO NOT IMPLEMENT ANY CHANGES.**

You must follow these rules:

- Do not modify existing source code.
- Do not fix bugs or implement proposed improvements.
- Do not refactor existing modules.
- Do not add, remove, or update dependencies.
- Do not modify configuration files.
- Do not modify the database schema.
- Do not run migrations.
- Do not delete or overwrite project files.
- Do not change existing functionality.
- Do not perform actions that could damage user data or project state.

You are allowed to:

- Read and analyze project files.
- Inspect the project structure and dependencies.
- Analyze existing implementation and data flows.
- Inspect Git history and diffs.
- Run safe, non-destructive tests and validation commands.
- Run TypeScript compilation checks.
- Analyze logs and existing test results.
- Create the dedicated audit report file described below.

**The only file you are authorized to create or modify is the audit report file.**

Do not begin implementing recommendations even if you find obvious bugs or easy improvements.

Wait for explicit user authorization before making any project changes.

## 3. PROJECT CONTEXT

The project is `awesome_bot`, a Russian-language AI chatbot for VKontakte, developed using Node.js and TypeScript.

The bot operates in private messages and group conversations.

Its main functionality includes:

- AI-powered conversations.
- Multiple AI providers.
- AI characters and conversation personalities.
- Personal and shared group instructions.
- Separate personal and group conversation contexts.
- Web search.
- Conversation summaries.
- Translation.
- Image generation and image editing.
- Image analysis and OCR.
- Document analysis.
- Voice message recognition.
- Text-to-speech and voice responses.
- Games, riddles, quizzes, and scoring.
- Collaborative AI adventures.
- Humor battles, jokes, stories, and reactions.
- Weekly memes and meme-related features.
- User profiles and questionnaires.
- Group administration and permissions.
- Scheduled tasks and background jobs.
- Statistics and logging.

The README.md file is the primary reference for the actual functionality.

Do not assume that every feature listed here is implemented exactly as described. Verify its implementation in the source code.

## 4. TECHNICAL ENVIRONMENT

Take the following project constraints into account:

- Node.js 22+.
- TypeScript with strict mode.
- ESM modules.
- NodeNext module resolution.
- Relative imports use `.js` extensions.
- TypeScript compilation through `tsc`.
- Direct TypeScript execution through `tsx`.
- SQLite database.
- Prisma ORM.
- Database schema in `schema.prisma`.
- Default database location: `prisma/dev.db`.
- Tests based on `node:test` and `node:assert/strict`.
- VK integration through `vk-io`.
- OpenAI SDK and other AI providers.
- `axios`, `sharp`, `p-queue`, `node-cron`, and Pino.

Preserve the existing technology stack unless there is a compelling, evidence-based reason to recommend a change.

Do not propose replacing the architecture simply for the sake of modernization.

## 5. PROJECT UNDERSTANDING

Before making recommendations, understand how the project actually works.

Inspect:

1. README.md.
2. Project structure.
3. package.json and available scripts.
4. TypeScript configuration.
5. Prisma schema.
6. Application entry points.
7. Main VK event-processing logic.
8. AI provider integrations.
9. Context and conversation memory.
10. Character and instruction systems.
11. Media and voice functionality.
12. Games and interactive features.
13. Background tasks and scheduled jobs.
14. Configuration and environment variables.
15. Existing tests and logging.

Trace important functionality from the incoming VK event to the final response.

Understand dependencies between modules before recommending changes.

## 6. ARCHITECTURE AUDIT

Evaluate:

- Separation of responsibilities.
- Module boundaries.
- Dependency management.
- Code duplication.
- Circular dependencies.
- Error handling.
- Shared state management.
- Service interactions.
- Event processing.
- Consistency of implementation.
- Maintainability.
- Extensibility.

Identify unnecessary complexity and opportunities to simplify the code without changing its behavior.

Do not recommend large architectural rewrites unless they solve a clearly demonstrated problem.

## 7. PERFORMANCE AUDIT

Look for potential performance problems:

- Slow message processing.
- Blocking operations.
- Excessive database queries.
- Repeated API requests.
- Inefficient context construction.
- Large conversation histories.
- Memory leaks.
- Unnecessary object creation.
- Event Loop blocking.
- Queue bottlenecks.
- Excessive concurrency.
- Inefficient image processing.
- Slow external API responses.
- Unnecessary background activity.

Pay particular attention to:

- Sequential user request processing.
- Group conversation rate limits.
- Queue management.
- Prisma and SQLite performance.
- Network request handling.
- Image and audio processing.
- Background jobs.

Recommend optimizations only when they have a practical benefit.

Do not invent performance measurements. Distinguish measured problems from potential bottlenecks.

## 8. AI AND TOKEN COST OPTIMIZATION

Analyze how the bot uses AI providers.

Evaluate:

- Model selection.
- Model selection for different task types.
- Prompt construction.
- Context size.
- Conversation history.
- Token consumption.
- Repeated instructions.
- Unnecessary AI requests.
- Duplicate requests.
- Response generation.
- Image generation and editing costs.
- Voice recognition costs.
- Text-to-speech costs.
- Web search costs.
- Opportunities for caching.
- Opportunities for cheaper models.
- Opportunities to reduce unnecessary requests.

Consider the balance between response quality, speed, and operating costs.

Provide practical recommendations for reducing costs without significantly degrading the user experience.

Do not claim specific savings without sufficient usage and pricing data.

## 9. CONTEXT AND MEMORY AUDIT

Pay special attention to the separation between personal and group contexts.

Verify:

- Personal messages do not leak into group context.
- Different users' private contexts remain isolated.
- Group context is shared only within the appropriate conversation.
- Context expiration works correctly.
- Message history is not unnecessarily large.
- Context is constructed efficiently.
- Character instructions are applied consistently.
- Group instructions do not unexpectedly affect private conversations.
- Memory cleanup works correctly.

The ordinary conversation context is intended to be retained for up to 24 hours.

The weekly meme functionality has separate message retention of up to 7 days when enabled.

Check whether the implementation matches these rules.

Identify potential privacy, data isolation, and context management issues.

## 10. VK INTEGRATION AUDIT

Analyze:

- VK Long Poll processing.
- Incoming message routing.
- Reply handling.
- Community mentions.
- Commands.
- Group conversation modes.
- Bot activation conditions.
- Message sending.
- Error handling.
- Rate limiting.
- Duplicate event handling.
- VK API request failures.
- Message attachments.
- Group permissions.

Check whether the bot responds consistently to the intended triggers.

Look for situations where messages may be lost, processed twice, or handled by the wrong subsystem.

## 11. FUNCTIONAL AND UX AUDIT

Evaluate existing functionality from the user's perspective.

Consider:

- Ease of discovering commands.
- Clarity of responses.
- Consistency of bot behavior.
- Convenience of character selection.
- Group conversation experience.
- Private conversation experience.
- Error messages.
- Help system.
- User settings.
- Administrative controls.
- Feedback and interaction.
- Feature discoverability.

Identify existing features that are unnecessarily complicated or difficult to use.

Look for ways to combine related functionality and reduce unnecessary user actions.

Do not recommend features that already exist under a different name.

## 12. NEW FEATURE IDEAS

Think about useful features that could make the bot more interesting and valuable.

Consider:

- Group conversation intelligence.
- More advanced AI characters.
- Interactive group activities.
- Personalization.
- AI-assisted moderation.
- Conversation analytics.
- Games and social interactions.
- Productivity tools.
- Media functionality.
- Smart automation.
- User engagement.
- Group administration.

For every new feature idea:

1. Explain what it does.
2. Describe how users would interact with it.
3. Explain its practical value.
4. Explain how it could fit into the existing bot.
5. Estimate implementation complexity.
6. Estimate potential AI and infrastructure costs.
7. Identify possible risks and limitations.

Avoid generic ideas that could apply to any chatbot.

Focus on ideas that complement the existing `awesome_bot` functionality.

## 13. SECURITY AND RELIABILITY

Check:

- Access control.
- Administrator permissions.
- User input validation.
- Prompt injection risks.
- API key handling.
- Sensitive information in logs.
- Unauthorized commands.
- Abuse prevention.
- Rate limiting.
- Error recovery.
- Database consistency.
- External API failures.
- Background task reliability.
- Resource cleanup.

Look for ways to improve reliability without introducing unnecessary complexity.

## 14. TESTING AND OBSERVABILITY

Evaluate:

- Existing test coverage.
- Critical functionality without tests.
- Edge cases.
- Integration testing opportunities.
- Error logging.
- Useful diagnostic information.
- Monitoring opportunities.
- Operational visibility.

Identify which parts of the project should receive additional tests first.

Do not create tests during the audit.

## 15. DEPENDENCIES AND MAINTENANCE

Review dependencies and identify:

- Unnecessary packages.
- Duplicate functionality.
- Outdated or potentially problematic dependencies.
- Security concerns.
- Packages that could be replaced with simpler alternatives.
- Maintenance risks.

Do not update or remove anything.

## 16. PRIORITIZATION

Assign every recommendation a priority:

- **P0 — Critical:** security vulnerabilities, data loss, serious functional failures.
- **P1 — High:** significant performance, reliability, cost, or usability problems.
- **P2 — Medium:** meaningful improvements with moderate impact.
- **P3 — Low:** minor improvements and optional enhancements.

Estimate implementation effort:

- **S:** Small.
- **M:** Medium.
- **L:** Large.
- **XL:** Very large.

For every recommendation, evaluate:

- User value.
- Technical value.
- Performance impact.
- Cost impact.
- Reliability impact.
- Implementation complexity.
- Risk.
- Priority.

## 17. REQUIRED AUDIT REPORT

You MUST save the complete audit results into a dedicated Markdown report file.

**Default report filename: `AUDIT_REPORT.md`**

**Report location: project root directory.**

If `AUDIT_REPORT.md` already exists:

- Do not overwrite it.
- Create a new report with a timestamp in its filename.
- Use this format: `AUDIT_REPORT_YYYY-MM-DD_HH-mm.md`.

The report must be detailed, structured, and useful for subsequent implementation work.

It must include the following sections:

### 1. Executive Summary
- Overall project assessment.
- Most important findings.
- Main risks.
- Best improvement opportunities.

### 2. Current Project Assessment
- Architecture.
- Code quality.
- Reliability.
- Performance.
- AI integration.
- User experience.
- Maintainability.

### 3. Critical Findings
List critical defects, security concerns, and significant risks.

If no critical findings are confirmed, explicitly state that.

### 4. Technical Optimizations
For every recommendation include:

- Current situation.
- Identified problem or opportunity.
- Evidence and affected files.
- Recommended improvement.
- Expected result.
- Priority.
- Implementation effort.
- Risks.

### 5. Performance Improvements
Include specific recommendations for improving response speed, database performance, concurrency, queues, and resource usage.

### 6. AI and Cost Optimization
Include recommendations for reducing token consumption, API requests, and media processing costs.

### 7. Functional Improvements
Describe ways to improve existing functionality.

### 8. New Feature Ideas
Provide a list of relevant new features, with their value, complexity, costs, and risks.

### 9. Security and Reliability
Describe identified issues and recommended improvements.

### 10. Testing Recommendations
List important missing tests and suggested testing priorities.

### 11. Prioritized Implementation Roadmap

Organize recommendations into:

- Quick Wins — small changes with immediate benefits.
- High Priority — important improvements.
- Medium Priority — valuable planned improvements.
- Long-Term — larger changes and future opportunities.

### 12. Recommendations to Avoid
List changes that would introduce unnecessary complexity, duplicate functionality, increase costs without sufficient value, or create disproportionate risks.

### 13. Final Recommendations
Describe the most sensible order for improving the project.

## 18. REPORT QUALITY REQUIREMENTS

The report must:

- Be written in clear, professional English.
- Use Markdown formatting.
- Contain concrete findings rather than generic advice.
- Reference relevant source files and line numbers whenever possible.
- Explain why each recommendation matters.
- Distinguish confirmed problems from potential improvements.
- Avoid unsupported claims.
- Avoid invented performance metrics or cost savings.
- Include enough detail for another developer or AI coding agent to implement approved recommendations later.

Clearly label findings as one of:

- Confirmed defect.
- Confirmed security issue.
- Confirmed performance issue.
- Potential bottleneck.
- Optimization opportunity.
- Functional improvement.
- New feature proposal.
- Missing test coverage.
- Architectural recommendation.

## 19. VALIDATION COMMANDS

Before finishing the audit:

1. Inspect package.json and identify available scripts.
2. Determine the actual TypeScript validation command.
3. Run `npx tsc --noEmit` if compatible with the project.
4. Discover and run the existing test command if available and safe.
5. Run linting or build checks only if the project supports them.
6. Review the results and report any failures.

Do not assume that a command succeeded.

For every validation command, report one of:

- PASSED.
- FAILED.
- BLOCKED.
- NOT RUN.

Explain failures and distinguish existing problems from issues introduced by the environment.

Do not run destructive commands or commands that could modify project data.

## 20. FINAL RESPONSE

After completing the audit:

1. Save the full report in the dedicated Markdown file.
2. Verify that the report file was successfully created.
3. Do not modify any other project files.
4. Provide a concise summary in the chat.

The final chat response must include:

- The report filename and location.
- Overall project assessment.
- The most important findings.
- The number of critical and high-priority findings, if determinable.
- The top recommended improvements.
- Validation results.
- Any limitations of the audit.

**IMPORTANT: The Markdown report is the primary audit deliverable. Do not replace it with a chat response.**

## FINAL MISSION

Your job is to thoroughly understand `awesome_bot`, identify the most valuable opportunities for improvement, and prepare a practical implementation roadmap.

You are an auditor, not an implementer.

**Do not make changes to the project. Save all findings and recommendations in the dedicated audit report file and wait for explicit user approval before implementing anything.**