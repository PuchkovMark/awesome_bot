# Repository Guidelines

## Project Structure & Module Organization

This project is a TypeScript ESM bot for VK, with AI responses and SQLite persistence. `src/bootstrap.ts` starts the application. Feature logic lives in `src/services/` (AI tools, VK integration, games, memory, voice, and reminders); scheduled tasks live in `src/jobs/`. Shared infrastructure is in `src/config/`, `src/db/`, `src/logger/`, and `src/di/`. Prisma schema and migration history live in `prisma/`. Tests are in `test/`; compiled output goes to `dist/`.

## Project Skills and Specifications

Reusable agent instructions are stored in [.agents/skills/](.agents/skills/). Select the skill matching the user's request and read its linked `SKILL.md` before applying it, even if it is not listed in your automatically discovered skill catalog. Resolve supporting references relative to that skill's directory and read only those needed for the task. If a skill is explicitly requested, use it; report a missing file rather than assuming its instructions. Skills guide the work within the user's scope and do not authorize unrelated changes or external actions.

| Skill | When to use |
| --- | --- |
| [awesome-bot-spec](.agents/skills/awesome-bot-spec/SKILL.md) | Deeply inspect the existing project or a subsystem and create detailed specifications, including VK commands, model tools, permissions, data and jobs. |
| [awesome-bot-spec-update](.agents/skills/awesome-bot-spec-update/SKILL.md) | Synchronize existing specifications with implemented changes or a completed task. |
| [awesome-bot-task](.agents/skills/awesome-bot-task/SKILL.md) | Define a development task, scope and acceptance criteria before implementation planning. |
| [awesome-bot-plan](.agents/skills/awesome-bot-plan/SKILL.md) | Create an implementation plan for a defined task. |
| [awesome-bot-implement](.agents/skills/awesome-bot-implement/SKILL.md) | Implement a defined task according to its task document and plan. |
| [awesome-bot-review](.agents/skills/awesome-bot-review/SKILL.md) | Review requested changes for concrete defects, regressions, permission errors and data isolation issues. |
| [systematic-debugging](.agents/skills/systematic-debugging/SKILL.md) | Investigate bugs, failing tests and unexpected behavior before proposing fixes. |
| [sql-database-assistant](.agents/skills/sql-database-assistant/SKILL.md) | Analyze or write SQL, investigate query problems, or work on Prisma/ORM migrations. |

The [specifications index](specifications/README.md) separates the [general project specification](specifications/project/README.md) from [individual task documents](specifications/tasks/README.md). Verify documented behavior against current code. Keep general documentation in `specifications/project/` and task requirements, plans and reviews in the relevant task folder under `specifications/tasks/`.

For implementation requests, follow task definition → planning → implementation as described by the skills; reuse existing task documents when continuing work. A documentation-only, planning-only or review-only request does not authorize implementation. Use the specification skill for comprehensive exploration and the update skill for incremental maintenance.

## Build, Test, and Development Commands

Use Node.js 22.13 or newer.

The host runs Ubuntu 18, where the available system Node.js version is limited to 16. Run the project in Docker using `docker compose up --build`; the Docker image supplies Node.js 22 and Compose applies Prisma migrations before starting the app. Run Node.js-dependent development and validation commands in a suitable Node.js 22 container rather than using the host Node.js.

- `npm ci`: install dependencies from the lockfile.
- `cp .env.example .env`: create local configuration; fill in required credentials.
- `npm run prisma:generate`: regenerate the Prisma client after schema changes.
- `npm run prisma:migrate`: create/apply development database migrations.
- `npm run dev`: run the bot through `tsx`.
- `npm run build` / `npm start`: compile TypeScript and run the compiled application.
- `npm test`: run `test/*.test.ts` with Node’s test runner through `tsx`.
- `npm run check`: run ESLint, formatting checks, type checking, and tests before submitting changes.

## Coding Style & Naming Conventions

Follow `CODE_STYLE.md`. Use two-space indentation, single quotes, semicolons, trailing commas, and Prettier’s 100-column width. Run `npm run format` and `npm run lint:fix` for automatic fixes.

Use `camelCase.ts` filenames and camelCase functions/variables; use PascalCase for types and classes. Keep TypeScript strict, prefer `unknown` with validation over `any`, and use type imports. Local ESM imports require `.js` extensions. Log through the shared structured logger. Keep modules focused on one responsibility.

## Testing Guidelines

Use `node:test` with `node:assert/strict`, naming files `<feature>.test.ts`. Test observable behavior, mock external APIs or use local HTTP servers, and keep time, randomness, and identifiers deterministic. Add regression coverage for changed behavior. No numeric coverage threshold is configured.

## Commit & Pull Request Guidelines

History mixes short descriptive messages with prefixes such as `feat:` and `fix:`. Use concise imperative subjects and one logical change per commit; separate formatting changes. PRs should explain behavior changes, link relevant issues, list validation results, and mention configuration or database changes.

## Security & Configuration

Never commit `.env`, credentials, SQLite databases, logs, `node_modules/`, or `dist/`. Document new configuration keys in `.env.example`. Use the shared Prisma client in `src/db/client.ts` and avoid logging tokens or private message content.
