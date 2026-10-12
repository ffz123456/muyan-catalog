# -*- coding: utf-8 -*-
"""
判定 PDF 中的中文是否真的被正确渲染。

方法：把提取到的文本与「原始应为的中文」比对。
  - 若命中原始文案 -> 中文正常
  - 若提取到大量非预期的 CJK 字符 -> 字体无 CJK 字形，中文已退化为乱码
  - 若完全没有中文 -> 中文被静默丢弃

结果写入 UTF-8 的 JSON，避免 Windows 控制台 GBK 编码干扰判断。
仅用标准库（zlib / re / json）。
"""
import re
import json
import zlib
import glob
import os
import sys

CJK = re.compile(r'[\u4e00-\u9fff]')

# 原始数据中确实存在的中文串，用于判定渲染是否成功
EXPECT = [
    "林氏家居", "云舒三人布艺沙发", "白蜡木实木茶几", "黑胡桃玻璃展示柜",
    "橡木伸缩餐桌", "榉木落地衣帽架", "产品目录", "含税", "现货",
]

# 中文正常时，这些常用字必然出现；乱码时几乎必然不出现
COMMON = "的一是不了在人有我他这中大来上国个到说们为子和你地出道也时年得就那要下以生会自着去之过家学对可里后小么心多天而能好都然没日于起还发成事只作当想看文无开手十用主行方又如前所本见经头面公同三已老从动两长知民样现分将外但身些与高意进把法此实回二理美点月明其种声全工作"


def streams(raw):
    for m in re.finditer(rb'stream\r?\n', raw):
        start = m.end()
        end = raw.find(b'endstream', start)
        if end == -1:
            continue
        data = raw[start:end]
        if data.endswith(b'\r\n'):
            data = data[:-2]
        elif data.endswith(b'\n'):
            data = data[:-1]
        try:
            yield zlib.decompress(data)
        except Exception:
            yield data


def decode_pdf_string(s_bytes):
    if s_bytes.startswith(b'<'):
        hx = re.sub(rb'[^0-9A-Fa-f]', b'', s_bytes[1:-1])
        if len(hx) % 2:
            hx = hx[:-1]
        try:
            b = bytes.fromhex(hx.decode())
        except Exception:
            return ''
        for enc in ('utf-16-be', 'latin-1'):
            try:
                return b.decode(enc)
            except Exception:
                pass
        return ''
    body = s_bytes[1:-1]
    body = body.replace(b'\\(', b'(').replace(b'\\)', b')').replace(b'\\\\', b'\\')
    try:
        return body.decode('utf-16-be') if b'\x00' in body else body.decode('latin-1')
    except Exception:
        return ''


def extract(path):
    raw = open(path, 'rb').read()
    out = []
    for st in streams(raw):
        for m in re.finditer(rb'\((?:[^()\\]|\\.)*\)|<[0-9A-Fa-f\s]+>', st):
            t = decode_pdf_string(m.group(0))
            if t.strip():
                out.append(t)
    return ''.join(out)


def judge(txt):
    hits = [e for e in EXPECT if e in txt]
    cjk = CJK.findall(txt)
    common_hits = [c for c in COMMON if c in txt]
    if hits:
        verdict = "中文正常渲染"
    elif len(cjk) >= 10 and len(common_hits) <= 2:
        verdict = "中文退化为乱码（字体无 CJK 字形）"
    elif not cjk:
        verdict = "中文被静默丢弃"
    else:
        verdict = "疑似部分可用，需人工复核"
    return {
        "verdict": verdict,
        "extractedChars": len(txt),
        "cjkCount": len(cjk),
        "expectedHits": hits,
        "commonCharHits": len(common_hits),
        "cjkSample": ''.join(cjk[:30]),
    }


def main(pattern, out_json):
    report = []
    for f in sorted(glob.glob(pattern)):
        txt = extract(f)
        r = judge(txt)
        r["file"] = os.path.basename(f)
        r["sizeKB"] = os.path.getsize(f) // 1024
        report.append(r)

    with open(out_json, 'w', encoding='utf-8') as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2)

    lines = []
    for r in report:
        lines.append(f"{r['file']}  ({r['sizeKB']} KB)")
        lines.append(f"  判定        : {r['verdict']}")
        lines.append(f"  提取字符数  : {r['extractedChars']}   中文字符数: {r['cjkCount']}")
        lines.append(f"  命中原始文案: {r['expectedHits'] if r['expectedHits'] else '（无）'}")
        lines.append(f"  常用汉字命中: {r['commonCharHits']} 个")
        lines.append(f"  中文样本    : {r['cjkSample'] if r['cjkSample'] else '（无）'}")
        lines.append("")
    # 以 UTF-8 写入文件；控制台另用 ascii 安全方式打印摘要
    with open(out_json.replace('.json', '.txt'), 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(lines))
    print(f"报告已写入: {out_json}")
    for r in report:
        print(f"  {r['file']}: {r['verdict']}  (中文 {r['cjkCount']} 字, 命中原始文案 {len(r['expectedHits'])} 条)")


if __name__ == '__main__':
    pat = sys.argv[1] if len(sys.argv) > 1 else 'furniture-sales-tool/catalog/out/*.pdf'
    out = sys.argv[2] if len(sys.argv) > 2 else 'furniture-sales-tool/catalog/out/pdf-text-report.json'
    main(pat, out)
