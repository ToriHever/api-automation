"""
services/lemmatizer/app.py
Микросервис лемматизации русских (и переключаемо украинских/английских) слов
для справочника запросов common.requests. Вызывается из
scripts/lemmatize-requests.js по HTTP.

Запуск: python app.py  (порт из LEMMATIZER_PORT, по умолчанию 5001)
Зависимости: см. requirements.txt
"""

import os
from flask import Flask, request, jsonify
import pymorphy3

app = Flask(__name__)
morph = pymorphy3.MorphAnalyzer()


def lemmatize_word(word: str) -> str:
    parsed = morph.parse(word)
    if not parsed:
        return word
    return parsed[0].normal_form


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


@app.route("/lemmatize", methods=["POST"])
def lemmatize():
    body = request.get_json(force=True, silent=True) or {}
    words = body.get("words")
    if not isinstance(words, list):
        return jsonify({"error": "expected JSON body {\"words\": [\"word1\", \"word2\", ...]}"}), 400

    result = {}
    for word in words:
        if not isinstance(word, str) or not word:
            continue
        result[word] = lemmatize_word(word.lower())

    return jsonify({"lemmas": result})


if __name__ == "__main__":
    port = int(os.environ.get("LEMMATIZER_PORT", 5001))
    app.run(host="0.0.0.0", port=port)
