#!/usr/bin/env python3
"""Локальная кластеризация поисковых фраз из CSV: TF-IDF + KMeans, без сети.

Запуск:
  python scripts/cluster_requests_local.py путь/к/файлу.csv --k 12
Вход: CSV с колонкой request (и желательно impressions). Выход: <файл>_clusters.csv
и сводка по кластерам в консоли.
Нужно один раз: pip install scikit-learn pandas
"""
import argparse
import sys

import pandas as pd
from sklearn.cluster import KMeans
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics import silhouette_score

ap = argparse.ArgumentParser()
ap.add_argument('csv')
ap.add_argument('--k', type=int, default=12, help='число кластеров')
ap.add_argument('--auto', action='store_true', help='подобрать k по silhouette (от 5 до 25)')
args = ap.parse_args()

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

df = pd.read_csv(args.csv, encoding='utf-8-sig')
texts = df['request'].astype(str).str.lower()

# слова и биграммы; sublinear_tf гасит повторы, min_df=2 отбрасывает одиночные слова-шум
vec = TfidfVectorizer(ngram_range=(1, 2), min_df=2, sublinear_tf=True)
X = vec.fit_transform(texts)
print(f'Фраз: {X.shape[0]}, признаков (слов/биграмм): {X.shape[1]}')


def fit(k):
    return KMeans(n_clusters=k, n_init=10, random_state=42).fit(X)


k = args.k
if args.auto:
    best = max(range(5, min(26, X.shape[0])), key=lambda n: silhouette_score(X, fit(n).labels_))
    k = best
    print(f'Подобранное k = {k}')

km = fit(k)
df['cluster'] = km.labels_

terms = vec.get_feature_names_out()
order = km.cluster_centers_.argsort()[:, ::-1]
metric = 'impressions' if 'impressions' in df.columns else None

print()
for c in range(k):
    part = df[df.cluster == c]
    top = ', '.join(terms[i] for i in order[c, :6])
    imp = f', показов {int(part[metric].sum())}' if metric else ''
    print(f'[{c}] {len(part)} фраз{imp} | {top}')
    sort_col = metric or 'request'
    for r in part.sort_values(sort_col, ascending=not metric).head(3)['request']:
        print(f'      {r}')

out = args.csv.rsplit('.', 1)[0] + '_clusters.csv'
df.sort_values(['cluster'] + ([metric] if metric else []), ascending=[True] + ([False] if metric else [])) \
  .to_csv(out, index=False, encoding='utf-8-sig')
print(f'\nСохранено: {out}')
