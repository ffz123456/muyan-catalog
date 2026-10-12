# -*- coding: utf-8 -*-
"""
生成画册验证用的产品示意图。

真实场景下这些是厂家提供或销售拍摄的产品照片；此处用 Pillow 按各产品
的真实长宽比绘制示意图，用于验证「中文渲染 + 图片嵌入」链路。
"""
import os
from PIL import Image, ImageDraw, ImageFont

# 本文件位于 <项目>/catalog/tools/，故上溯 2 级到 catalog/
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.abspath(os.path.join(HERE, "..", "assets"))
os.makedirs(OUT, exist_ok=True)

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\simsun.ttc",
]


def load_font(size):
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()


# (文件名, 画布宽, 画布高, 底色, 木色, 中文标签)
ITEMS = [
    ("sofa.png", 1200, 560, (243, 238, 230), (92, 62, 44), "布艺沙发"),
    ("coffee-table.png", 900, 560, (240, 236, 226), (120, 78, 52), "实木茶几"),
    ("curio-cabinet.png", 920, 560, (245, 242, 235), (96, 56, 34), "玻璃展示柜"),
    ("dining-set.png", 1200, 600, (242, 238, 229), (74, 52, 38), "实木餐桌椅"),
    ("coat-rack.png", 600, 560, (246, 243, 236), (108, 70, 46), "落地衣帽架"),
]


def rounded(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def draw_item(draw, kind, w, h, wood):
    dark = tuple(max(0, c - 28) for c in wood)
    light = tuple(min(255, c + 34) for c in wood)

    if kind == "布艺沙发":
        rounded(draw, (int(w * 0.10), int(h * 0.24), int(w * 0.90), int(h * 0.55)), 18, wood)
        rounded(draw, (int(w * 0.07), int(h * 0.48), int(w * 0.93), int(h * 0.74)), 16, light)
        rounded(draw, (int(w * 0.07), int(h * 0.40), int(w * 0.20), int(h * 0.74)), 14, dark)
        rounded(draw, (int(w * 0.80), int(h * 0.40), int(w * 0.93), int(h * 0.74)), 14, dark)
        for x in (0.13, 0.85):
            draw.rectangle((int(w * x), int(h * 0.74), int(w * x) + 14, int(h * 0.84)), fill=dark)

    elif kind == "实木茶几":
        rounded(draw, (int(w * 0.12), int(h * 0.34), int(w * 0.88), int(h * 0.46)), 8, wood)
        rounded(draw, (int(w * 0.20), int(h * 0.62), int(w * 0.80), int(h * 0.71)), 6, light)
        for x in (0.18, 0.78):
            draw.rectangle((int(w * x), int(h * 0.46), int(w * x) + 16, int(h * 0.76)), fill=dark)

    elif kind == "玻璃展示柜":
        draw.rectangle((int(w * 0.22), int(h * 0.14), int(w * 0.78), int(h * 0.82)), fill=light)
        draw.rectangle((int(w * 0.22), int(h * 0.14), int(w * 0.78), int(h * 0.82)), outline=wood, width=10)
        for y in (0.36, 0.58):
            draw.rectangle((int(w * 0.22), int(h * y), int(w * 0.78), int(h * y) + 8), fill=dark)
        draw.rectangle((int(w * 0.22), int(h * 0.80), int(w * 0.78), int(h * 0.90)), fill=wood)

    elif kind == "实木餐桌椅":
        rounded(draw, (int(w * 0.10), int(h * 0.34), int(w * 0.90), int(h * 0.45)), 8, wood)
        for x in (0.16, 0.80):
            draw.rectangle((int(w * x), int(h * 0.45), int(w * x) + 18, int(h * 0.82)), fill=dark)
        for cx in (0.28, 0.66):
            x0 = int(w * cx)
            rounded(draw, (x0, int(h * 0.52), x0 + int(w * 0.09), int(h * 0.60)), 6, light)
            draw.rectangle((x0 + int(w * 0.02), int(h * 0.30), x0 + int(w * 0.07), int(h * 0.52)), fill=light)

    elif kind == "落地衣帽架":
        cx = int(w * 0.5)
        draw.rectangle((cx - 9, int(h * 0.22), cx + 9, int(h * 0.80)), fill=wood)
        for dy, dx in ((-1, -1), (-1, 1), (1, -1), (1, 1)):
            draw.line(
                (cx, int(h * 0.26) + dy * 8, cx + dx * int(w * 0.20), int(h * 0.22) + dy * 22),
                fill=wood, width=13,
            )
        rounded(draw, (cx - int(w * 0.18), int(h * 0.78), cx + int(w * 0.18), int(h * 0.86)), 10, dark)


def main():
    for name, w, h, bg, wood, label in ITEMS:
        img = Image.new("RGB", (w, h), bg)
        d = ImageDraw.Draw(img)

        for gx in range(0, w, 60):
            d.line((gx, 0, gx, h), fill=(233, 227, 217), width=1)
        for gy in range(0, h, 60):
            d.line((0, gy, w, gy), fill=(233, 227, 217), width=1)

        draw_item(d, label, w, h, wood)

        f = load_font(max(22, w // 26))
        d.text((26, 22), label, font=f, fill=(60, 50, 44))
        f2 = load_font(max(16, w // 46))
        d.text((w - 150, h - 44), "示意图", font=f2, fill=(150, 140, 130))

        path = os.path.join(OUT, name)
        img.save(path, "PNG", optimize=True)
        print(f"OK  {name:20s} {w}x{h}  ({os.path.getsize(path)//1024} KB)")


if __name__ == "__main__":
    main()
    print(f"\n输出目录: {OUT}")
