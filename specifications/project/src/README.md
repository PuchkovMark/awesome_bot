# Исходный код `src/`

Индекс точек входа и инфраструктуры приложения. В спецификациях повторяется структура каталога `src/`; сервисные модули собраны в [индексе сервисов](services/README.md).

| Документ или каталог | Источник | Назначение |
| --- | --- | --- |
| [Bootstrap](bootstrap.md) | [`src/bootstrap.ts`](../../../src/bootstrap.ts) | Инициализация приложения, фоновых заданий и завершение процесса. |
| [Архитектура](architecture.md) | [`src/services/vk/vkService.ts`](../../../src/services/vk/vkService.ts), [`src/services/detector/detectorService.ts`](../../../src/services/detector/detectorService.ts) | Поток входящих VK-сообщений и передача управления между слоями. |
| [Конфигурация](config/README.md) | [`src/config/index.ts`](../../../src/config/index.ts) | Настройки приложения и значения по умолчанию. |
| [База данных](db/README.md) | [`src/db/client.ts`](../../../src/db/client.ts) | Общий Prisma client. [`src/db/index.ts`](../../../src/db/index.ts) только переэкспортирует `client.ts`. |
| [Контейнер зависимостей](di/README.md) | [`src/di/container.ts`](../../../src/di/container.ts) | Регистрация и разрешение зависимостей. |
| [Фоновые задания](jobs/README.md) | [`src/jobs/`](../../../src/jobs) | Регистрация, расписания и обработка фоновой работы. |
| [Журналирование](logger/README.md) | [`src/logger/index.ts`](../../../src/logger/index.ts) | Общий структурированный logger и файловая ротация. |
| [Сервисы](services/README.md) | [каталог `src/services/`](../../../src/services) | VK-маршрутизация и доменные возможности бота. |
| [Объявления типов](types/README.md) | [`src/types/node-cron.d.ts`](../../../src/types/node-cron.d.ts) | Compile-time контракт `node-cron`; runtime-поведения не добавляет. |

