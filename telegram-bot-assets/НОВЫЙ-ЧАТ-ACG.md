# Новый чат агента ACG — перенос актуального HCG на Али

Скопируй этот файл **целиком** в первое сообщение нового чата.  
Этот чат — **только Али-Баба**. Каталог HCG (`/var/www/hcg`, `@hcg1_bot`, `hcg.bez12.store`) **не трогать**.

Эталон логики: репозиторий HCG, маркер **`2026-09-06.1`**.  
Репозиторий Али: **https://github.com/bez1655/ALI2.0** (ветка `main`, сейчас **`2026-08-23.1`**).  
Не копируй доску, клетки, токены, домен, package id и номер сборки HCG.

---

## Что нельзя смешивать

| | HCG | ACG (Али) |
|---|---|---|
| Каталог VPS | `/var/www/hcg` | `/var/www/ali` |
| Контейнеры | `hcg_*` | `ali_*` |
| Домен | `hcg.bez12.store` | `ali.bez12.store` |
| Бот / токен | свой | свой `.env` |
| APK package | `store.bez12.hcg` | `store.bez12.ali` |
| Порт | 3001→3000 | обычно 3002 |
| GitHub | отдельный | `https://github.com/bez1655/ALI2.0` |
| Версия сейчас | `2026-09-06.1` | своя, **не копируй номер** |

Токены, клетки, доска, призы, package id — только Али.  
Распаковка архива **рядом** с живым каталогом: `/var/www/ali-new`, никогда внутрь `/var/www/ali`.  
Git Али: `git -c user.name="ACG" -c user.email="acg@local"`.

Заказчик не программист: готовые команды PowerShell / PuTTY, без жаргона.

---

## Что уже есть в ACG (не ломай)

Проверено по `ALI2.0` на `2026-08-23.1`:

- Mini App админка по списку бота: `isTelegramAdminHandle`, `.env` + `admin_list.json`, **без хардкода @**.
- Псевдонимы, маскировка хендлов игрокам, `/msg` `/all` `/players` `/history` `/prizes` `/report` `/requests`.
- `client:resync`, тёмный фон `html/body/#root`, CrashGuard **только вокруг доски**.
- Скрытие фишек, напоминания, тихие часы, отчёт.
- `BOT_USE_PROXY` в compose по умолчанию `0`.

**Не копируй** видео/картинки доски HCG в Али.

---

## Чего в ACG ещё НЕТ (сделай по порядку)

Ниже — дыры относительно HCG `2026-09-06.1`. Имена файлов HCG — ориентир; в Али ищи аналоги.

### 1. Падение APK / белый экран админки — СРОЧНО

В `src/components/AdminConsole.tsx` Али **до сих пор** внутри `.map` игроков:

```
initPlayerEdit(p);
```

Это `ReferenceError` при открытии админки (функцию удалили, вызов остался).  
**Сделай:** удали вызов из render. Синхронизация полей — только `useEffect` по `gameState.players`, и только если строка не `dirty`. `setState` из render запрещён.

### 2. CrashGuard на всё приложение

В HCG `src/main.tsx` оборачивает `<App />` в `<CrashGuard area="app">`.  
В Али CrashGuard только вокруг доски — падение логина/админки = белый экран без отчёта.  
Перенеси обёртку в `main.tsx`. Экран `admin` без роли `admin` показывать доску, не логин.

### 3. Смена Telegram-ника (главная новая дыра)

**Проблема:** человек меняет @ в Telegram, в админке/CSV Али остаётся старый. Вход Mini App идёт по `telegramId`, поэтому «входит, а в таблице старый @».

В ACG сейчас:

- `POST /api/internal/telegram-user` **только** пишет `telegram_users.json`, **не** переименовывает игрока.
- `/api/telegram/auth` пишет `telegramUsername`, но **`player.name` не меняет**.
- Нет модуля `src/game/telegramIdentity.ts`.
- В `telegramUserSyncSchema` нет `telegramId`.
- Нет команды `/sync_names`.

**Сделай как в HCG** (логика, не копипаст доски):

1. Файл `src/game/telegramIdentity.ts`:
   - личность = `telegramId` (не меняется);
   - `applyTelegramHandle(players, player, handle)` обновляет `player.name` и `telegramUsername`;
   - если новый @ занят другим игроком — **не красть имя**, обновить только `telegramUsername`;
   - старый @ класть в `previousHandles` (вход по старому логину/паролю живой);
   - `findPlayerByTelegram` ищет сначала по `telegramId`, потом по name / telegramUsername / previousHandles.
2. Тип игрока: поле `previousHandles?: string[]`. В `maskPlayer` его **вырезать** (игрокам не светить).
3. Схема: `telegramUserSyncSchema` = `{ username, chatId, telegramId }`.
4. `POST /api/internal/telegram-user`: найти игрока по id, вызвать `applyTelegramHandle`, `saveState`, `broadcastSlices("players")`. При реальной смене — **личное** сообщение админу Али (не в общий журнал с хендлами).
5. `/api/telegram/auth`: после нахождения игрока вызывать `applyTelegramHandle`, не только `telegramUsername = …`.
6. `/api/internal/player-status`: принимать и `username`, и `telegramId`.
7. `GET /api/internal/telegram-bindings`: список `{ id, telegramId, name, alias }` для бота.
8. Карта `telegram_users.json`: ключи `@ник` **и** `id:<telegramId>`; при смене ника **удалять** старый `@`.
9. Бот: middleware шлёт `telegramId`; команда админа **`/sync_names`** — для каждого игрока с id вызвать Telegram `getChat(telegramId)` и прогнать через `telegram-user`. Раз в ~6 часов то же само.  
   `getChat` работает только если человек когда-то нажал /start у **бота Али**.
