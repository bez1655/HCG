/**
 * Public aliases hide the Telegram handle from other players.
 * Pool: 180 cyberpunk names from TEST (Antigravity), original to this game.
 */

export const ALIAS_POOL: readonly string[] = [
  // Хакеры (45)
  "Сайфер",
  "Нейромант",
  "Байт",
  "Глитч",
  "Зеро",
  "Вектор",
  "Крипт",
  "Прокси",
  "Синтакс",
  "Драйвер",
  "Руткит",
  "Пингер",
  "Эксплойт",
  "Патч",
  "Дебаггер",
  "Скриптер",
  "Фаервол",
  "Килобайт",
  "Алгоритм",
  "Биос",
  "Квант",
  "Матрикс",
  "Терминал",
  "Кодек",
  "Сниффер",
  "Оверклок",
  "Нейронет",
  "Даталинк",
  "Чипсет",
  "Стек",
  "Битстрим",
  "Демон",
  "Кибернет",
  "Хеш",
  "Логик",
  "Нанокод",
  "Микрокод",
  "Двоичник",
  "Протокол",
  "Субнет",
  "Сингуляр",
  "Терафлопс",
  "Хост",
  "Багфикс",
  "Апгрейд",

  // Наёмники (45)
  "Страйкер",
  "Титан",
  "Броня",
  "Рикошет",
  "Джаггернаут",
  "Авангард",
  "Корсар",
  "Бастион",
  "Молот",
  "Бульдозер",
  "Вулкан",
  "Голиаф",
  "Штурмовик",
  "Дробитель",
  "Цитадель",
  "Берсерк",
  "Крейсер",
  "Гренадер",
  "Кастет",
  "Фронтовик",
  "Рампейдж",
  "Панцирь",
  "Танк",
  "Шоквейв",
  "Бластер",
  "Снайпер",
  "Охранник",
  "Канонир",
  "Громила",
  "Стальной",
  "Артиллерист",
  "Торпедо",
  "Доминатор",
  "Броневик",
  "Заслон",
  "Легионер",
  "Коммандо",
  "Вархаммер",
  "Каратель",
  "Монолит",
  "Викинг",
  "Десантник",
  "Палач",
  "Клык",
  "Громовержец",

  // Разведчики (45)
  "Фантом",
  "Сталкер",
  "Мираж",
  "Призрак",
  "Тень",
  "Спектр",
  "Следопыт",
  "Невидимка",
  "Радар",
  "Сонар",
  "Коршун",
  "Скаут",
  "Стриж",
  "Ветер",
  "Сокол",
  "Бродяга",
  "Искатель",
  "Пилигрим",
  "Метеор",
  "Скиталец",
  "Спринтер",
  "Трейсер",
  "Стрекоза",
  "Неон",
  "Хамелеон",
  "Вспышка",
  "Орион",
  "Альтаир",
  "Пилот",
  "Навигатор",
  "Дрифт",
  "Искра",
  "Магнит",
  "Спутник",
  "Сапсан",
  "Тайфун",
  "Экспресс",
  "Пульсар",
  "Вихрь",
  "Циклон",
  "Стример",
  "Эхо",
  "Стрит",
  "Проводник",
  "Люмен",

  // Агенты (45)
  "Консул",
  "Куратор",
  "Директор",
  "Аудитор",
  "Брокер",
  "Аналитик",
  "Синдикат",
  "Модератор",
  "Ревизор",
  "Координатор",
  "Дипломат",
  "Маршал",
  "Стратег",
  "Советник",
  "Эксперт",
  "Префект",
  "Шериф",
  "Инспектор",
  "Оператор",
  "Инвестор",
  "Банкир",
  "Прокурор",
  "Атташе",
  "Эмиссар",
  "Контролёр",
  "Интендант",
  "Арбитр",
  "Секретарь",
  "Магнат",
  "Олигарх",
  "Проктор",
  "Цензор",
  "Протектор",
  "Делегат",
  "Представитель",
  "Офицер",
  "Комиссар",
  "Магистр",
  "Шеф",
  "Бюрократ",
  "Казначей",
  "Смотритель",
  "Ментор",
  "Гроссмейстер",
  "Патрон",
];


export function pickAlias(taken: Iterable<string>, random: () => number = Math.random): string {
  const used = new Set<string>();
  for (const t of taken) {
    if (typeof t === "string" && t.trim()) used.add(t.trim().toLowerCase());
  }

  const free = ALIAS_POOL.filter((a) => !used.has(a.toLowerCase()));
  if (free.length > 0) {
    return free[Math.floor(random() * free.length) % free.length];
  }

  for (let suffix = 2; suffix < 1000; suffix++) {
    for (const base of ALIAS_POOL) {
      const candidate = `${base} ${suffix}`;
      if (!used.has(candidate.toLowerCase())) return candidate;
    }
  }

  return `Герой ${Date.now()}`;
}

export function looksLikeHandle(value: string | undefined | null): boolean {
  return typeof value === "string" && value.trim().startsWith("@");
}

export function publicName(player: { alias?: string; name?: string }): string {
  const alias = player.alias?.trim();
  if (alias) return alias;
  if (player.name && !looksLikeHandle(player.name)) return player.name;
  return "Игрок";
}

const POOL_ROOTS = new Set(ALIAS_POOL.map((a) => a.toLowerCase()));

/** True when the public alias already belongs to the current pool (or "Name 2"). */
export function isHorrorAlias(alias: string | undefined | null): boolean {
  if (!alias || !alias.trim()) return false;
  const t = alias.trim().toLowerCase();
  if (POOL_ROOTS.has(t)) return true;
  const m = t.match(/^(.*) (\d+)$/);
  return Boolean(m && POOL_ROOTS.has(m[1]));
}

export function takenHorrorNames(players: { alias?: string; pendingHorrorAlias?: string }[]): string[] {
  const out: string[] = [];
  for (const p of players) {
    if (p.pendingHorrorAlias) out.push(p.pendingHorrorAlias);
    if (p.alias && isHorrorAlias(p.alias)) out.push(p.alias);
  }
  return out;
}
