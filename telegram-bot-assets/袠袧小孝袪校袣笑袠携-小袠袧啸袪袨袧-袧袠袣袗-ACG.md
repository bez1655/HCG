# Инструкция агенту ACG: смена Telegram-ника

Сделай в Али **то же**, что в HCG `2026-09-06.1`. Репозиторий Али: https://github.com/bez1655/ALI2.0. HCG не трогать.

## Зачем

Игрок меняет @ в Telegram. Mini App пускает по числовому `telegramId`, а в админке/CSV остаётся `@старый`. Сообщения бота на старый @ не доходят.

Telegram **не присылает** событие «ник сменился». Новый @ видно только если:

- человек написал боту Али или открыл Mini App;
- бот вызвал `getChat(telegramId)` (нужен прошлый `/start`).

## Что сделать

Скопируй **логику** из HCG: `src/game/telegramIdentity.ts`, правки `server.ts` (`telegram-user`, `telegram/auth`, `player-status`, `telegram-bindings`), `bot/src/index.ts` (`/sync_names`, middleware с `telegramId`), `src/telegram/notifier.ts` (ключ `id:` и удаление старого `@`), поле `previousHandles` в типе игрока.

Не копируй доску, токены, `BUILD` HCG.

## Проверка

`/sync_names` у админа бота Али. Смена тестового @ → новый в таблице, псевдоним тот же. Старым паролем вход жив.
