# База данных

| Документ | Сущность и источник | Назначение |
| --- | --- | --- |
| [client.md](client.md) | [`src/db/client.ts`](../../../../src/db/client.ts): singleton `prisma`, `connectDb()` | Создание и подключение общего Prisma client. |

[`src/db/index.ts`](../../../../src/db/index.ts) — переэкспорт `client.ts`; отдельного состояния или поведения у него нет. Схема и контракты моделей находятся в [каталоге Prisma](../../prisma/README.md).

