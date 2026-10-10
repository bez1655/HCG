/**
 * Public aliases hide the Telegram handle from other players.
 * Pool: horror-film characters (display names only).
 */
export const ALIAS_POOL: readonly string[] = [
  // Halloween / slasher
  "Майкл Майерс",
  "Лори Строуд",
  "Фредди Крюгер",
  "Нэнси Томпсон",
  "Джейсон Вурхиз",
  "Элис Харди",
  "Памела Вурхиз",
  "Призрачное Лицо",
  "Сидни Прескотт",
  "Гейл Уэзерс",
  "Дьюи Райли",
  "Билли Лумис",
  "Стуи",
  "Кожаное Лицо",
  "Салли Хардести",
  "Хитклифф",
  "Чаки",
  "Тиффани Валентайн",
  "Джигсо",
  "Аманда Янг",
  "Доктор Гордон",
  "Пинхед",
  "Кендимен",
  "Бугимен",
  "Лепрекон",
  "Крипер",
  "Пришелец",
  // It / King
  "Пеннивайз",
  "Беверли Марш",
  "Билл Денбро",
  "Ричи Тозиер",
  "Джек Торранс",
  "Венди Торранс",
  "Дэнни Торранс",
  "Дик Хэллоранн",
  "Кэрри Уайт",
  "Маргарет Уайт",
  "Энни Уилкс",
  "Пол Шелдон",
  "Гейдж Крид",
  "Льюис Крид",
  // Classics
  "Норман Бейтс",
  "Мэрион Крэйн",
  "Реджинальд",
  "Граф Дракула",
  "Ван Хельсинг",
  "Мина Харкер",
  "Джонатан Харкер",
  "Франкенштейн",
  "Невеста",
  "Игорь",
  "Человек-невидимка",
  "Мумия",
  "Волк-человек",
  "Носферату",
  "Кармилла",
  "Ребекка",
  // Exorcist / occult
  "Риган Макнил",
  "Отец Каррас",
  "Отец Меррин",
  "Крис Макнил",
  "Пазузу",
  "Эмили Роуз",
  "Лоррейн Уоррен",
  "Эд Уоррен",
  "Аннабель",
  "Бабадук",
  "Тони Тодд",
  "Сэмюэл",
  // Silence / thrillers
  "Ганнибал Лектер",
  "Кларисса Старлинг",
  "Буффало Билл",
  "Уилл Грэм",
  "Катерина",
  // Alien / creature
  "Эллен Рипли",
  "Ньют",
  "Даллас",
  "Эш Андроид",
  "Ксеноморф",
  "Хищник",
  "Датч",
  "Мак",
  "Куинт",
  "Шериф Броди",
  "Хопер",
  "Существо",
  // J-horror / others
  "Садако",
  "Кайеко",
  "Тодзи",
  "Мэй",
  "Годзилла",
  // Evil Dead / cabin
  "Эш Уильямс",
  "Линда",
  "Скотти",
  "Брюс Кэмпбелл",
  "Дана",
  "Холден",
  "Жюль",
  "Марти",
  // Modern
  "Крис Вашингтон",
  "Роуз Армитаж",
  "Энни Грэм",
  "Питер Грэм",
  "Дани",
  "Пелле",
  "Томас",
  "Грейс",
  "Отис",
  "Макс",
  "Джуди",
  "Реджи",
  "Эллисон",
  "Нидфул",
  "Грендел",
  "Валькирия",
  "Моргана",
  "Геката",
  "Лилит",
  "Морриган",
  "Банши",
  "Полтергейст",
  "Карвер",
  "Лори",
  "Стейси",
  "Винни",
  "Рэнди Микс",
  "Тейт",
  "Вайолет",
  "Мэдисон",
  "Нелли",
  "Редфилд",
  "Джилл Валентайн",
  "Леон Кеннеди",
  "Ада Вонг",
  "Немезис",
  "Вескер",
  "Клэр Редфилд",
  "Зомби",
  "Выживший",
  "Ночной Дозор",
  "Хранитель Склепа",
  "Хозяин Болот",
  "Тень Леса",
  "Голос В Колодце",
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

const HORROR_ROOTS = new Set(ALIAS_POOL.map((a) => a.toLowerCase()));

/** True when the public alias already belongs to the horror pool (or "Name 2"). */
export function isHorrorAlias(alias: string | undefined | null): boolean {
  if (!alias || !alias.trim()) return false;
  const t = alias.trim().toLowerCase();
  if (HORROR_ROOTS.has(t)) return true;
  const m = t.match(/^(.*) (\d+)$/);
  return Boolean(m && HORROR_ROOTS.has(m[1]));
}

export function takenHorrorNames(players: { alias?: string; pendingHorrorAlias?: string }[]): string[] {
  const out: string[] = [];
  for (const p of players) {
    if (p.pendingHorrorAlias) out.push(p.pendingHorrorAlias);
    if (p.alias && isHorrorAlias(p.alias)) out.push(p.alias);
  }
  return out;
}
