import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Сторожит правило, из-за которого доска однажды оказалась пустой.
 *
 * BoardView фильтровал игроков по `isOnline !== false` перед отрисовкой
 * фишек. Сервер создаёт игрока с `isOnline: false` и снимает флаг только при
 * подключении сокета — поэтому только что зарегистрированный игрок был
 * невидим на доске, а вышедший из игры исчезал вместе с фишкой, хотя его
 * положение в партии никуда не девалось.
 *
 * Проверка текстовая, а не через рендер: тестовой среды для компонентов в
 * проекте пока нет, а поймать возврат конкретной строки этого достаточно.
 */
const BOARD = path.join(__dirname, "BoardView.tsx");
const TOKEN = path.join(__dirname, "PlayerToken.tsx");

describe("фишки на доске", () => {
  it("BoardView не отсеивает игроков по isOnline", () => {
    const src = fs.readFileSync(BOARD, "utf-8");

    // Ищем только исполняемый код: в комментариях слово упоминается намеренно.
    const offenders = src
      .split("\n")
      .map((line, i) => ({ line: line.trim(), no: i + 1 }))
      .filter(({ line }) => !line.startsWith("//") && !line.startsWith("*"))
      .filter(({ line }) => /p\.isOnline\s*!==\s*false/.test(line))
      // Строка 595 — вычисление для карточки игрока в боковой панели, там
      // статус показывается осознанно и фишек не касается.
      .filter(({ line }) => !line.includes("_isOnline"));

    expect(
      offenders.map((o) => `строка ${o.no}: ${o.line}`),
      "фильтр по isOnline снова скрывает фишки игроков"
    ).toEqual([]);
  });

  it("PlayerToken приглушает фишку вышедшего игрока, а не прячет её", () => {
    const src = fs.readFileSync(TOKEN, "utf-8");
    expect(src).toMatch(/isOnline/);
    // Прозрачность вместо отсутствия: игрок остаётся на доске.
    expect(src).toMatch(/opacity/);
  });

  it("у фишки есть запасной вариант, если файл не загрузился", () => {
    // Обработка ошибки переехала из PlayerToken в ChipImage вместе с
    // переходом с <img> на встроенный SVG.
    const chip = fs.readFileSync(path.join(__dirname, "ChipImage.tsx"), "utf-8");
    expect(chip).toMatch(/setFailed|catch/);
    expect(chip).toMatch(/failed/);
  });

  it("фишка окрашивается в цвет игрока, а не светится одинаково у всех", () => {
    // Свечение задано градиентом внутри SVG. Через <img> цвет туда не
    // попадает — картинка не наследует CSS страницы, поэтому все 13 фишек
    // светились зелёно-голубым независимо от выбора игрока.
    const token = fs.readFileSync(TOKEN, "utf-8");
    expect(token, "PlayerToken должен передавать цвет игрока в фишку").toMatch(
      /color=\{neonColor\}/
    );
    // Вырезаем комментарии целиком, включая блочные: в них <img> упоминается
    // намеренно, как объяснение, почему от него отказались.
    const codeOnly = token.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(codeOnly, "<img> не умеет красить свечение внутри SVG").not.toMatch(/<img\b/);

    const chip = fs.readFileSync(path.join(__dirname, "ChipImage.tsx"), "utf-8");
    expect(chip, "цвет должен подставляться в разметку").toMatch(/--chip-glow/);
  });

  it("все модели фишек принимают цвет извне", () => {
    const dir = path.resolve(__dirname, "..", "..", "public", "chips");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".svg"));

    expect(files.length, "ожидается 13 моделей фишек").toBe(13);

    for (const f of files) {
      const svg = fs.readFileSync(path.join(dir, f), "utf-8");
      expect(svg, `${f}: свечение зашито намертво`).toMatch(/var\(--chip-glow/);
    }
  });

  it("повреждённых PNG больше нет", () => {
    // Все 13 PNG в репозитории имели испорченную сигнатуру: байт 0x89
    // превратился в EF BF BD при обработке файла как текста, и браузер не
    // мог отрисовать ни одну фишку.
    const dir = path.resolve(__dirname, "..", "..", "public", "chips");
    const png = fs.readdirSync(dir).filter((f) => f.endsWith(".png"));
    expect(png, "фишки хранятся как SVG").toEqual([]);
  });
});
