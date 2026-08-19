#!/usr/bin/env python3
"""
Инфографика «Аудит: было и стало» для HCG.

Понятная версия отчёта об аудите: без технических подробностей, только суть —
что проверили, что нашли, что исправили.

Текст наносится кодом, а не генератором картинок: нейросеть коверкает
кириллицу, а отчёт читают живые люди.

Вывод: ~/АУДИТ-ИНФОГРАФИКА.png и .pdf
Запуск:  python3 audit.py
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT_DIR = os.path.expanduser("~")
BG_PATH = os.path.join(OUT_DIR, "audit-bg.png")

W, H = 1080, 1920

MINT = (0, 255, 170)
PINK = (255, 107, 157)
PURPLE = (199, 125, 255)
GOLD = (245, 197, 66)
RED = (255, 90, 110)
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


def panel(base, box, border, radius=20, fill_alpha=175, glow=True):
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

# Сравнение «было → стало»: подпись, июль, август, цвет.
COMPARE = [
    ("Дыр в защите", "7", "0", MINT),
    ("Ломающих ошибок", "3", "0", MINT),
    ("Проверок кода", "15", "564", PURPLE),
]

# Что проверили сегодня.
CHECKED = [
    ("✔", "Чужие в игру не войдут", "Вход без ключа и с поддельным — отклонён"),
    ("✔", "Служебные двери заперты", "11 из 11 закрыты паролем"),
    ("✔", "Пароль не подобрать", "После 20 попыток вход блокируется"),
    ("✔", "Телефоны игроков скрыты", "В игре только псевдонимы героев"),
    ("✔", "Кубик честный", "Число выбирает сервер, подкрутить нельзя"),
    ("✔", "Данные не теряются", "Копии по расписанию, 4 обновления без потерь"),
]

# Что нашли и починили.
FOUND = [
    ("Две дыры в чужих библиотеках", "Нашли при проверке — закрыли в тот же день"),
    ("Экран не обновлялся сам", "Вы заметили раньше меня. Исправлено, добавлены проверки"),
]

LEFT = [
    "Пересобрать приложение (APK)",
    "Видео поля: там «+3», в игре «+4»",
    "Свой прокси-сервер",
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
    glow_text(img, (W // 2, 88), "HAPSTORE CYBER GAME", font("mono", 28), MINT, anchor="mm")
    glow_text(img, (W // 2, 152), "ПРОВЕРКА БЕЗОПАСНОСТИ", font("bold", 52), INK,
              glow=PINK, anchor="mm", strength=13)
    d.text((W // 2, 204), "было в июле  →  стало в августе", font=font("regular", 26),
           fill=DIM + (255,), anchor="mm")

    # --- Сравнение ---
    y = 244
    for label, before, after, colour in COMPARE:
        panel(img, (56, y, W - 56, y + 96), colour, radius=18)
        d.text((92, y + 48), label, font=font("regular", 25), fill=INK + (245,), anchor="lm")

        # Было — тускло и зачёркнуто смыслом, стало — ярко.
        glow_text(img, (W - 250, y + 48), before, font("bold", 40), DIM, anchor="mm", strength=5)
        d.text((W - 190, y + 48), "→", font=font("bold", 30), fill=DIM + (255,), anchor="mm")
        glow_text(img, (W - 120, y + 48), after, font("bold", 46), colour, anchor="mm", strength=11)
        y += 96 + 14

    # --- Что проверили ---
    y += 22
    glow_text(img, (W // 2, y + 12), "ЧТО ПРОВЕРИЛИ", font("bold", 36), MINT,
              anchor="mm", strength=11)
    y += 54

    title_f = font("bold", 26)
    body_f = font("regular", 22)

    for icon, title, note in CHECKED:
        lines = wrap(d, note, body_f, W - 220)
        box_h = 48 + len(lines) * 26
        panel(img, (56, y, W - 56, y + box_h), MINT, radius=16, fill_alpha=160, glow=False)
        d.text((92, y + box_h // 2), icon, font=font("bold", 26), fill=MINT + (255,), anchor="mm")
        d.text((132, y + 12), title, font=title_f, fill=INK + (255,))
        for n, ln in enumerate(lines):
            d.text((132, y + 44 + n * 26), ln, font=body_f, fill=DIM + (255,))
        y += box_h + 11

    # --- Что нашли ---
    y += 22
    glow_text(img, (W // 2, y + 12), "ЧТО НАШЛИ И ПОЧИНИЛИ", font("bold", 34), GOLD,
              anchor="mm", strength=11)
    y += 54

    for title, note in FOUND:
        lines = wrap(d, note, body_f, W - 200)
        box_h = 48 + len(lines) * 26
        panel(img, (56, y, W - 56, y + box_h), GOLD, radius=16, fill_alpha=160, glow=False)
        d.text((92, y + box_h // 2), "!", font=font("bold", 28), fill=GOLD + (255,), anchor="mm")
        d.text((124, y + 12), title, font=title_f, fill=GOLD + (255,))
        for n, ln in enumerate(lines):
            d.text((124, y + 44 + n * 26), ln, font=body_f, fill=DIM + (255,))
        y += box_h + 11

    # --- Что впереди ---
    y += 20
    glow_text(img, (W // 2, y + 10), "ЧТО ВПЕРЕДИ", font("bold", 30), PURPLE,
              anchor="mm", strength=10)
    y += 48

    small = font("regular", 22)
    for item in LEFT:
        box_h = 40
        panel(img, (56, y, W - 56, y + box_h), PURPLE, radius=13, fill_alpha=145, glow=False)
        d.text((92, y + box_h // 2), "•", font=font("bold", 24), fill=PURPLE + (255,), anchor="mm")
        d.text((120, y + box_h // 2), item, font=small, fill=DIM + (255,), anchor="lm")
        y += box_h + 9

    # --- Подвал ---
    footer_top = H - 142

    # Контроль переполнения: молча наехать на подвал нельзя.
    if y > footer_top - 12:
        sys.exit(
            f"ОШИБКА ВЁРСТКИ: содержимое кончается на {y}px, подвал на "
            f"{footer_top}px. Сократите текст."
        )

    panel(img, (56, footer_top, W - 56, H - 46), MINT, radius=20, fill_alpha=205)
    glow_text(img, (W // 2, footer_top + 38), "УЯЗВИМОСТЕЙ НЕТ", font("bold", 36), MINT,
              anchor="mm", strength=11)
    d.text((W // 2, footer_top + 80), "Проверено на живом сервере · 15 августа 2026",
           font=font("regular", 21), fill=DIM + (255,), anchor="mm")

    return img


def main() -> None:
    img = build()
    png = os.path.join(OUT_DIR, "АУДИТ-ИНФОГРАФИКА.png")
    pdf = os.path.join(OUT_DIR, "АУДИТ-ИНФОГРАФИКА.pdf")
    img.convert("RGB").save(png, "PNG", optimize=True)
    img.convert("RGB").save(pdf, "PDF", resolution=150.0)
    print(f"готово: {png}")
    print(f"готово: {pdf}")


if __name__ == "__main__":
    main()
