# Awesome VK AI Bot

Production-ready TypeScript Node.js bot for VKontakte with AI integration.

Features:
- Handles direct messages and chat mentions
- Pluggable AI providers (OpenAI implemented)
- Conversation history with Prisma + SQLite (migratable to Postgres)
- Per-user request queue, command handling, automatic context cleanup

Quick start

1. Copy `.env.example` to `.env` and fill required values (at least `VK_TOKEN` and `VK_GROUP_ID`).

2. Install dependencies:

```bash
npm ci
```

3. Generate Prisma client and run migrations:

```bash
npx prisma generate
npx prisma migrate dev --name init
```

4. Run in dev:

```bash
npm run dev
```

Run in production (build + start):

```bash
npm run build
npm start
```

Docker

Build and run with docker-compose:

```bash
docker compose up --build -d
```

Notes

- To use OpenAI, set `OPENAI_API_KEY` in `.env`.
- To switch to PostgreSQL, change `DATABASE_URL` and run Prisma migrations — business logic does not depend on DB vendor.

