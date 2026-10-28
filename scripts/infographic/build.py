#!/usr/bin/env python3
"""
Инфографика «Как начать играть» для HCG — Hapstore Cyber Game.

Стиль взят с игрового поля: ночной неоновый город, мятный акцент #00FFAA,
розовое и фиолетовое свечение. Текст наносится кодом, а не генератором
картинок: нейросеть коверкает кириллицу, а инструкцию читают живые люди.

Вывод:
  ГАЙД-НОВИЧКУ.png  — вертикаль 1080x1920, для отправки в чат
  ГАЙД-НОВИЧКУ.pdf  — та же страница на печать

Запуск:  python3 build.py
"""
import os
import sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.expanduser("~")

W, H = 1080, 1920

# Палитра игры.
MINT = (0, 255, 170)
PINK = (255, 107, 157)
PURPLE = (199, 125, 255)
GOLD = (245, 197, 66)
INK = (236, 240, 245)
DIM = (168, 178, 196)
BG = (11, 9, 20)

BOT_NAME = "@hcg1_bot"

# --- Шрифты ------------------------------------------------------------------
# Список путей, а не один: молчаливый откат на шрифт без кириллицы уже
# однажды дал целый документ из квадратов ■■■■ при «успешной» генерации.
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
    # Выходим с ошибкой, а не подставляем шрифт без кириллицы.
    sys.exit(f"ОШИБКА: не найден шрифт «{kind}». Установите fonts-dejavu.")


def check_cyrillic() -> None:
    """Убедиться, что шрифт действительно рисует кириллицу, а не квадраты."""
    probe = font("bold", 40)
    if probe.getmask("Ж").getbbox() is None:
        sys.exit("ОШИБКА: шрифт не содержит кириллицы — текст вышел бы квадратами.")


# --- Рисование ----------------------------------------------------------------


def glow_text(base, xy, text, fnt, colour, glow=None, anchor="la", strength=9):
    """Текст с неоновым ореолом: свечение на отдельном слое, потом сам текст."""
    glow = glow or colour
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    ImageDraw.Draw(layer).text(xy, text, font=fnt, fill=glow + (170,), anchor=anchor)
    base.alpha_composite(layer.filter(ImageFilter.GaussianBlur(strength)))
    ImageDraw.Draw(base).text(xy, text, font=fnt, fill=colour + (255,), anchor=anchor)


def panel(base, box, border, radius=26, fill_alpha=170, glow=True):
    """Тёмная стеклянная плашка со светящейся рамкой."""
    x0, y0, x1, y1 = box
    if glow:
        layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
        ImageDraw.Draw(layer).rounded_rectangle(
            box, radius=radius, outline=border + (150,), width=5
        )
        base.alpha_composite(layer.filter(ImageFilter.GaussianBlur(10)))

    plate = Image.new("RGBA", base.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(plate)
    d.rounded_rectangle(box, radius=radius, fill=(8, 7, 16, fill_alpha))
    d.rounded_rectangle(box, radius=radius, outline=border + (220,), width=3)
    base.alpha_composite(plate)


def wrap(draw, text, fnt, max_width):
    """Перенос по словам — по реальной ширине, а не по числу символов."""
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


def step_number(base, cx, cy, num, colour, r=34):
    """Номер шага в светящемся круге."""
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    ImageDraw.Draw(layer).ellipse(
        (cx - r, cy - r, cx + r, cy + r), outline=colour + (200,), width=6
    )
    base.alpha_composite(layer.filter(ImageFilter.GaussianBlur(9)))

    d = ImageDraw.Draw(base)
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(8, 7, 16, 235), outline=colour + (255,), width=3)
    d.text((cx, cy + 1), str(num), font=font("bold", 36), fill=colour + (255,), anchor="mm")


# --- Содержание ---------------------------------------------------------------

STEPS = [
    (
        "НАЙДИТЕ БОТА",
        f"Откройте Telegram, найдите {BOT_NAME} и нажмите СТАРТ.",
        MINT,
    ),
    (
        "ЗАЯВКА НА ВХОД",
        "Нажмите «ЗАПРОСИТЬ РЕГИСТРАЦИЮ» — заявка уйдёт администратору.",
        MINT,
    ),
    (
        "ПОЛУЧИТЕ ДОСТУП",
        "Админ подтвердит заявку, бот пришлёт логин и пароль в чат.",
        PURPLE,
    ),
    (
        "ОТКРОЙТЕ ПОЛЕ",
        "Кнопка «ИГРАТЬ» открывает доску. Пароль вводить не нужно.",
        PURPLE,
    ),
    (
        "ЗАРАБОТАЙТЕ ХОД",
        "Покупка даёт бросок. Купили несколько — просите сразу несколько ходов.",
        PINK,
    ),
    (
        "БРОСЬТЕ КУБИК",
        "Админ одобрит ход — кубик загорится. Жмите, фишка пойдёт сама.",
        PINK,
    ),
    (
        "ЗАБЕРИТЕ ПРИЗ",
        "Попали на призовую клетку — покажите экран админу и заберите приз.",
        GOLD,
    ),
]

