#!/usr/bin/env python3
"""
Инфографика «Итоги двух недель» для HCG.

Второй вариант отчёта — короткий, без технических подробностей: что сделано,
что это даёт игроку и хозяину магазина, что осталось.

Текст наносится кодом, а не генератором картинок: нейросеть коверкает
кириллицу, а отчёт читают живые люди.

Вывод: ~/ОТЧЁТ-2-НЕДЕЛИ.png и .pdf

Запуск:  python3 report.py
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.expanduser("~")
BG_PATH = os.path.join(OUT_DIR, "report-bg.png")

W, H = 1080, 1920

# Палитра игры.
MINT = (0, 255, 170)
PINK = (255, 107, 157)
PURPLE = (199, 125, 255)
GOLD = (245, 197, 66)
INK = (236, 240, 245)
DIM = (168, 178, 196)
BG = (11, 9, 20)

FONT_CANDIDATES = {
    "bold": [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
    ],
    "regular": [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/dejavu/DejaVuSans.ttf",
    ],
    "mono": [
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
        "/usr/share/fonts/dejavu/DejaVuSansMono-Bold.ttf",
    ],
}


def font(kind: str, size: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES[kind]:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    # Выходим с ошибкой, а не подставляем шрифт без кириллицы: молчаливый
    # откат уже однажды дал документ из квадратов при «успешной» генерации.
    sys.exit(f"ОШИБКА: не найден шрифт «{kind}». Установите fonts-dejavu.")


def check_cyrillic() -> None:
    if font("bold", 40).getmask("Ж").getbbox() is None:
        sys.exit("ОШИБКА: шрифт без кириллицы — текст вышел бы квадратами.")


def glow_text(base, xy, text, fnt, colour, glow=None, anchor="la", strength=9):
    glow = glow or colour
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    ImageDraw.Draw(layer).text(xy, text, font=fnt, fill=glow + (170,), anchor=anchor)
    base.alpha_composite(layer.filter(ImageFilter.GaussianBlur(strength)))
    ImageDraw.Draw(base).text(xy, text, font=fnt, fill=colour + (255,), anchor=anchor)


def panel(base, box, border, radius=22, fill_alpha=175, glow=True):
    if glow:
        layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
        ImageDraw.Draw(layer).rounded_rectangle(box, radius=radius, outline=border + (140,), width=5)
        base.alpha_composite(layer.filter(ImageFilter.GaussianBlur(10)))

    plate = Image.new("RGBA", base.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(plate)
    d.rounded_rectangle(box, radius=radius, fill=(8, 7, 16, fill_alpha))
    d.rounded_rectangle(box, radius=radius, outline=border + (215,), width=3)
    base.alpha_composite(plate)


def wrap(draw, text, fnt, max_width):
    words, lines, line = text.split(), [], ""
    for word in words:
        probe = f"{line} {word}".strip()
        if draw.textlength(probe, font=fnt) <= max_width:
            line = probe
        else:
            if line:
                lines.append(line)
            line = word
    if line:
        lines.append(line)
    return lines


# --- Содержание ---------------------------------------------------------------

# Крупные числа сверху.
NUMBERS = [
    ("39", "правок", MINT),
    ("560", "проверок", PURPLE),
    ("17", "выпусков", PINK),
]

# Что сделано: заголовок + чем это полезно.
DONE = [
    ("⚠", "Игра больше не падает", "Кубик перестал ронять игру у всех игроков", PINK),
    ("∞", "Ход не сгорает", "Купил вечером — сыграешь когда удобно", MINT),
    ("◆", "Несколько ходов сразу", "Три покупки — три броска, без ожидания", MINT),
    ("☺", "Игроки скрыты друг от друга", "В игре видно псевдоним, не ваш Telegram", PURPLE),
    ("✉", "Отчёт после каждого хода", "Кто бросил, что выпало, какой приз", PURPLE),
    ("✔", "Приз не выдать дважды", "Кнопка гаснет, когда решение принято", GOLD),
    ("▣", "Список игроков файлом", "Одна кнопка — таблица для Excel", GOLD),
]

# Что осталось — честно.
LEFT = [
    "Пересобрать приложение (APK)",
    "Перерисовать видео поля: там «+3», в игре «+4»",
    "Свой прокси-сервер вместо бесплатных",
]


def build() -> Image.Image:
    check_cyrillic()

    if not os.path.exists(BG_PATH):
        sys.exit(f"ОШИБКА: нет фона {BG_PATH}")

    bg = Image.open(BG_PATH).convert("RGBA")
    scale = max(W / bg.width, H / bg.height)
    bg = bg.resize((int(bg.width * scale) + 1, int(bg.height * scale) + 1), Image.LANCZOS)
    left = (bg.width - W) // 2
    top = (bg.height - H) // 2
    img = bg.crop((left, top, left + W, top + H))
    img.alpha_composite(Image.new("RGBA", (W, H), BG + (150,)))

    d = ImageDraw.Draw(img)

    # --- Шапка ---
    glow_text(img, (W // 2, 92), "HAPSTORE CYBER GAME", font("mono", 30), MINT, anchor="mm")
    glow_text(img, (W // 2, 158), "ИТОГИ ДВУХ НЕДЕЛЬ", font("bold", 66), INK, glow=PINK,
              anchor="mm", strength=14)
    d.text((W // 2, 212), "2 — 15 августа 2026", font=font("regular", 28),
           fill=DIM + (255,), anchor="mm")

    # --- Три числа ---
    y = 258
    box_w = (W - 112 - 2 * 16) // 3
    for i, (value, label, colour) in enumerate(NUMBERS):
        x0 = 56 + i * (box_w + 16)
        panel(img, (x0, y, x0 + box_w, y + 132), colour, radius=18)
        glow_text(img, (x0 + box_w // 2, y + 52), value, font("bold", 54), colour,
                  anchor="mm", strength=11)
        d.text((x0 + box_w // 2, y + 100), label, font=font("regular", 22),
               fill=DIM + (255,), anchor="mm")

    y += 132 + 34

    # --- Что сделано ---
    glow_text(img, (W // 2, y + 14), "ЧТО СДЕЛАНО", font("bold", 40), MINT,
              anchor="mm", strength=12)
    y += 56

    title_f = font("bold", 30)
    body_f = font("regular", 23)

    for icon, title, note, colour in DONE:
        lines = wrap(d, note, body_f, W - 232)
        box_h = 54 + len(lines) * 28
        panel(img, (56, y, W - 56, y + box_h), colour, radius=18, fill_alpha=165, glow=False)

        d.text((96, y + box_h // 2), icon, font=font("bold", 32),
               fill=colour + (255,), anchor="mm")
        d.text((146, y + 13), title, font=title_f, fill=colour + (255,))
        for n, ln in enumerate(lines):
            d.text((146, y + 50 + n * 28), ln, font=body_f, fill=INK + (235,))

        y += box_h + 13

    # --- Что осталось ---
    y += 10
    glow_text(img, (W // 2, y + 12), "ЧТО ВПЕРЕДИ", font("bold", 36), GOLD,
              anchor="mm", strength=11)
    y += 50

    left_f = font("regular", 23)
    for item in LEFT:
        lines = wrap(d, item, left_f, W - 200)
        box_h = 22 + len(lines) * 28
        panel(img, (56, y, W - 56, y + box_h), PURPLE, radius=14, fill_alpha=150, glow=False)
        d.text((92, y + box_h // 2), "•", font=font("bold", 26), fill=GOLD + (255,), anchor="mm")
        for n, ln in enumerate(lines):
            d.text((124, y + 11 + n * 28), ln, font=left_f, fill=DIM + (255,))
        y += box_h + 11

    # --- Подвал ---
    footer_top = H - 150

    # Контроль переполнения: молча наехать на подвал нельзя — картинку
    # «успешно сгенерировали», а читать её невозможно.
    if y > footer_top - 14:
        sys.exit(
            f"ОШИБКА ВЁРСТКИ: содержимое кончается на {y}px и налезает на "
            f"подвал ({footer_top}px). Сократите текст."
        )

    panel(img, (56, footer_top, W - 56, H - 44), MINT, radius=22, fill_alpha=200)
    glow_text(img, (W // 2, footer_top + 40), "ВСЁ РАБОТАЕТ", font("bold", 38), MINT,
              anchor="mm", strength=11)
    d.text((W // 2, footer_top + 84), "Сборка 2026-08-15.3 · 560 проверок пройдено",
           font=font("regular", 22), fill=DIM + (255,), anchor="mm")

    return img


def main() -> None:
    img = build()
    png = os.path.join(OUT_DIR, "ОТЧЁТ-2-НЕДЕЛИ.png")
    pdf = os.path.join(OUT_DIR, "ОТЧЁТ-2-НЕДЕЛИ.pdf")
    img.convert("RGB").save(png, "PNG", optimize=True)
    img.convert("RGB").save(pdf, "PDF", resolution=150.0)
    print(f"готово: {png}")
    print(f"готово: {pdf}")


if __name__ == "__main__":
    main()
