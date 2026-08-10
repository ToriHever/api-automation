# 🔤 Lemmatizer

Лемматизация русских слов справочника запросов `common.requests`: приводит
слова к нормальной форме (лемме) и группирует запросы, которые отличаются
только словоформой (падеж, число, склонение), в одну группу.

Пример: `защита сервера от атак` / `защита серверов от атак` /
`защиты серверов от атак` — три разных запроса в справочнике, но одинаковый
набор лемм (`атака защита сервер`) → попадают в одну группу с общим названием
(самый короткий из трёх вариантов).

## 🎯 Из чего состоит

1. **Python-сервис** (`app.py`) — HTTP-обёртка над `pymorphy3`, отдаёт лемму
   по слову. Работает отдельно от основного Node.js-проекта, т.к. библиотек
   лемматизации русского языка уровня pymorphy в экосистеме Node нет.
2. **Node-скрипт** (`scripts/lemmatize-requests.js`) — читает
   `common.requests`, токенизирует текст запроса на слова, зовёт Python-сервис
   только для новых (ещё не встречавшихся) слов, пишет результат в БД и
   группирует запросы по совпадению набора лемм.

## 📁 Структура сервиса

```
services/lemmatizer/
├── app.py              # Flask-сервис лемматизации (pymorphy3)
├── requirements.txt    # Python-зависимости
├── schema.sql           # SQL-схема (справочники слов/лемм/групп)
└── README.md            # Этот файл
```

Сам скрипт запуска — `scripts/lemmatize-requests.js` (в корне проекта, как и
остальные скрипты).

## 🔑 Настройка

Python и зависимости ставятся отдельно от `npm install`:

```bash
python3 -m venv services/lemmatizer/venv
source services/lemmatizer/venv/bin/activate
pip install -r services/lemmatizer/requirements.txt
```

В `.env`:
```bash
LEMMATIZER_API_URL=http://localhost:5001   # адрес Python-сервиса
```

## 🚀 Запуск

Сервис лемматизации должен быть поднят перед запуском Node-скрипта:

```bash
# 1. Поднять Python-сервис (оставить работать в фоне/отдельном терминале)
source services/lemmatizer/venv/bin/activate
python services/lemmatizer/app.py
# или в фоне:
nohup services/lemmatizer/venv/bin/python services/lemmatizer/app.py > logs/lemmatizer.log 2>&1 &

# 2. Прогнать лемматизацию/группировку
npm run lemmatize
```

Скрипт идемпотентен — безопасно перезапускать сколько угодно раз. Обрабатывает
только:
- слова, которых ещё нет в `common.request_words` (не дёргает Python-сервис
  повторно для уже известных слов);
- запросы, у которых ещё нет ни одной связи в `common.requests_words`;
- запросы, у которых `group_id IS NULL`.

Поэтому регулярный перезапуск (например, после каждого импорта нового
семантического ядра) подхватит только новые запросы, не трогая уже
обработанные.

## 🗄️ Структура БД

### `common.request_words`
Справочник уникальных слов и их лемм.
```
word_id  serial  PK
word     text    UNIQUE — слово как встретилось в запросе (нижний регистр)
lemma    text    нормальная форма слова
```

### `common.requests_words`
Связь запрос → слова, из которых он состоит (многие-ко-многим).
```
request_id  integer  FK → common.requests.request_id
word_id     integer  FK → common.request_words.word_id
PRIMARY KEY (request_id, word_id)
```

### `common.request_groups`
Группы запросов с одинаковым набором лемм.
```
group_id          serial  PK
lemma_signature   text    UNIQUE — отсортированный уникальный набор лемм запроса через пробел
canonical_request text    самый короткий запрос группы — название группы
```

### `common.requests.group_id`
Колонка в основном справочнике запросов — ссылка на `common.request_groups`.

### Вью `common.v_requests_lemmatized`
Запрос + его леммы одной строкой через пробел (для поиска/DataLens).

### Вью `common.v_request_groups`
Группа + полный список входящих в неё словоформ (`variants`,
`variants_count`) — удобно смотреть в DataLens, какие запросы объединились.

## 🔍 Полезные SQL-запросы

### Сколько запросов уже разобрано и сгруппировано
```sql
SELECT COUNT(*) AS total, COUNT(group_id) AS grouped
FROM common.requests;
```

### Группы с несколькими словоформами (самое полезное)
```sql
SELECT * FROM common.v_request_groups
WHERE variants_count > 1
ORDER BY variants_count DESC
LIMIT 20;
```

### Лемма конкретного слова
```sql
SELECT word, lemma FROM common.request_words WHERE word = 'защищённый';
```

### Все запросы одной группы
```sql
SELECT r.request
FROM common.requests r
WHERE r.group_id = (SELECT group_id FROM common.request_groups WHERE canonical_request = 'защита сервера от атак');
```

## 🐛 Troubleshooting

### `bash: python: command not found`
На сервере обычно только `python3`. Используйте `python3 services/lemmatizer/app.py`
или ставьте пакет: `sudo apt install -y python3 python3-pip python3-venv`.

### `ModuleNotFoundError: No module named 'flask'`
Зависимости не установлены — `pip install -r services/lemmatizer/requirements.txt`
(или через venv, если ловите `externally-managed-environment`, см. «Настройка» выше).

### После `npm run lemmatize` `COUNT(group_id) = 0`, хотя слова разобраны
Это был баг в первой версии скрипта: `INSERT` новых групп и `UPDATE`,
находящий их через `JOIN` на реальную таблицу, были в одном SQL-запросе —
в Postgres только что вставленные внутри `WITH`-запроса строки не видны
другим частям того же запроса при обращении к базовой таблице напрямую.
Исправлено (разбито на два последовательных запроса) в коммите
`fix(lemmatizer): исправить группировку запросов по леммам`. Если у вас
такое всё ещё происходит — проверьте, что подтянут актуальный
`scripts/lemmatize-requests.js`.

### Часть запросов не разбирается ни на слова, ни на группы
Ожидаемо для пустых запросов или запросов без букв (только цифры/спецсимволы,
например часть кода/числовых артефактов) — токенизатор ищет
последовательности из 2+ букв (`[a-zA-Zа-яёА-ЯЁ]{2,}`), таким запросам
действительно нечего лемматизировать.

## 📚 Зависимости

- [pymorphy3](https://github.com/no-plagiarism/pymorphy3) — морфологический
  анализатор русского языка (форк pymorphy2, совместимый с новыми версиями Python)
- [Flask](https://flask.palletsprojects.com/) — минимальный HTTP-сервер для обёртки