# Значки — только те, что DejaVu действительно рисует. Цветные эмодзи этот
# шрифт не содержит: первая версия дала на их месте пустые квадраты.
RULES = [
    ("∞", "Ход не сгорает", "Времени на бросок сколько угодно."),
    ("◆", "Призы не суммируются", "Новый приз заменяет старый. Забирайте сразу."),
    ("⚄", "Кубик честный", "Число выбирает сервер, подкрутить его нельзя."),
    ("⚑", "Финиш — клетка 64", "Полный круг — МЕГА-КРИСТАЛЛ."),
]


def build() -> Image.Image:
    check_cyrillic()

    bg_path = os.path.join(HERE, "bg.png")
    if not os.path.exists(bg_path):
        sys.exit(f"ОШИБКА: нет фона {bg_path}")

    # Фон: кадрируем под вертикаль и притемняем, чтобы текст читался.
    bg = Image.open(bg_path).convert("RGBA")
    scale = max(W / bg.width, H / bg.height)
    bg = bg.resize((int(bg.width * scale) + 1, int(bg.height * scale) + 1), Image.LANCZOS)
    left = (bg.width - W) // 2
    top = (bg.height - H) // 2
    img = bg.crop((left, top, left + W, top + H))

    img.alpha_composite(Image.new("RGBA", (W, H), BG + (140,)))

    d = ImageDraw.Draw(img)

    # --- Шапка ---
    glow_text(img, (W // 2, 96), "HAPSTORE CYBER GAME", font("mono", 34), MINT, anchor="mm")
    glow_text(img, (W // 2, 168), "КАК НАЧАТЬ ИГРУ", font("bold", 78), INK, glow=PINK, anchor="mm", strength=14)
    d.text(
        (W // 2, 232),
        "7 шагов от Telegram до первого приза",
        font=font("regular", 30),
        fill=DIM + (255,),
        anchor="mm",
    )

    # Разделитель.
    line = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(line).line([(150, 272), (W - 150, 272)], fill=MINT + (170,), width=3)
    img.alpha_composite(line.filter(ImageFilter.GaussianBlur(6)))
    d.line([(150, 272), (W - 150, 272)], fill=MINT + (200,), width=2)

    # --- Шаги ---
    y = 300
    title_f = font("bold", 34)
    body_f = font("regular", 25)

    for i, (title, body, colour) in enumerate(STEPS, start=1):
        text_left = 138
        text_width = W - text_left - 78
        lines = wrap(d, body, body_f, text_width)
        box_h = 66 + len(lines) * 33

        panel(img, (56, y, W - 56, y + box_h), colour)
        step_number(img, 56, y + box_h // 2, i, colour)

        d.text((text_left, y + 20), title, font=title_f, fill=colour + (255,))
        for n, ln in enumerate(lines):
            d.text((text_left, y + 64 + n * 33), ln, font=body_f, fill=INK + (240,))

        y += box_h + 15

    # --- Правила ---
    y += 8
    glow_text(img, (W // 2, y + 16), "ВАЖНО ЗНАТЬ", font("bold", 42), GOLD, anchor="mm", strength=12)
    y += 56

    rule_title = font("bold", 26)
    rule_body = font("regular", 23)
    for icon, name, text in RULES:
        lines = wrap(d, text, rule_body, W - 250)
        box_h = 50 + len(lines) * 30
        panel(img, (56, y, W - 56, y + box_h), PURPLE, radius=20, fill_alpha=150, glow=False)
        d.text((96, y + box_h // 2), icon, font=font("bold", 38), fill=MINT + (255,), anchor="mm")
        d.text((168, y + 14), name, font=rule_title, fill=GOLD + (255,))
        for n, ln in enumerate(lines):
            d.text((168, y + 46 + n * 30), ln, font=rule_body, fill=DIM + (255,))
        y += box_h + 12

    # --- Подвал ---
    footer_top = H - 150

    # Контроль переполнения.
    #
    # Первая версия молча наехала блоком «Финиш» на подвал: картинка
    # «сгенерировалась успешно», а читать её было нельзя. Лучше упасть с
    # понятной ошибкой, чем отдать пользователю кашу.
    if y > footer_top - 16:
        sys.exit(
            f"ОШИБКА ВЁРСТКИ: содержимое кончается на {y}px и налезает на "
            f"подвал ({footer_top}px). Сократите текст или уменьшите шрифт."
        )

    panel(img, (56, footer_top, W - 56, H - 52), MINT, radius=24, fill_alpha=200)
    glow_text(
        img,
        (W // 2, footer_top + 38),
        BOT_NAME,
        font("mono", 42),
        MINT,
        anchor="mm",
        strength=11,
    )
    d.text(
        (W // 2, footer_top + 82),
        "Открой бота и нажми СТАРТ — остальное подскажет игра",
        font=font("regular", 24),
        fill=DIM + (255,),
        anchor="mm",
    )

    return img


def main() -> None:
    img = build()

    png_path = os.path.join(OUT_DIR, "ГАЙД-НОВИЧКУ.png")
    img.convert("RGB").save(png_path, "PNG", optimize=True)

    pdf_path = os.path.join(OUT_DIR, "ГАЙД-НОВИЧКУ.pdf")
    img.convert("RGB").save(pdf_path, "PDF", resolution=150.0)

    print(f"готово: {png_path}")
    print(f"готово: {pdf_path}")


if __name__ == "__main__":
    main()
