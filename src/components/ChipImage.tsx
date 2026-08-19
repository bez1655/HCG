import React from "react";

/**
 * Фишка игрока, раскрашенная в его цвет.
 *
 * Почему не <img src="...">, как было раньше:
 *
 * Свечение внутри фишки задано градиентом `neonGlow` в самом SVG. Картинка,
 * вставленная через <img>, — отдельный документ: CSS страницы внутрь не
 * попадает, поэтому все 13 фишек светились одинаковым зелёно-голубым, каким
 * их нарисовал генератор, независимо от цвета, выбранного игроком при входе.
 *
 * Здесь SVG загружается и вставляется в разметку страницы. Тогда он наследует
 * CSS-переменные от родителя, а стопы градиента объявлены как
 * `var(--chip-glow, …)` — достаточно задать переменную, и свечение принимает
 * нужный цвет.
 *
 * Заодно это чинит вторую проблему: PNG-версии фишек в репозитории оказались
 * повреждены (сигнатура файла была испорчена при обработке как текст), и
 * браузер не мог их отрисовать вовсе. SVG нужного размера весят в 12 раз
 * меньше и не зависят от плотности экрана.
 */

/** Кэш загруженной разметки: один и тот же файл нужен многим фишкам сразу. */
const cache = new Map<string, string>();
/** Запросы «в полёте», чтобы 8 игроков на одной фишке не дали 8 запросов. */
const inFlight = new Map<string, Promise<string>>();

async function loadChip(src: string): Promise<string> {
  const cached = cache.get(src);
  if (cached) return cached;

  const pending = inFlight.get(src);
  if (pending) return pending;

  const request = fetch(src)
    .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
    .then((text) => {
      // Минимальная проверка: сервер, отдавший HTML вместо картинки (типовая
      // реакция на несуществующий путь), не должен попасть в разметку.
      if (!text.trimStart().startsWith("<svg")) {
        throw new Error("not an SVG");
      }
      cache.set(src, text);
      inFlight.delete(src);
      return text;
    })
    .catch((err) => {
      inFlight.delete(src);
      throw err;
    });

  inFlight.set(src, request);
  return request;
}

/** Затемнённый оттенок для второго стопа градиента — придаёт объём. */
function darken(hex: string, amount = 0.45): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const v = parseInt(m[1], 16);
  const r = Math.round(((v >> 16) & 255) * (1 - amount));
  const g = Math.round(((v >> 8) & 255) * (1 - amount));
  const b = Math.round((v & 255) * (1 - amount));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

interface ChipImageProps {
  /** Путь к файлу фишки, например /chips/chip_3.svg */
  src: string;
  /** Цвет игрока — им светится фишка. */
  color: string;
  /** Подпись для читалок экрана. */
  label?: string;
  className?: string;
  style?: React.CSSProperties;
}

const ChipImage = React.memo(({ src, color, label, className, style }: ChipImageProps) => {
  const [markup, setMarkup] = React.useState<string | null>(() => cache.get(src) ?? null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let alive = true;

    const ready = cache.get(src);
    if (ready) {
      setMarkup(ready);
      setFailed(false);
      return;
    }

    setMarkup(null);
    setFailed(false);

    loadChip(src)
      .then((text) => {
        if (alive) setMarkup(text);
      })
      .catch(() => {
        // Фишка — не критичный ресурс: рисуем запасной кружок в цвете игрока,
        // чтобы позиция на доске всё равно читалась.
        if (alive) setFailed(true);
      });

    return () => {
      alive = false;
    };
  }, [src]);

  // Цвет подставляется прямо в разметку, а не через CSS-переменную.
  //
  // Наследование var() внутрь SVG работает в браузерах, но молча ломается в
  // движках с частичной поддержкой SVG — проверка показала ровно это: фишка
  // осталась серой. Строковая замена даёт тот же результат и не зависит от
  // движка. Переменные тоже выставляем — как запасной путь, если разметку
  // почему-то не удалось подменить.
  const painted = React.useMemo(() => {
    if (!markup) return null;
    return markup
      .replace(/var\(--chip-glow,\s*#[0-9a-f]{3,8}\)/gi, color)
      .replace(/var\(--chip-glow-2,\s*#[0-9a-f]{3,8}\)/gi, darken(color));
  }, [markup, color]);

  const glow = {
    ["--chip-glow" as string]: color,
    ["--chip-glow-2" as string]: darken(color),
    ...style,
  } as React.CSSProperties;

  if (failed) {
    return (
      <div
        className={className}
        style={glow}
        role="img"
        aria-label={label}
        title={label}
      >
        <svg viewBox="0 0 512 512" width="100%" height="100%">
          <circle cx="256" cy="256" r="200" fill="#0d1117" stroke={color} strokeWidth="24" />
          <circle cx="256" cy="256" r="110" fill={color} opacity="0.85" />
        </svg>
      </div>
    );
  }

  if (!painted) {
    // Пока грузится — прозрачное место того же размера, чтобы доска не прыгала.
    return <div className={className} style={glow} aria-hidden="true" />;
  }

  return (
    <div
      className={className}
      style={glow}
      role="img"
      aria-label={label}
      title={label}
      // Разметка берётся из собственных файлов проекта в public/chips,
      // пользовательский ввод сюда не попадает.
      dangerouslySetInnerHTML={{ __html: painted }}
    />
  );
});

ChipImage.displayName = "ChipImage";

export default ChipImage;
