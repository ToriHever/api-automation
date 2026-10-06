#!/usr/bin/env python3
"""Автономная лемматизация фраз из CSV (pymorphy3), без БД, сервера и сети.

Запуск:
  python scripts/lemmatize_file.py файл.csv            # колонка request
  python scripts/lemmatize_file.py файл.csv --col query
Выход: <файл>_lemmas.csv — исходные колонки + lemmas (фраза в начальных формах)
и lemma_key (те же леммы, отсортированные, без повторов — по ней находят дубли
вроде «цена защиты ddos» / «защита ddos цены»).
Нужно один раз: pip install pymorphy3 pymorphy3-dicts-ru pandas
"""
import argparse
import re
import sys

import pandas as pd
import pymorphy3

ap = argparse.ArgumentParser()
ap.add_argument('csv')
ap.add_argument('--col', default='request')
args = ap.parse_args()

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

morph = pymorphy3.MorphAnalyzer()
cache = {}
TOKEN = re.compile(r'[а-яёa-z0-9]+(?:-[а-яёa-z0-9]+)*', re.I)


def lemma(word):
    if word not in cache:
        # латиница и цифры (ddos, 404, vds) pymorphy не трогает — оставляем как есть
        cache[word] = morph.parse(word)[0].normal_form if re.search('[а-яё]', word) else word
    return cache[word]


def lemmatize(phrase):
    return [lemma(t) for t in TOKEN.findall(str(phrase).lower().replace('ё', 'е'))]


df = pd.read_csv(args.csv, encoding='utf-8-sig')
lems = df[args.col].map(lemmatize)
df['lemmas'] = lems.map(' '.join)
df['lemma_key'] = lems.map(lambda ws: ' '.join(sorted(set(ws))))

out = args.csv.rsplit('.', 1)[0] + '_lemmas.csv'
df.to_csv(out, index=False, encoding='utf-8-sig')
print(f'Фраз: {len(df)}, уникальных по лемма-ключу: {df.lemma_key.nunique()}')
print(f'Сохранено: {out}')
