/**
 * ============================================================================
 * УПОМИНАНИЯ ИГРОКОВ В ЧАТЕ — pure functions
 * ============================================================================
 *
 * Администратор пишет в игровой чат «Бэтмен, зайдите за призом» — и тот, кого
 * назвали, получает это же сообщение в Telegram. Игрок заходит в игру не
 * постоянно, а бот всегда под рукой.
 *
 * Ищем по псевдониму: настоящий хендл другим игрокам не показывается, и в
 * чате админ видит именно псевдоним.
 */

/** Минимум, который нужен для поиска. */
export interface Mentionable {
  id: string;
  alias?: string;
  name?: string;
}

/**
 * Экранирование для вставки в регулярное выражение.
 *
 * Псевдонимы приходят из списка героев, но администратор мог переименовать
 * игрока во что угодно — скобка в имени иначе уронила бы разбор.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Кого администратор назвал в сообщении.
 *
 * @param text     Текст сообщения.
 * @param players  Все игроки партии.
 *
 * Совпадение ищется по границе слова, поэтому «Тор» не сработает внутри
 * слова «Торт». Регистр не важен: админ печатает быстро.
 *
 * Возвращает каждого игрока не более одного раза, даже если его назвали
 * дважды — иначе он получил бы два одинаковых сообщения.
 */
export function findMentions<T extends Mentionable>(text: string, players: T[]): T[] {
  if (!text || players.length === 0) return [];

  const found: T[] = [];
  const seen = new Set<string>();

  for (const player of players) {
    const names = [player.alias, player.name].filter(
      (n): n is string => typeof n === "string" && n.trim().length >= 2
    );

    for (const name of names) {
      /*
       * \b перед кириллицей в JS не работает как ожидается: движок считает
       * границей слова стык латиницы и не-латиницы. Поэтому проверяем
       * соседние символы сами — совпадение засчитывается, только если
       * вокруг не буква и не цифра.
       */
      const pattern = new RegExp(escapeRegExp(name.trim()), "giu");
      let match: RegExpExecArray | null;
      let hit = false;

      while ((match = pattern.exec(text)) !== null) {
        const before = text[match.index - 1];
        const after = text[match.index + match[0].length];
        const isWordChar = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

        if (!isWordChar(before) && !isWordChar(after)) {
          hit = true;
          break;
        }
      }

      if (hit && !seen.has(player.id)) {
        seen.add(player.id);
        found.push(player);
        break;
      }
    }
  }

  return found;
}