10. Псевдоним (герой) **не менять**.
11. Не массово двигать фишки из истории.

Проверка: смени тестовый @ → `/start` или «ИГРАТЬ» или `/sync_names` → в админке и CSV новый @, псевдоним тот же, старым логином войти можно.

### 4. История `/history` — формат HCG 29.3+

В Али история сырая: `кубик N · from ➔ to`, без имён клеток, без штрафа/бонуса отдельной фразой, штампы только-время могут стать «сегодня».

Нужно **как в текущем HCG** (одна строка на бросок, не клетка-за-клеткой):

```
1. [28.08.2026, 14:30] выпало 6 — с 6 на 12 — штраф на 9
```

Правила:

- дата из `at` (мс); штамп только-часы (`7:11:33 PM`) **не** превращать в сегодня — писать «дата неизвестна»;
- в форматтер передать **клетки доски Али**;
- префикс без даты оставлять, только если `toCell <= fromCell` первого датированного броска; прочие без даты и призы-без-даты выкинуть;
- таблица админки = истина по клеткам; **не** массово двигать игроков из кривой истории.

Ориентир: `src/game/playerHistory.ts` в HCG (`expandHistoryLines`, `mergeMoves`).

### 5. Видео логина/правил ломается из‑за `?v=`

В Али: `bg.endsWith(".mp4")`. URL `/Log.mp4?v=8` не считается видео → рисуется `<img>`.  
**Сделай:** отрезать query (`split("?")[0]`) перед проверкой. Кастомный фон админа, который не видео, не подменять логику ролика. Не копируй файлы Hapstore.

### 6. Splash / загрузка

В HCG есть `public/Splash.mp4` на сплэше. В ACG файла нет. Если в Али свой ролик — положи в `public/` Али и подключи. Не бери Splash HCG.

### 7. Скрипт очистки диска VPS

В HCG: `deploy/ОЧИСТКА-СЕРВЕРА.sh` (сначала просмотр, потом `применить` + `ДА`).  
Цели: `/root/.gradle/caches`, `.npm`, `.cache`, `.aichat-toolchain`, `.nvm`.  
**Не трогать:** `/var/lib` (Docker), `/var/www`, том данных Али, `/root/android-sdk`.  
Скрипт класть в `deploy/` Али, в нём **не** упоминать каталог hcg как цель удаления.

---

## Порядок работы в этом чате

1. Клонируй/открой код Али (`ALI2.0`), не HCG.
2. Пункты 1–2 (краш админки, CrashGuard) — сразу.
3. Пункт 3 (смена @) — полностью, с тестами на `applyTelegramHandle`.
4. Пункт 4 (история).
5. Пункты 5–7.
6. Подними **свой** `BUILD` / `SERVER_BUILD` Али (например `2026-09-24.1`), не номер HCG.
7. Архив Али без `node_modules` `.git` `dist`. Выкладка только когда заказчик скажет включать:

```bash
unzip -o ~/ALI-VPS.zip -d /var/www/ali-new
grep BUILD /var/www/ali-new/ALI2.0/bot/src/version.ts   # путь по факту архива
bash …/deploy/ВСЁ-НА-VPS.sh сервер
```

Если игра Али была остановлена — не поднимай контейнеры без команды заказчика.

---

## Проверка после включения (не раньше команды)

1. `docker ps` — `ali_*`, токен HCG не подменён, `WEB_APP_URL=https://ali.bez12.store`.
2. Админ бота Али: `/start` → ИГРАТЬ → админка **без** `initPlayerEdit is not defined`.
3. Игрок: админки нет, доска не белая.
4. `/sync_names` — список смен @; `/history` — одна строка на бросок с датой.
5. APK Али для клиентских правок **пересобрать отдельно** (`store.bez12.ali`). Mini App в боте подхватит сервер после деплоя.

---

## Первое сообщение агенту (можно вставить как есть)

```
Ты агент ACG. Только Али-Баба (/var/www/ali, ali.bez12.store, контейнеры ali_*, GitHub bez1655/ALI2.0). HCG не трогать.

Эталон логики — HCG сборка 2026-09-06.1. В Али сейчас 2026-08-23.1. Не копируй доску, токены, package id и номер сборки HCG.

Сделай недостающее:

1) AdminConsole: удали initPlayerEdit(p) из render таблицы игроков. Правки строк — useEffect, если не dirty.

2) CrashGuard вокруг всего App в main.tsx (сейчас только доска).

3) Смена Telegram @ника: личность = telegramId. Модуль applyTelegramHandle / findPlayerByTelegram. POST /api/internal/telegram-user переименовывает player.name. Auth Mini App тоже. previousHandles чтобы старый логин жил. Карта telegram_users с id: и чисткой старого @. Команда админа /sync_names + getChat(telegramId) + опрос раз в 6ч. Админу в личку «смена @». Псевдоним не менять. Схеме telegramUserSyncSchema добавить telegramId.

4) /history как в HCG 29.3+: одна строка на бросок, дата, кубик, с/на, штраф/бонус. Часы-без-даты не делать «сегодня». Клетки — доска Али. Фишки из истории не двигать.

5) Логин/правила: endsWith(".mp4") ломается на ?v= — режь query.

6) Скрипт очистки диска по образцу HCG, цели не /var/www и не Docker.

Заказчик не программист. Команды VPS готовые. Архив в конце. Игру включать только когда скажет. BUILD Али свой.
```
