#!/usr/bin/env python3
"""
Правка числовых подписей на картинке игрового поля.

Клетка 7 «КВАНТОВЫЙ ТЕЛЕПОРТ» стала давать +4 вместо +3 (иначе она ставила
фишку ровно на призовую клетку 10, а приз за это не начисляется — приз даёт
клетка, на которую привёл кубик). Клетка 52 «ЭМИ-ЛОВУШКА» по той же причине
стала -4 вместо -3: она отбрасывала на призовую 49.

На фоне доски эти числа НАРИСОВАНЫ. Не поправить их — игрок увидит «+3» и
получит +4, то есть решит, что игра врёт.

Перерисовать картинку нейросетью нельзя: она не воспроизведёт ни шрифт, ни
город. Поэтому правится только сам глиф цифры: пиксели вокруг остаются
нетронутыми, а новая цифра берёт цвет и размер у соседних символов.

Запуск:  python3 scripts/patch-board-labels.py
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BOARD = os.path.join(ROOT, "public", "BoardHAP.png")

FONT_PATHS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
]

# Прямоугольники с цифрой, найденные по картинке (левый, верх, правый, низ).
# Захватывают ТОЛЬКО знак и цифру, без соседних букв.
# Подписи на фоне доски — РИСУНОК, и он местами расходится с данными игры
# и без моего участия: там «КАРАНТИННАЯ ЗОНА» вместо «ЭМИ-ЛОВУШКА»,
# «КРИПТО-ДЖЕКЛОТ +200Р» вместо «КРИПТО-ДЖЕКПОТ 2000 CR» и клетки, которых
# в cells.json нет вовсе. Настоящее название игра показывает в подсказке при
# нажатии на клетку (CellComponent).
#
# Поэтому правится ровно одно место — «+3» у телепорта: только его число
# игрок может сверить с тем, на сколько реально прыгнула фишка. У клетки 52
# числа на фоне попросту нет, править нечего.
PATCHES = [
    {
        "name": "клетка 7 — КВАНТОВЫЙ ТЕЛЕПОРТ",
        "box": (679, 1166, 698, 1182),
        "text": "+4",
        "size": 14,
    },
]


def font(size):
    for path in FONT_PATHS:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    sys.exit("ОШИБКА: не найден шрифт DejaVuSans-Bold.")


def sample_ink(img, box):
    """Цвет надписи = самый светлый пиксель в рамке (текст светлее фона)."""
    crop = img.crop(box).convert("RGB")
    best, score = (220, 235, 220), -1
    for px in crop.getdata():
        s = sum(px)
        if s > score:
            score, best = s, px
    return best


def patch_number(img, box, text, size):
    """
    Заменить подпись, не задев ни соседние буквы, ни иконку.

    Четыре неудачные попытки до этого, все — из-за неверных границ и донора:
      1. фон брался ПОД надписью, где доска светлее: вышел светлый квадрат;
      2. правилась только цифра: от старого «+» остался хвост и шов;
      3. донор сверху/снизу задевал светлые пиксели самих букв;
      4. область была шире надписи: срезало низ буквы «Т» в «ТЕЛЕПОРТ», а
         шрифт оказался крупнее оригинала.

    Границы глифа сняты попиксельно (светлее порога): x 681..695,
    y 1168..1179. Рамка чуть шире глифа, но не достаёт ни до букв сверху,
    ни до иконки телепорта справа (она начинается со столбца 707).
    """
    x0, y0, x1, y1 = box
    ink = sample_ink(img, box)
    px = img.load()

    def edge(xs, y):
        """Спокойный цвет фона: нижняя четверть по яркости, без бликов."""
        sample = [px[x, y] for x in xs]
        sample.sort(key=sum)
        return sample[len(sample) // 4]

    span = x1 - x0
    for y in range(y0, y1):
        left = edge(range(x0 - 12, x0 - 2), y)
        right = edge(range(x1 + 2, x1 + 8), y)
        for i, x in enumerate(range(x0, x1)):
            t = i / max(1, span - 1)
            px[x, y] = tuple(round(left[c] + (right[c] - left[c]) * t) for c in range(3))

    d = ImageDraw.Draw(img)
    f = font(size)
    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    # Тонкий тёмный контур, как у остальных подписей на доске.
    for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
        d.text((cx + dx, cy + dy), text, font=f, fill=(9, 11, 13), anchor="mm")
    d.text((cx, cy), text, font=f, fill=ink, anchor="mm")


def main():
    if not os.path.exists(BOARD):
        sys.exit(f"ОШИБКА: нет файла {BOARD}")

    original = Image.open(BOARD)
    was_palette = original.mode == "P"
    img = original.convert("RGB")

    # Клетка 7 — координаты выверены по увеличенному фрагменту.
    patch_number(img, PATCHES[0]["box"], PATCHES[0]["text"], PATCHES[0]["size"])
    print(f"поправлено: {PATCHES[0]['name']} -> {PATCHES[0]['text']}")

    """
    Сохранить в том же виде, в каком файл был.

    Доска лежала палитровым PNG (режим «P») — 522 КБ. Сохранение в RGB
    раздуло её до 1,5 МБ: втрое больше трафика на каждом открытии игры с
    телефона. Возвращаем палитру.
    """
    out = img
    if was_palette:
        out = img.quantize(colors=256, method=Image.MEDIANCUT, dither=Image.FLOYDSTEINBERG)

    out.save(BOARD, "PNG", optimize=True)
    size_kb = os.path.getsize(BOARD) // 1024
    print(f"записано: {BOARD} ({size_kb} КБ)")



if __name__ == "__main__":
    main()
