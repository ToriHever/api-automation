-- services/common/data/2026-08_categorize_requests.sql
-- Автокатегоризация common.requests.cluster_id / topic_id по ключевым словам —
-- перенос логики из Excel-макроса КатегоризацияПоКлючевымСловам (VBA) в БД.
--
-- Отличия от исходного VBA-макроса (обсуждено и согласовано):
--   1. \m...\M / \m...\w* (границы слова) вместо InStr (голый substring) —
--      меньше ложных срабатываний на коротких словах.
--   2. Порядок проверки — specific -> generic (тиры 0..4), а не порядок вставки
--      в код. В VBA общие категории 'Что'/'Как' стояли РАНЬШЕ специфичных
--      ('Защита', 'Вредоносные...', 'Виды' и т.д.) и перехватывали запросы —
--      теперь общие категории проверяются последними.
--   3. Исправлены баги VBA с задвоенными индексами массивов, из-за которых
--      терялись слова 'дедос', 'дудоса', 'провайдеров' (второе присваивание
--      тому же индексу массива затирало первое) — здесь оба варианта учтены.
--   4. Списки словоформ ('сервер'/'сервера'/'серверу'/'серверов' и т.п.) свёрнуты
--      в \mслово\w*\M там, где это безопасно (не задевает другие категории).
--   5. В VBA genericWords(1 To 7) — индекс 4 никогда не был присвоен (пустая строка).
--      InStr(text, "") в VBA всегда возвращает "найдено", то есть hasGenericWord
--      был ВСЕГДА true, и категория "другой вид атаки" в оригинале не должна была
--      достижимой — а в реальных данных этот topic_name присутствует. Здесь дырка
--      закрыта нормальным списком (что/это/как/какой/кто такой/кто такие), иначе
--      "другой вид атаки" не назначался бы вообще никогда.
--   6. [правка после первого прогона] В VBA/первой версии этого файла упоминание
--      ddos имело АБСОЛЮТНЫЙ приоритет для topic_id — запрос вида "ddos атака как
--      защититься" получал topic "ddos атака", хотя явно выражено намерение
--      защититься. Теперь порядок для topic_id: сначала конкретная цель по
--      словарю (сервер/сайт/mitm/sql/...), затем общее намерение "защита" (корень
--      "защит"), и только если ничего из этого не нашлось — "ddos атака". Заодно
--      сброшен topic_id у уже неверно категоризированных строк с прошлого прогона
--      (см. шаг сброса в начале части 2).
--   7. [расширение словаря интентов] Добавлены 4 новые темы, отсутствовавшие
--      в исходном VBA-словаре: 'положить сайт/сервер' (уронить/завалить/вырубить +
--      сайт/сервер), 'выполнить атаку' (сделать/устроить/провести + атака, без
--      намерения защититься), 'принцип работы' (принцип/механизм/как работает),
--      'написание/произношение' (как пишется/читается/расшифровывается). Первые
--      два — составные глагол+объект паттерны, проверяются ДО словаря конкретных
--      целей (иначе 'положить сервер' перехватился бы обычным 'сервер'). Последние
--      два — после словаря целей, но до общего 'защита'/'ddos атака' (если назван
--      конкретный сервер/сайт/vds — приоритет у него).
--   8. [коррекция после реального прогона] Строки, уже попавшие в 'ddos атака' на
--      прошлых прогонах (нижний приоритет цепочки), не пересчитывались новыми более
--      приоритетными правилами из-за WHERE topic_id IS NULL — "как провести ddos
--      атаку", "как ддосить сайт" и т.п. так и оставались в 'ddos атака'. Теперь
--      topic_id='ddos атака' БЕЗУСЛОВНО сбрасывается в начале части 2 при каждом
--      прогоне и пересчитывается заново — сама эта категория ничего не теряет
--      (шаг 7 просто проставит её обратно, если ничего конкретнее не подошло).
--      Заодно добавлены: разговорные ddos-глаголы (ддосить/дудосить/заддосить/
--      задудосить и т.п. — раньше 'за-'-приставка ломала границу слова у корня
--      'ддос'/'дудос') и синонимы намерения защититься (бороться/избавиться/
--      предотвратить/остановить/устранить/отразить/противостоять/избежать —
--      раньше учитывался только корень 'защит').
--   9. [ещё одна коррекция] 'принцип работы'/'написание-произношение' были завязаны
--      на тот же триггер (защит/атака), что и словарь целей — а у вопросов вроде
--      "как расшифровывается ddos" этих слов нет вообще, триггер не срабатывал.
--      Убран для этих тем. Также: 'расшифровывается' (что означает аббревиатура)
--      вынесена в отдельную тему 'расшифровка', отдельно от 'читается'/'пишется'
--      ('написание/произношение') — это разные вопросы. И 'выполнить атаку'
--      расширена: глагол действия + любое ddos-упоминание (не только слово
--      "атака" — "как сделать ddos" его не содержит), плюс добавлены формы
--      'делать/делают/делает' (раньше был только 'сделать', другой корень).
--   10. [cluster_id: Вредоносные (Покупка/Заказ)] "заказать защиту от ddos" ошибочно
--      попадал в этот кластер по слову "заказать", хотя topic_id уже верно определял
--      это как "защита" (легитимная покупка услуги, а не заказ атаки). Добавлено
--      исключение на корень "защит" + сброс уже неверно проставленного cluster_id
--      с прошлых прогонов (такие строки провалятся дальше по цепочке и корректно
--      попадут в tier2-кластер "Защита").
--   11. [новое: ЧАСТЬ 3, hub_id] Автоприсвоение хаба для строк без hub_id (у
--      большинства он уже пришёл из исходного файла — их не трогаем): ddos-
--      упоминание + уточнение продукта (сайт/сеть/хостинг/vds/сервер) -> хаб
--      этого продукта; ddos-упоминание без уточнения -> хаб "DDoS".
--   12. [cluster_id: Вредоносные (Цели: IP/Телефон/Сеть)] Новое составное условие:
--      ddos-упоминание (в т.ч. с "атака") + предлог "на" + конкретная цель
--      (vpn/втб) -> тот же кластер. Список целей (сейчас только vpn/втб) легко
--      расширить — просто добавить слово в alternation через "|". Хаб остаётся
--      "DDoS" по умолчанию (часть 3), т.к. vpn/втб не входят в список продуктов.
--   13. [разбор реальных примеров] Список правок:
--      - hub_id: правило L3/L4 было слишком узким ('l3 l7' без L4 уходило в
--        Сайт вместо Сети) — заменено на любое упоминание L3 в любом виде.
--      - cluster 'Вредоносные (Цели: ...)': список целей расширен
--        (инфраструктура/компания/компьютер/ркн/ростелеком/человек).
--      - cluster 'Новости': добавлены год (2020-2049) и месяцы, только вместе
--        с ddos-упоминанием (сами по себе слишком общие).
--      - cluster 'Правовые/Юридические': добавлено 'ответственность'.
--      - cluster 'Как работает': добавлено 'реализуют/реализовать'.
--      - cluster 'Отличие': стем расширен до 'отлича\w*' — 'отличается' не
--        покрывал 'отличаются' (разные окончания, не префикс друг друга).
--      - cluster 'Справка / Терминология': добавлено 'является'.
--      - cluster 'Цели': у него вообще не было правила (баг переноса из VBA,
--        ключевое слово 'цели' потерялось) — добавлено, стем 'цел\w*' ловит
--        и 'цель' в ед. числе, чего не было даже в оригинальном VBA.
--      - cluster 'Признаки' — новый, отсутствовал в исходном списке из 39
--        кластеров, добавлен в справочник вручную (см. INSERT в начале части 1).
--   14. [hub_id, коррекция] Строки с упоминанием L3/L7 могли уже получить hub_id
--      из исходного файла (например, общий 'DDoS'), не совпадающий с правилом
--      L3/L4/L7 — добавлен точечный сброс перед приоритетом 0 в части 3.
--   15. [cluster_id: 'Цены'] У этого кластера, как и у 'Цели', вообще не было
--      правила (баг переноса). Любой коммерческий интент (цена/стоимость/
--      сколько стоит/тарифы/купить/заказать) -> 'Цены', независимо от того,
--      выглядит запрос вредоносно или нет — проверяется раньше 'Вредоносные
--      (Покупка/Заказ)', которое теперь фактически недостижимо для этих слов
--      (оставлено в файле как есть, на случай если понадобится другая логика).
--   16. [topic_id: 'ddos атака' убран] Это не интент, а просто подтверждение
--      темы, которая и так ясна из hub_id/cluster_id — превращалось в
--      бесполезно широкую категорию, куда падало почти всё подряд. Шаг
--      присвоения убран, строки без более специфичного интента остаются
--      topic_id = NULL. В DataLens NULL уже превращается в "Не определено"
--      через IFNULL([topic_name], 'Не определено') — в БД ничего не выдумываем.
--      Шаг 0 (сброс) сбросит все ранее проставленные 'ddos атака' при прогоне.
--   17. [cluster_id: ddos + коммерческое слово, без защиты -> Вредоносные]
--      'Цены' (пункт 15) забирала ЛЮБОЕ коммерческое слово безусловно — но
--      "заказать ddos атаку" это заказ атаки, а не покупка защиты. Теперь:
--      ddos-упоминание + коммерческое слово (купить/заказать/сколько стоит/
--      цена/тариф/услуги/сервис) + НЕТ корня "защит" -> 'Вредоносные (Покупка/
--      Заказ)', проверяется РАНЬШЕ 'Цены'. Если ddos не упомянут или есть
--      "защит" — по-прежнему уходит в 'Цены'. Запросы с ddos, но БЕЗ
--      коммерческого слова (например "ddos для серверов") сюда не попадают —
--      проваливаются дальше по цепочке, в т.ч. в уже существующее
--      'Заказ атаки?' (ddos + инфраструктурное слово, без защиты, ничего
--      конкретнее не подошло).
--   18. [cluster_id: правило п.17 расширено на 'Готовое решение'] "ddos сервис
--      ez"/"ddos сервис ez москва" уходили в 'Готовое решение' по слову
--      'сервис' — без слова о защите это тоже, скорее всего, запрос про
--      инструмент/сервис ДЛЯ атаки. В условие п.17 добавлен весь словарь
--      'Готовое решение' (решение/система/средство/центр/платформа/
--      инструмент/автоматизация), плюс сброс уже неверно попавших туда строк.
--

-- Идемпотентно: каждый UPDATE — WHERE cluster_id IS NULL (или topic_id IS NULL),
-- уже проставленные категории никогда не перезаписываются. Безопасно запускать
-- после каждого импорта в common.requests, чтобы категоризировать новые строки.

BEGIN;

-- ============================================================
-- ЧАСТЬ 1: cluster_id (столбец 'Кластер' в исходном файле)
-- ============================================================

-- Новый кластер 'Признаки' (симптомы/признаки ddos-атаки) — отсутствовал в
-- исходном списке из 39 кластеров. cluster_id проставляем вручную, как и в
-- миграции импорта — у таблицы нет sequence/DEFAULT на этой колонке.
WITH cluster_base AS (
    SELECT COALESCE(MAX(cluster_id), 0) AS base_id FROM common.clusters
),
new_cluster_names AS (
    SELECT v.name FROM (VALUES ('Признаки')) AS v(name)
    WHERE NOT EXISTS (SELECT 1 FROM common.clusters c WHERE c.cluster_name = v.name)
)
INSERT INTO common.clusters (cluster_id, cluster_name)
SELECT (SELECT base_id FROM cluster_base) + ROW_NUMBER() OVER (), name
FROM new_cluster_names;

-- Тир 0 — исключения
UPDATE common.requests SET cluster_id = (SELECT cluster_id FROM common.clusters WHERE cluster_name = 'Не целевые')
WHERE cluster_id IS NULL AND request ~* '(\mmikrotik\M|\mмикротик\M|\mreg ru\M)';

-- Тир 1 — именованные сущности / узкие технические категории
UPDATE common.requests SET cluster_id = (SELECT cluster_id FROM common.clusters WHERE cluster_name = 'Cloudflare')
WHERE cluster_id IS NULL AND request ~* '(\mcloudflare\M|\mcf\M)';

UPDATE common.requests SET cluster_id = (SELECT cluster_id FROM common.clusters WHERE cluster_name = 'Гейминг')
WHERE cluster_id IS NULL AND request ~* '(\mмайнкрафт\M|\mminecraft\M|\mвинди\M)';

UPDATE common.requests SET cluster_id = (SELECT cluster_id FROM common.clusters WHERE cluster_name = 'Правовые/Юридические')
WHERE cluster_id IS NULL AND request ~* '(\mстатья\M|\mсправедливость\M|\mзакон\M|\mответственност\w*)';

UPDATE common.requests SET cluster_id = (SELECT cluster_id FROM common.clusters WHERE cluster_name = 'Справка / Терминология')
WHERE cluster_id IS NULL AND request ~* '(\mрасшифровка\M|\mотказ в обслуживании\M|\mперевод\M|\mопределение\M|\mтермин\M|\mкто такой\M|\mкто такие\M|\mdistributed denial\M|\mкартинка\M|\mфото\M|\mявля\w*)';

UPDATE common.requests SET cluster_id = (SELECT cluster_id FROM common.clusters WHERE cluster_name = 'Радар')
WHERE cluster_id IS NULL AND request ~* '\mкарта\M';

UPDATE common.requests SET cluster_id = (SELECT cluster_id FROM common.clusters WHERE cluster_name = 'Сегментация')
WHERE cluster_id IS NULL AND request ~* '\mсегментация\M';

UPDATE common.requests SET cluster_id = (SELECT cluster_id FROM common.clusters WHERE cluster_name = 'Руководство')
WHERE cluster_id IS NULL AND request ~* '\mруководство\M';

UPDATE common.requests SET cluster_id = (SELECT cluster_id FROM common.clusters WHERE cluster_name = 'Отключить')
WHERE cluster_id IS NULL AND request ~* '\mотключить\M';

UPDATE common.requests SET cluster_id = (SELECT cluster_id FROM common.clusters WHERE cluster_name = 'Векторы атак')
WHERE cluster_id IS NULL AND request ~* '(\mфлуд\w*|\mamplification\w*|\micmp\w*|\mping\w*|\mfail2ban\w*|\mslowloris\w*|\mмассированная\w*)';

UPDATE common.requests SET cluster_id = (SELECT cluster_id FROM common.clusters WHERE cluster_name = 'Вредоносные (Софт/Скрипты)')
WHERE cluster_id IS NULL AND request ~* '(\mпрограмм\w*|\mскачать\w*|\mpython\w*|\mпитон\w*|\mскрипт\w*|\mтермукс\w*|\mtermux\w*|\mбот\w*|\mприложение\w*|\mapk\w*|\mcmd\w*|\mtools\w*|\mclient\w*|\mпанель\w*|\mprogram\w*|\mтроян\w*|\mонлайн\w*|\monline\w*)';

-- Коррекция под новое правило ниже: сбрасываем то, что уже могло уйти в
-- 'Цены'/'Вредоносные (Покупка/Заказ)'/'Готовое решение' с прошлых прогонов,
-- чтобы пересчиталось по актуальному приоритету.
UPDATE common.requests SET cluster_id = NULL
WHERE cluster_id IN (
    (SELECT cluster_id FROM common.clusters WHERE cluster_name = 'Вредоносные (Покупка/Заказ)'),
    (SELECT cluster_id FROM common.clusters WHERE cluster_name = 'Цены'),
    (SELECT cluster_id FROM common.clusters WHERE cluster_name = 'Готовое решение')
);

-- Новое (высший приоритет среди коммерческих правил): ddos-упоминание (в т.ч. с
-- 'атака') + коммерческое/сервисное слово (купить/заказать/сколько стоит/цена/
-- тариф/услуги/сервис — плюс весь словарь 'Готовое решение': решение/система/
-- средство/центр/платформа/инструмент/автоматизация, т.к. "готовое решение для
-- ddos" без слова о защите — тоже, скорее всего, запрос про инструмент атаки,
-- а не защиты) + НЕТ намерения защититься (корень 'защит') -> 'Вредоносные
-- (Покупка/Заказ)'. Перехватывает и 'Цены', и 'Готовое решение' именно в этом
-- узком случае. Если ddos нет ИЛИ есть 'защит' — уходит в 'Цены'/'Готовое
-- решение' ниже как обычно.
UPDATE common.requests SET cluster_id = (SELECT cluster_id FROM common.clusters WHERE cluster_name = 'Вредоносные (Покупка/Заказ)')
WHERE cluster_id IS NULL
  AND request ~* '(\mddos\w*|\mдудос\w*|\mддос\w*|\mdos\w*|\mдосс\w*|\mдоос\w*|\mдос\w*|\md o s\w*|\mдедос\w*|\mдидос\w*|\mдодос\w*|\mдудокс\w*|\mdoss\w*|\mдудоса\w*|\mд дос\w*|\mддс\w*|\mмдос\w*|\mдтос\w*|\mdds\w*|\mdudos\w*|\mдэдос\w*|\mdoc\w*|\mdo dos\w*|\mдосить\w*|\mддосить\w*|\mдоус\w*|\mотказ в обслуживании\w*)'
  AND request ~* '(\mцена\M|\mцены\M|\mценам\M|\mценой\M|\mценах\M|\mцене\M|\mстоимост\w*|\mсколько стоит\w*|\mтариф\w*|\mкупить\w*|\mзаказ\w*|\mуслуг\w*|\mсервис\w*|\mрешение\w*|\mсистема\w*|\mсредство\w*|\mцентр\w*|\mплатформа\w*|\mсредства\w*|\mинструмент\w*|\mавтоматизация\w*)'
  AND request !~* '\mзащит\w*';

-- 'Цены' — у этого кластера, как и у 'Цели', вообще не было правила (баг
-- переноса из VBA). Любой коммерческий интент -> 'Цены', НЕЗАВИСИМО от того,
-- выглядит запрос вредоносно или нет — КРОМЕ узкого случая выше (ddos без
-- намерения защититься), который уже перехвачен.
UPDATE common.requests SET cluster_id = (SELECT cluster_id FROM common.clusters WHERE cluster_name = 'Цены')
WHERE cluster_id IS NULL AND request ~* '(\mцена\M|\mцены\M|\mценам\M|\mценой\M|\mценах\M|\mцене\M|\mстоимост\w*|\mсколько стоит\w*|\mтариф\w*|\mкупить\w*|\mзаказ\w*|\mуслуг\w*|\mсервис\w*)';

-- Старое правило 'Вредоносные (Покупка/Заказ)' (купить/заказ/сколько стоит без
-- ddos-упоминания) — теперь фактически недостижимо: 'Цены' выше уже забирает
-- все эти слова. Оставлено для истории, ничего не удаляем без необходимости.
UPDATE common.requests SET cluster_id = NULL
WHERE cluster_id = (SELECT cluster_id FROM common.clusters WHERE cluster_name = 'Вредоносные (Покупка/Заказ)')
  AND request ~* '\mзащит\w*';

UPDATE common.requests SET cluster_id = (SELECT cluster_id FROM common.clusters WHERE cluster_name = 'Вредоносные (Покупка/Заказ)')
WHERE cluster_id IS NULL AND request ~* '(\mкупить\w*|\mсколько стоит\w*|\mзаказ\w*|\mзаказать\w*)' AND request !~* '\mзащит\w*';

UPDATE common.requests SET cluster_id = (SELECT cluster_id FROM common.clusters WHERE cluster_name = 'Вредоносные (Действие/Намерение)')
WHERE cluster_id IS NULL AND request ~* '(\mзадудосить\w*|\mдудосить\w*|\mсделать\w*|\mдосить\w*|\mдосят\w*|\mддосят\w*|\mдудосят\w*|\mзадудосили\w*|\mддосер\w*|\mдудосер\w*|\mddoser\w*)';

UPDATE common.requests SET cluster_id = (SELECT cluster_id FROM common.clusters WHERE cluster_name = 'Вредоносные (Цели: IP/Телефон/Сеть)')
WHERE cluster_id IS NULL AND request ~* '(\mпо айпи\w*|\mпо номеру\w*|\mна номер\w*|\mна телефон\w*|\mмобильный\w*|\mна интернет\w*|\mна провайдеров\w*|\mна домен\w*|\mна яндекс\w*|\mна россию\w*|\mномера\w*|\mwifi\w*|\mайпи\w*|\mdns\w*)';

-- Новое: ddos-упоминание (в т.ч. с явным словом 'атака' — 'ddos атака на vpn')
-- + предлог 'на' + конкретная цель (vpn/втб и т.п.) -> тот же кластер
-- 'Вредоносные (Цели: IP/Телефон/Сеть)'. Хаб остаётся 'DDoS' по умолчанию
-- (часть 3) — vpn/втб не входят в список продуктов (сайт/сеть/хостинг/vds/сервер).
UPDATE common.requests SET cluster_id = (SELECT cluster_id FROM common.clusters WHERE cluster_name = 'Вредоносные (Цели: IP/Телефон/Сеть)')
WHERE cluster_id IS NULL
  AND request ~* '(\mddos\w*|\mдудос\w*|\mддос\w*|\mdos\w*|\mдосс\w*|\mдоос\w*|\mдос\w*|\md o s\w*|\mдедос\w*|\mдидос\w*|\mдодос\w*|\mдудокс\w*|\mdoss\w*|\mдудоса\w*|\mд дос\w*|\mддс\w*|\mмдос\w*|\mдтос\w*|\mdds\w*|\mdudos\w*|\mдэдос\w*|\mdoc\w*|\mdo dos\w*|\mдосить\w*|\mддосить\w*|\mдоус\w*|\mотказ в обслуживании\w*)'
  AND request ~* '\mна\M'
  AND request ~* '(\mvpn\w*|\mвтб\w*|\mинфраструктур\w*|\mкомпани\w*|\mкомпьютер\w*|\mркн\M|\mростелеком\w*|\mчеловек\w*)';

-- Тир 1 — составные условия
UPDATE common.requests SET cluster_id = (SELECT cluster_id FROM common.clusters WHERE cluster_name = 'Без защиты (не целевой)')
WHERE cluster_id IS NULL AND request ~* '(\mсервер\w*|\mхостинг\w*|\mсайт\w*|\mvds\w*|\mvps\w*|\mserver\w*|\msite\w*)' AND request !~* '(\mзащит\w*|\mantiddos\w*|\manti ddos\w*|\mантиддос\w*|\mанти ddos\w*|\mанти дудос\w*|\mанти ддос\w*|\mddos\w*|\mдудос\w*|\mддос\w*|\mcloudflare\w*|\mcdn\w*)';

UPDATE common.requests SET cluster_id = (SELECT cluster_id FROM common.clusters WHERE cluster_name = 'Защита')
WHERE cluster_id IS NULL AND request ~* '(\mсервер\w*|\mхостинг\w*|\mсайт\w*|\mvds\w*|\mvps\w*|\mserver\w*|\msite\w*)' AND request !~* '\mзащит\w*' AND request ~* '(\mddos\w*|\mдудос\w*|\mддос\w*|\mdos\w*|\mдосс\w*|\mдоос\w*|\mдос\w*|\md o s\w*|\mдедос\w*|\mдидос\w*|\mдодос\w*|\mдудокс\w*|\mdoss\w*|\mдудоса\w*|\mд дос\w*|\mддс\w*|\mмдос\w*|\mдтос\w*|\mdds\w*|\mdudos\w*|\mдэдос\w*|\mdoc\w*|\mdo dos\w*|\mдосить\w*|\mддосить\w*|\mдоус\w*|\mотказ в обслуживании\w*)' AND request ~* '\mот\M';

-- Тир 2 — тематические категории средней специфичности
UPDATE common.requests SET cluster_id = (SELECT cluster_id FROM common.clusters WHERE cluster_name = 'Готовое решение')
WHERE cluster_id IS NULL AND request ~* '(\mрешение\w*|\mсервис\w*|\mсистема\w*|\mсредство\w*|\mцентр\w*|\mплатформа\w*|\mуслуга\w*|\mсредства\w*|\mинструмент\w*|\mавтоматизация\w*)';

UPDATE common.requests SET cluster_id = (SELECT cluster_id FROM common.clusters WHERE cluster_name = 'Бесплатно')
WHERE cluster_id IS NULL AND request ~* '(\mfree\w*|\mдешевая\w*|\mбесплатно\w*|\mбесплатная\w*)';

UPDATE common.requests SET cluster_id = (SELECT cluster_id FROM common.clusters WHERE cluster_name = 'Отличие')
WHERE cluster_id IS NULL AND request ~* '(\mразница\w*|\mотличие\w*|\mотличия\w*|\mотлича\w*|\mразличия\w*|\mvs\w*|\mчем отличается\w*|\mдос ддос\w*|\mдос и ддос\w*|\mddos и dos\w*|\mdos и ddos\w*|\mdos от ddos\w*)';

UPDATE common.requests SET cluster_id = (SELECT cluster_id FROM common.clusters WHERE cluster_name = 'Виды')
WHERE cluster_id IS NULL AND request ~* '(\mтипы\w*|\mтипом\w*|\mвиды\w*|\mклассификация\w*|\mуровни\w*|\mпример\w*|\mмеры\w*|\mметоды\w*|\mметодики\w*|\mметодика\w*|\mкакие бывают\w*)';

UPDATE common.requests SET cluster_id = (SELECT cluster_id FROM common.clusters WHERE cluster_name = 'Новости')
WHERE cluster_id IS NULL AND request ~* '(\mчисло\w*|\mхакерские атаки\w*|\mхакерские\w*|\mхакеры\w*|\mсегодня\w*|\mновости\w*|\mкрупнейшие\w*|\mподвергся\w*|\mсейчас\w*|\mhacker\w*)';

-- Новое: ddos-упоминание + год (2020-2029) или месяц -> тоже 'Новости'
-- ('ddos атака 2025', 'ddos атаки июнь'). Год/месяц сами по себе слишком общие,
-- поэтому требуем ddos-упоминание рядом.
UPDATE common.requests SET cluster_id = (SELECT cluster_id FROM common.clusters WHERE cluster_name = 'Новости')
WHERE cluster_id IS NULL
  AND request ~* '(\mddos\w*|\mдудос\w*|\mддос\w*|\mdos\w*|\mдосс\w*|\mдоос\w*|\mдос\w*|\md o s\w*|\mдедос\w*|\mдидос\w*|\mдодос\w*|\mдудокс\w*|\mdoss\w*|\mдудоса\w*|\mд дос\w*|\mддс\w*|\mмдос\w*|\mдтос\w*|\mdds\w*|\mdudos\w*|\mдэдос\w*|\mdoc\w*|\mdo dos\w*|\mдосить\w*|\mддосить\w*|\mдоус\w*|\mотказ в обслуживании\w*)'
  AND request ~* '(\m20[2-4][0-9]\M|\mянвар\w*|\mфевраля\M|\mфевраль\M|\mмарта\M|\mмарт\M|\mапреля\M|\mапрель\M|\mмая\M|\mмай\M|\mиюня\M|\mиюнь\M|\mиюля\M|\mиюль\M|\mавгуста\M|\mавгуст\M|\mсентябр\w*|\mоктябр\w*|\mноябр\w*|\mдекабр\w*)';

UPDATE common.requests SET cluster_id = (SELECT cluster_id FROM common.clusters WHERE cluster_name = 'Последствия')
WHERE cluster_id IS NULL AND request ~* '(\mпоследствия\w*|\mчем опасны\w*|\mчем опасна\w*|\mриски\w*|\mриск\w*|\mмешает\w*|\mдоступу\w*)';

UPDATE common.requests SET cluster_id = (SELECT cluster_id FROM common.clusters WHERE cluster_name = 'Тест')
WHERE cluster_id IS NULL AND request ~* '(\mтест\w*|\mпроверка\w*|\mпроверить\w*|\mпроверки\w*)';

UPDATE common.requests SET cluster_id = (SELECT cluster_id FROM common.clusters WHERE cluster_name = 'Анализ')
WHERE cluster_id IS NULL AND request ~* '(\mанализа\w*|\mанализ\w*)';

UPDATE common.requests SET cluster_id = (SELECT cluster_id FROM common.clusters WHERE cluster_name = 'Поиск')
WHERE cluster_id IS NULL AND request ~* '(\mпоиск\w*|\mсканирование\w*|\mсканер\w*)';

UPDATE common.requests SET cluster_id = (SELECT cluster_id FROM common.clusters WHERE cluster_name = 'Безопасность')
WHERE cluster_id IS NULL AND request ~* '(\mбезопасность\w*|\mбезопасности\w*)';

UPDATE common.requests SET cluster_id = (SELECT cluster_id FROM common.clusters WHERE cluster_name = 'Защита')
WHERE cluster_id IS NULL AND request ~* '(\mборьба\w*|\mблокировка\w*|\mзащищенные\w*|\mзащитой\w*|\mзащиту\w*|\mизбежать\w*|\mзащиты\w*|\mзащите\w*|\mзащищенный\w*|\manti ddos\w*|\mантиддос\w*|\mantiddos\w*|\mанти ddos\w*|\mанти дудос\w*|\mанти ддос\w*|\mпредотвратить\w*|\mбороться\w*|\mостановить\w*|\mустранить\w*|\mзащитить\w*|\mзащита\w*|\mотразить\w*|\mкак бороться\w*|\mпротивостоять\w*|\mпротиводействи\w*|\mantibot\w*|\mантибот\w*|\mprotection\w*|\mprotect\w*|\mservice\w*|\mантидос\w*)';

UPDATE common.requests SET cluster_id = (SELECT cluster_id FROM common.clusters WHERE cluster_name = 'Как работает')
WHERE cluster_id IS NULL AND request ~* '(\mпринципы\w*|\mкак работает\w*|\mкак происходит\w*|\mреализ\w*)';

UPDATE common.requests SET cluster_id = (SELECT cluster_id FROM common.clusters WHERE cluster_name = 'Причины')
WHERE cluster_id IS NULL AND request ~* '(\mпричины\w*|\mпочему\w*|\mзачем\w*|\mдля чего\w*)';

-- 'Цели' — у этого кластера не было ни одного правила (баг переноса из VBA, где
-- ключевое слово 'цели' присутствовало, но потерялось при портировании). Стем
-- \mцел\w*\M покрывает цель/цели/целью/целей — VBA-версия ловила только 'цели'
-- (подстрока), 'преследуют цель' (ед. число) она бы тоже не поймала.
UPDATE common.requests SET cluster_id = (SELECT cluster_id FROM common.clusters WHERE cluster_name = 'Цели')
WHERE cluster_id IS NULL AND request ~* '\mцел\w*\M';

UPDATE common.requests SET cluster_id = (SELECT cluster_id FROM common.clusters WHERE cluster_name = 'Признаки')
WHERE cluster_id IS NULL AND request ~* '(\mпризнак\w*|\mсимптом\w*)';

UPDATE common.requests SET cluster_id = (SELECT cluster_id FROM common.clusters WHERE cluster_name = 'Какие')
WHERE cluster_id IS NULL AND request ~* '(\mкакие\w*|\mкакой\w*)';

-- Тир 3 — общие однословные категории (низший приоритет)
UPDATE common.requests SET cluster_id = (SELECT cluster_id FROM common.clusters WHERE cluster_name = 'Как')
WHERE cluster_id IS NULL AND request ~* '\mкак\M';

UPDATE common.requests SET cluster_id = (SELECT cluster_id FROM common.clusters WHERE cluster_name = 'Что')
WHERE cluster_id IS NULL AND request ~* '(\mчто\M|\mэто\M)';

-- 'Заказ атаки?' — оценивается после всех именованных категорий: если дошли сюда,
-- значит ничего более специфичное не подошло (см. пояснение выше).
UPDATE common.requests SET cluster_id = (SELECT cluster_id FROM common.clusters WHERE cluster_name = 'Заказ атаки?')
WHERE cluster_id IS NULL AND request ~* '(\mcdn\w*|\mроутер\w*|\mip\w*|\mадрес\w*|\mnginx\w*|\mvds\w*|\mvps\w*|\mсервер\w*|\mсайт\w*|\mхост\w*|\mпровайдеров\w*|\mботнет\w*|\msite\w*|\mserver\w*|\mzone\w*|\mтг\w*|\mинтернета\w*)' AND request !~* '\mзащит\w*' AND (request ~* '(\mddos\w*|\mдудос\w*|\mддос\w*|\mdos\w*|\mдосс\w*|\mдоос\w*|\mдос\w*|\md o s\w*|\mдедос\w*|\mдидос\w*|\mдодос\w*|\mдудокс\w*|\mdoss\w*|\mдудоса\w*|\mд дос\w*|\mддс\w*|\mмдос\w*|\mдтос\w*|\mdds\w*|\mdudos\w*|\mдэдос\w*|\mdoc\w*|\mdo dos\w*|\mдосить\w*|\mддосить\w*|\mдоус\w*|\mотказ в обслуживании\w*)');

-- Фолбэк: запрос целиком состоит из ddos/атака-слов (и пробелов) -> 'Общее понятие DDoS'
UPDATE common.requests SET cluster_id = (SELECT cluster_id FROM common.clusters WHERE cluster_name = 'Общее понятие DDoS')
WHERE cluster_id IS NULL AND request ~* '^(\s*(ddos|дудос|ддос|атаками|атаку|атаке|атаки|атака|атак|dos|досс|доос|дос|d o s|дедос|дидос|додос|дудокс|ataka|doss|дудоса|д дос|attack|atack|атакой|атакам|ддс|мдос|дтос|dds|dudos|дэдос|doc|do dos|досить|ддосить|доус|отказ в обслуживании)\s*)+$';

-- ============================================================
-- ЧАСТЬ 2: topic_id (столбец 'Тема или Интент' в исходном файле)
-- Порядок приоритета:
--   1. Сброс topic_id='ddos атака' — безусловно каждый прогон (нижний приоритет
--      цепочки, см. пункт 8/9 в шапке файла).
--   2. 'положить сайт/сервер' — глагол-разрушение + объект.
--   3. 'выполнить атаку' — глагол действия (+ атака ИЛИ ddos-упоминание), ИЛИ
--      разговорный ddos-глагол (ддосить/задудосить/...) сам по себе.
--   4. Словарь конкретных целей/типов атак (сервер/сайт/mitm/sql/...).
--   5. 'принцип работы' / 'расшифровка' / 'написание-произношение' — БЕЗ
--      требования 'защит'/'атака' рядом (сами по себе достаточно специфичны:
--      расшифровыва.../читается/пишется и т.п. редко значат что-то ещё).
--   6. Намерение защититься -> 'защита'.
--   7. Упоминание ddos в любом написании -> 'ddos атака'.
--   8. Просто слово 'атака' без остального -> удалить / другой вид атаки.
-- ============================================================

-- Дополняем common.topics всеми каноническими значениями словаря уточнения.
INSERT INTO common.topics (topic_name) VALUES
    ('bruteforce'),
    ('cdn'),
    ('cloudflare'),
    ('ddos атака'),
    ('dns'),
    ('dns_spoofing'),
    ('icmp'),
    ('ip'),
    ('kaminsky'),
    ('mitm'),
    ('mobile_attack'),
    ('nginx'),
    ('phishing'),
    ('ransomware'),
    ('slowloris'),
    ('spam'),
    ('sql'),
    ('syn_flood'),
    ('vds'),
    ('vps'),
    ('wifi'),
    ('xss'),
    ('виды атак'),
    ('выполнить атаку'),
    ('домен'),
    ('другой вид атаки'),
    ('защита'),
    ('интернет'),
    ('кибератака'),
    ('майнкрафт'),
    ('массированная'),
    ('написание/произношение'),
    ('номер'),
    ('положить сайт/сервер'),
    ('принцип работы'),
    ('провайдер'),
    ('расшифровка'),
    ('россия'),
    ('роутер'),
    ('сайт'),
    ('сервер'),
    ('сети'),
    ('сленг'),
    ('телефон'),
    ('удалить'),
    ('хакер'),
    ('хост'),
    ('хостинг'),
    ('яндекс')
ON CONFLICT (topic_name) DO NOTHING;

-- Шаг 0: 'ddos атака' — самый нижний приоритет в цепочке, поэтому безусловно
-- сбрасывается и пересчитывается заново при каждом прогоне, чтобы строки с
-- прошлых прогонов увидели новые/уточнённые правила выше по приоритету.
UPDATE common.requests SET topic_id = NULL
WHERE topic_id = (SELECT topic_id FROM common.topics WHERE topic_name = 'ddos атака');

-- Приоритет 1: 'положить сайт/сервер'.
UPDATE common.requests SET topic_id = (SELECT topic_id FROM common.topics WHERE topic_name = 'положить сайт/сервер')
WHERE topic_id IS NULL AND request ~* '(\mположить\w*|\mуронить\w*|\mзавалить\w*|\mвырубить\w*|\mобрушить\w*|\mвывести из строя\w*)' AND request ~* '(\mсайт\w*|\msite\w*|\mсервер\w*|\mserver\w*)';

-- Приоритет 2: 'выполнить атаку' — глагол действия рядом с 'атака' ИЛИ с любым
-- упоминанием ddos ('как сделать ddos' — 'атака' в тексте нет вообще), ИЛИ
-- разговорный ddos-глагол сам по себе. Без намерения защититься.
UPDATE common.requests SET topic_id = (SELECT topic_id FROM common.topics WHERE topic_name = 'выполнить атаку')
WHERE topic_id IS NULL
  AND (request ~* '(\mддосить\w*|\mдудосить\w*|\mзаддосить\w*|\mзадудосить\w*|\mддосят\w*|\mдудосят\w*|\mзаддосил\w*|\mзадудосил\w*|\mддосер\w*|\mдудосер\w*|\mddoser\w*)' OR (request ~* '(\mсделать\w*|\mделать\w*|\mделают\w*|\mделает\w*|\mустроить\w*|\mпровести\w*|\mвыполнить\w*|\mзапустить\w*|\mорганизовать\w*|\mначать\w*|\mсовершить\w*)' AND (request ~* '(\mатак\w*|(\mattack\w*|\matack\w*|\mataka\w*))' OR request ~* '(\mddos\w*|\mдудос\w*|\mддос\w*|\mdos\w*|\mдосс\w*|\mдоос\w*|\mдос\w*|\md o s\w*|\mдедос\w*|\mдидос\w*|\mдодос\w*|\mдудокс\w*|\mdoss\w*|\mдудоса\w*|\mд дос\w*|\mддс\w*|\mмдос\w*|\mдтос\w*|\mdds\w*|\mdudos\w*|\mдэдос\w*|\mdoc\w*|\mdo dos\w*|\mдосить\w*|\mддосить\w*|\mдоус\w*|\mотказ в обслуживании\w*)')))
  AND request !~* '(\mзащит\w*|(\mбороться\w*|\mпредотвратить\w*|\mостановить\w*|\mустранить\w*|\mотразить\w*|\mпротивостоять\w*|\mизбежать\w*|\mизбавиться\w*))';

-- Приоритет 3: словарь конкретных объектов/типов атак — первое совпадение по
-- порядку словаря побеждает. Срабатывает при намерении защититься или слове 'атака'.

UPDATE common.requests SET topic_id = (SELECT topic_id FROM common.topics WHERE topic_name = 'сети')
WHERE topic_id IS NULL AND (request ~* '(\mзащит\w*|(\mбороться\w*|\mпредотвратить\w*|\mостановить\w*|\mустранить\w*|\mотразить\w*|\mпротивостоять\w*|\mизбежать\w*|\mизбавиться\w*))' OR request ~* '(\mатак\w*|(\mattack\w*|\matack\w*|\mataka\w*))') AND request ~* '\mсет\w*';

UPDATE common.requests SET topic_id = (SELECT topic_id FROM common.topics WHERE topic_name = 'сервер')
WHERE topic_id IS NULL AND (request ~* '(\mзащит\w*|(\mбороться\w*|\mпредотвратить\w*|\mостановить\w*|\mустранить\w*|\mотразить\w*|\mпротивостоять\w*|\mизбежать\w*|\mизбавиться\w*))' OR request ~* '(\mатак\w*|(\mattack\w*|\matack\w*|\mataka\w*))') AND request ~* '(\mсервер\w*|\mserver\w*)';

UPDATE common.requests SET topic_id = (SELECT topic_id FROM common.topics WHERE topic_name = 'кибератака')
WHERE topic_id IS NULL AND (request ~* '(\mзащит\w*|(\mбороться\w*|\mпредотвратить\w*|\mостановить\w*|\mустранить\w*|\mотразить\w*|\mпротивостоять\w*|\mизбежать\w*|\mизбавиться\w*))' OR request ~* '(\mатак\w*|(\mattack\w*|\matack\w*|\mataka\w*))') AND request ~* '\mкибератак\w*';

UPDATE common.requests SET topic_id = (SELECT topic_id FROM common.topics WHERE topic_name = 'хостинг')
WHERE topic_id IS NULL AND (request ~* '(\mзащит\w*|(\mбороться\w*|\mпредотвратить\w*|\mостановить\w*|\mустранить\w*|\mотразить\w*|\mпротивостоять\w*|\mизбежать\w*|\mизбавиться\w*))' OR request ~* '(\mатак\w*|(\mattack\w*|\matack\w*|\mataka\w*))') AND request ~* '\mхостинг\w*';

UPDATE common.requests SET topic_id = (SELECT topic_id FROM common.topics WHERE topic_name = 'сайт')
WHERE topic_id IS NULL AND (request ~* '(\mзащит\w*|(\mбороться\w*|\mпредотвратить\w*|\mостановить\w*|\mустранить\w*|\mотразить\w*|\mпротивостоять\w*|\mизбежать\w*|\mизбавиться\w*))' OR request ~* '(\mатак\w*|(\mattack\w*|\matack\w*|\mataka\w*))') AND request ~* '(\mсайт\w*|\msite\w*)';

UPDATE common.requests SET topic_id = (SELECT topic_id FROM common.topics WHERE topic_name = 'vds')
WHERE topic_id IS NULL AND (request ~* '(\mзащит\w*|(\mбороться\w*|\mпредотвратить\w*|\mостановить\w*|\mустранить\w*|\mотразить\w*|\mпротивостоять\w*|\mизбежать\w*|\mизбавиться\w*))' OR request ~* '(\mатак\w*|(\mattack\w*|\matack\w*|\mataka\w*))') AND request ~* '\mvds\w*';

UPDATE common.requests SET topic_id = (SELECT topic_id FROM common.topics WHERE topic_name = 'vps')
WHERE topic_id IS NULL AND (request ~* '(\mзащит\w*|(\mбороться\w*|\mпредотвратить\w*|\mостановить\w*|\mустранить\w*|\mотразить\w*|\mпротивостоять\w*|\mизбежать\w*|\mизбавиться\w*))' OR request ~* '(\mатак\w*|(\mattack\w*|\matack\w*|\mataka\w*))') AND request ~* '\mvps\w*';

UPDATE common.requests SET topic_id = (SELECT topic_id FROM common.topics WHERE topic_name = 'ip')
WHERE topic_id IS NULL AND (request ~* '(\mзащит\w*|(\mбороться\w*|\mпредотвратить\w*|\mостановить\w*|\mустранить\w*|\mотразить\w*|\mпротивостоять\w*|\mизбежать\w*|\mизбавиться\w*))' OR request ~* '(\mатак\w*|(\mattack\w*|\matack\w*|\mataka\w*))') AND request ~* '(\mайпи\M|\mip\M)';

UPDATE common.requests SET topic_id = (SELECT topic_id FROM common.topics WHERE topic_name = 'роутер')
WHERE topic_id IS NULL AND (request ~* '(\mзащит\w*|(\mбороться\w*|\mпредотвратить\w*|\mостановить\w*|\mустранить\w*|\mотразить\w*|\mпротивостоять\w*|\mизбежать\w*|\mизбавиться\w*))' OR request ~* '(\mатак\w*|(\mattack\w*|\matack\w*|\mataka\w*))') AND request ~* '\mроутер\w*';

UPDATE common.requests SET topic_id = (SELECT topic_id FROM common.topics WHERE topic_name = 'nginx')
WHERE topic_id IS NULL AND (request ~* '(\mзащит\w*|(\mбороться\w*|\mпредотвратить\w*|\mостановить\w*|\mустранить\w*|\mотразить\w*|\mпротивостоять\w*|\mизбежать\w*|\mизбавиться\w*))' OR request ~* '(\mатак\w*|(\mattack\w*|\matack\w*|\mataka\w*))') AND request ~* '\mnginx\w*';

UPDATE common.requests SET topic_id = (SELECT topic_id FROM common.topics WHERE topic_name = 'хост')
WHERE topic_id IS NULL AND (request ~* '(\mзащит\w*|(\mбороться\w*|\mпредотвратить\w*|\mостановить\w*|\mустранить\w*|\mотразить\w*|\mпротивостоять\w*|\mизбежать\w*|\mизбавиться\w*))' OR request ~* '(\mатак\w*|(\mattack\w*|\matack\w*|\mataka\w*))') AND request ~* '\mхост\w*';

UPDATE common.requests SET topic_id = (SELECT topic_id FROM common.topics WHERE topic_name = 'провайдер')
WHERE topic_id IS NULL AND (request ~* '(\mзащит\w*|(\mбороться\w*|\mпредотвратить\w*|\mостановить\w*|\mустранить\w*|\mотразить\w*|\mпротивостоять\w*|\mизбежать\w*|\mизбавиться\w*))' OR request ~* '(\mатак\w*|(\mattack\w*|\matack\w*|\mataka\w*))') AND request ~* '\mпровайдер\w*';

UPDATE common.requests SET topic_id = (SELECT topic_id FROM common.topics WHERE topic_name = 'домен')
WHERE topic_id IS NULL AND (request ~* '(\mзащит\w*|(\mбороться\w*|\mпредотвратить\w*|\mостановить\w*|\mустранить\w*|\mотразить\w*|\mпротивостоять\w*|\mизбежать\w*|\mизбавиться\w*))' OR request ~* '(\mатак\w*|(\mattack\w*|\matack\w*|\mataka\w*))') AND request ~* '\mдомен\w*';

UPDATE common.requests SET topic_id = (SELECT topic_id FROM common.topics WHERE topic_name = 'wifi')
WHERE topic_id IS NULL AND (request ~* '(\mзащит\w*|(\mбороться\w*|\mпредотвратить\w*|\mостановить\w*|\mустранить\w*|\mотразить\w*|\mпротивостоять\w*|\mизбежать\w*|\mизбавиться\w*))' OR request ~* '(\mатак\w*|(\mattack\w*|\matack\w*|\mataka\w*))') AND request ~* '\mwifi\M';

UPDATE common.requests SET topic_id = (SELECT topic_id FROM common.topics WHERE topic_name = 'dns')
WHERE topic_id IS NULL AND (request ~* '(\mзащит\w*|(\mбороться\w*|\mпредотвратить\w*|\mостановить\w*|\mустранить\w*|\mотразить\w*|\mпротивостоять\w*|\mизбежать\w*|\mизбавиться\w*))' OR request ~* '(\mатак\w*|(\mattack\w*|\matack\w*|\mataka\w*))') AND request ~* '\mdns\M';

UPDATE common.requests SET topic_id = (SELECT topic_id FROM common.topics WHERE topic_name = 'телефон')
WHERE topic_id IS NULL AND (request ~* '(\mзащит\w*|(\mбороться\w*|\mпредотвратить\w*|\mостановить\w*|\mустранить\w*|\mотразить\w*|\mпротивостоять\w*|\mизбежать\w*|\mизбавиться\w*))' OR request ~* '(\mатак\w*|(\mattack\w*|\matack\w*|\mataka\w*))') AND request ~* '(\mтелефон\w*|\mмобильный\w*)';

UPDATE common.requests SET topic_id = (SELECT topic_id FROM common.topics WHERE topic_name = 'номер')
WHERE topic_id IS NULL AND (request ~* '(\mзащит\w*|(\mбороться\w*|\mпредотвратить\w*|\mостановить\w*|\mустранить\w*|\mотразить\w*|\mпротивостоять\w*|\mизбежать\w*|\mизбавиться\w*))' OR request ~* '(\mатак\w*|(\mattack\w*|\matack\w*|\mataka\w*))') AND request ~* '\mномер\w*';

UPDATE common.requests SET topic_id = (SELECT topic_id FROM common.topics WHERE topic_name = 'майнкрафт')
WHERE topic_id IS NULL AND (request ~* '(\mзащит\w*|(\mбороться\w*|\mпредотвратить\w*|\mостановить\w*|\mустранить\w*|\mотразить\w*|\mпротивостоять\w*|\mизбежать\w*|\mизбавиться\w*))' OR request ~* '(\mатак\w*|(\mattack\w*|\matack\w*|\mataka\w*))') AND request ~* '(\mмайнкрафт\w*|\mminecraft\w*)';

UPDATE common.requests SET topic_id = (SELECT topic_id FROM common.topics WHERE topic_name = 'cloudflare')
WHERE topic_id IS NULL AND (request ~* '(\mзащит\w*|(\mбороться\w*|\mпредотвратить\w*|\mостановить\w*|\mустранить\w*|\mотразить\w*|\mпротивостоять\w*|\mизбежать\w*|\mизбавиться\w*))' OR request ~* '(\mатак\w*|(\mattack\w*|\matack\w*|\mataka\w*))') AND request ~* '\mcloudflare\M';

UPDATE common.requests SET topic_id = (SELECT topic_id FROM common.topics WHERE topic_name = 'cdn')
WHERE topic_id IS NULL AND (request ~* '(\mзащит\w*|(\mбороться\w*|\mпредотвратить\w*|\mостановить\w*|\mустранить\w*|\mотразить\w*|\mпротивостоять\w*|\mизбежать\w*|\mизбавиться\w*))' OR request ~* '(\mатак\w*|(\mattack\w*|\matack\w*|\mataka\w*))') AND request ~* '\mcdn\M';

UPDATE common.requests SET topic_id = (SELECT topic_id FROM common.topics WHERE topic_name = 'интернет')
WHERE topic_id IS NULL AND (request ~* '(\mзащит\w*|(\mбороться\w*|\mпредотвратить\w*|\mостановить\w*|\mустранить\w*|\mотразить\w*|\mпротивостоять\w*|\mизбежать\w*|\mизбавиться\w*))' OR request ~* '(\mатак\w*|(\mattack\w*|\matack\w*|\mataka\w*))') AND request ~* '\mинтернет\w*';

UPDATE common.requests SET topic_id = (SELECT topic_id FROM common.topics WHERE topic_name = 'россия')
WHERE topic_id IS NULL AND (request ~* '(\mзащит\w*|(\mбороться\w*|\mпредотвратить\w*|\mостановить\w*|\mустранить\w*|\mотразить\w*|\mпротивостоять\w*|\mизбежать\w*|\mизбавиться\w*))' OR request ~* '(\mатак\w*|(\mattack\w*|\matack\w*|\mataka\w*))') AND request ~* '\mроссию\M';

UPDATE common.requests SET topic_id = (SELECT topic_id FROM common.topics WHERE topic_name = 'яндекс')
WHERE topic_id IS NULL AND (request ~* '(\mзащит\w*|(\mбороться\w*|\mпредотвратить\w*|\mостановить\w*|\mустранить\w*|\mотразить\w*|\mпротивостоять\w*|\mизбежать\w*|\mизбавиться\w*))' OR request ~* '(\mатак\w*|(\mattack\w*|\matack\w*|\mataka\w*))') AND request ~* '\mяндекс\M';

UPDATE common.requests SET topic_id = (SELECT topic_id FROM common.topics WHERE topic_name = 'хакер')
WHERE topic_id IS NULL AND (request ~* '(\mзащит\w*|(\mбороться\w*|\mпредотвратить\w*|\mостановить\w*|\mустранить\w*|\mотразить\w*|\mпротивостоять\w*|\mизбежать\w*|\mизбавиться\w*))' OR request ~* '(\mатак\w*|(\mattack\w*|\matack\w*|\mataka\w*))') AND request ~* '\mхакер\w*';

UPDATE common.requests SET topic_id = (SELECT topic_id FROM common.topics WHERE topic_name = 'сленг')
WHERE topic_id IS NULL AND (request ~* '(\mзащит\w*|(\mбороться\w*|\mпредотвратить\w*|\mостановить\w*|\mустранить\w*|\mотразить\w*|\mпротивостоять\w*|\mизбежать\w*|\mизбавиться\w*))' OR request ~* '(\mатак\w*|(\mattack\w*|\matack\w*|\mataka\w*))') AND request ~* '\mсленг\M';

UPDATE common.requests SET topic_id = (SELECT topic_id FROM common.topics WHERE topic_name = 'mitm')
WHERE topic_id IS NULL AND (request ~* '(\mзащит\w*|(\mбороться\w*|\mпредотвратить\w*|\mостановить\w*|\mустранить\w*|\mотразить\w*|\mпротивостоять\w*|\mизбежать\w*|\mизбавиться\w*))' OR request ~* '(\mатак\w*|(\mattack\w*|\matack\w*|\mataka\w*))') AND request ~* '(\mmitm\M|\mчеловек посередине\M|\mman in the middle\M|\mпосредник\w*)';

UPDATE common.requests SET topic_id = (SELECT topic_id FROM common.topics WHERE topic_name = 'sql')
WHERE topic_id IS NULL AND (request ~* '(\mзащит\w*|(\mбороться\w*|\mпредотвратить\w*|\mостановить\w*|\mустранить\w*|\mотразить\w*|\mпротивостоять\w*|\mизбежать\w*|\mизбавиться\w*))' OR request ~* '(\mатак\w*|(\mattack\w*|\matack\w*|\mataka\w*))') AND request ~* '\msql\w*';

UPDATE common.requests SET topic_id = (SELECT topic_id FROM common.topics WHERE topic_name = 'xss')
WHERE topic_id IS NULL AND (request ~* '(\mзащит\w*|(\mбороться\w*|\mпредотвратить\w*|\mостановить\w*|\mустранить\w*|\mотразить\w*|\mпротивостоять\w*|\mизбежать\w*|\mизбавиться\w*))' OR request ~* '(\mатак\w*|(\mattack\w*|\matack\w*|\mataka\w*))') AND request ~* '(\mxss\M|\mcross site scripting\M|\mмежсайтовый скриптинг\M)';

UPDATE common.requests SET topic_id = (SELECT topic_id FROM common.topics WHERE topic_name = 'bruteforce')
WHERE topic_id IS NULL AND (request ~* '(\mзащит\w*|(\mбороться\w*|\mпредотвратить\w*|\mостановить\w*|\mустранить\w*|\mотразить\w*|\mпротивостоять\w*|\mизбежать\w*|\mизбавиться\w*))' OR request ~* '(\mатак\w*|(\mattack\w*|\matack\w*|\mataka\w*))') AND request ~* '(\mбрутфорс\M|\mbruteforce\M)';

UPDATE common.requests SET topic_id = (SELECT topic_id FROM common.topics WHERE topic_name = 'phishing')
WHERE topic_id IS NULL AND (request ~* '(\mзащит\w*|(\mбороться\w*|\mпредотвратить\w*|\mостановить\w*|\mустранить\w*|\mотразить\w*|\mпротивостоять\w*|\mизбежать\w*|\mизбавиться\w*))' OR request ~* '(\mатак\w*|(\mattack\w*|\matack\w*|\mataka\w*))') AND request ~* '(\mфишинг\M|\mphishing\M)';

UPDATE common.requests SET topic_id = (SELECT topic_id FROM common.topics WHERE topic_name = 'syn_flood')
WHERE topic_id IS NULL AND (request ~* '(\mзащит\w*|(\mбороться\w*|\mпредотвратить\w*|\mостановить\w*|\mустранить\w*|\mотразить\w*|\mпротивостоять\w*|\mизбежать\w*|\mизбавиться\w*))' OR request ~* '(\mатак\w*|(\mattack\w*|\matack\w*|\mataka\w*))') AND request ~* '\msyn\s?flood\w*';

UPDATE common.requests SET topic_id = (SELECT topic_id FROM common.topics WHERE topic_name = 'slowloris')
WHERE topic_id IS NULL AND (request ~* '(\mзащит\w*|(\mбороться\w*|\mпредотвратить\w*|\mостановить\w*|\mустранить\w*|\mотразить\w*|\mпротивостоять\w*|\mизбежать\w*|\mизбавиться\w*))' OR request ~* '(\mатак\w*|(\mattack\w*|\matack\w*|\mataka\w*))') AND request ~* '\mslowloris\M';

UPDATE common.requests SET topic_id = (SELECT topic_id FROM common.topics WHERE topic_name = 'icmp')
WHERE topic_id IS NULL AND (request ~* '(\mзащит\w*|(\mбороться\w*|\mпредотвратить\w*|\mостановить\w*|\mустранить\w*|\mотразить\w*|\mпротивостоять\w*|\mизбежать\w*|\mизбавиться\w*))' OR request ~* '(\mатак\w*|(\mattack\w*|\matack\w*|\mataka\w*))') AND request ~* '\micmp\M';

UPDATE common.requests SET topic_id = (SELECT topic_id FROM common.topics WHERE topic_name = 'kaminsky')
WHERE topic_id IS NULL AND (request ~* '(\mзащит\w*|(\mбороться\w*|\mпредотвратить\w*|\mостановить\w*|\mустранить\w*|\mотразить\w*|\mпротивостоять\w*|\mизбежать\w*|\mизбавиться\w*))' OR request ~* '(\mатак\w*|(\mattack\w*|\matack\w*|\mataka\w*))') AND request ~* '(\mкаминского\M|\mkaminsky\M)';

UPDATE common.requests SET topic_id = (SELECT topic_id FROM common.topics WHERE topic_name = 'dns_spoofing')
WHERE topic_id IS NULL AND (request ~* '(\mзащит\w*|(\mбороться\w*|\mпредотвратить\w*|\mостановить\w*|\mустранить\w*|\mотразить\w*|\mпротивостоять\w*|\mизбежать\w*|\mизбавиться\w*))' OR request ~* '(\mатак\w*|(\mattack\w*|\matack\w*|\mataka\w*))') AND request ~* '\mdns\s+spoofing\w*';

UPDATE common.requests SET topic_id = (SELECT topic_id FROM common.topics WHERE topic_name = 'spam')
WHERE topic_id IS NULL AND (request ~* '(\mзащит\w*|(\mбороться\w*|\mпредотвратить\w*|\mостановить\w*|\mустранить\w*|\mотразить\w*|\mпротивостоять\w*|\mизбежать\w*|\mизбавиться\w*))' OR request ~* '(\mатак\w*|(\mattack\w*|\matack\w*|\mataka\w*))') AND request ~* '\mспам\M';

UPDATE common.requests SET topic_id = (SELECT topic_id FROM common.topics WHERE topic_name = 'mobile_attack')
WHERE topic_id IS NULL AND (request ~* '(\mзащит\w*|(\mбороться\w*|\mпредотвратить\w*|\mостановить\w*|\mустранить\w*|\mотразить\w*|\mпротивостоять\w*|\mизбежать\w*|\mизбавиться\w*))' OR request ~* '(\mатак\w*|(\mattack\w*|\matack\w*|\mataka\w*))') AND request ~* '\mтелефонная\M';

UPDATE common.requests SET topic_id = (SELECT topic_id FROM common.topics WHERE topic_name = 'массированная')
WHERE topic_id IS NULL AND (request ~* '(\mзащит\w*|(\mбороться\w*|\mпредотвратить\w*|\mостановить\w*|\mустранить\w*|\mотразить\w*|\mпротивостоять\w*|\mизбежать\w*|\mизбавиться\w*))' OR request ~* '(\mатак\w*|(\mattack\w*|\matack\w*|\mataka\w*))') AND request ~* '\mмассированная\M';

UPDATE common.requests SET topic_id = (SELECT topic_id FROM common.topics WHERE topic_name = 'ransomware')
WHERE topic_id IS NULL AND (request ~* '(\mзащит\w*|(\mбороться\w*|\mпредотвратить\w*|\mостановить\w*|\mустранить\w*|\mотразить\w*|\mпротивостоять\w*|\mизбежать\w*|\mизбавиться\w*))' OR request ~* '(\mатак\w*|(\mattack\w*|\matack\w*|\mataka\w*))') AND request ~* '\mвымогател\w*';

UPDATE common.requests SET topic_id = (SELECT topic_id FROM common.topics WHERE topic_name = 'виды атак')
WHERE topic_id IS NULL AND (request ~* '(\mзащит\w*|(\mбороться\w*|\mпредотвратить\w*|\mостановить\w*|\mустранить\w*|\mотразить\w*|\mпротивостоять\w*|\mизбежать\w*|\mизбавиться\w*))' OR request ~* '(\mатак\w*|(\mattack\w*|\matack\w*|\mataka\w*))') AND request ~* '\mкакие бывают атаки\M';

-- Приоритет 4: 'принцип работы' / 'расшифровка' / 'написание-произношение' —
-- БЕЗ требования 'защит'/'атака' рядом (в отличие от словаря целей выше), т.к.
-- такие вопросы обычно вообще не содержат ни того, ни другого слова.
UPDATE common.requests SET topic_id = (SELECT topic_id FROM common.topics WHERE topic_name = 'принцип работы')
WHERE topic_id IS NULL AND request ~* '(\mпринцип\w*|\mмеханизм\w*|\mкак работает\w*|\mкак происходит\w*|\mкак действует\w*|\mкак устроен\w*|\mалгоритм работы\w*)';

UPDATE common.requests SET topic_id = (SELECT topic_id FROM common.topics WHERE topic_name = 'расшифровка')
WHERE topic_id IS NULL AND request ~* '\mрасшифровыва\w*';

UPDATE common.requests SET topic_id = (SELECT topic_id FROM common.topics WHERE topic_name = 'написание/произношение')
WHERE topic_id IS NULL AND request ~* '(\mпиш\w*|\mчита\w*|\mпроизнос\w*|\mзвуч\w*)';

-- Приоритет 5: конкретной цели/намерения не нашли, но есть намерение защититься -> 'защита'.
UPDATE common.requests SET topic_id = (SELECT topic_id FROM common.topics WHERE topic_name = 'защита')
WHERE topic_id IS NULL AND request ~* '(\mзащит\w*|(\mбороться\w*|\mпредотвратить\w*|\mостановить\w*|\mустранить\w*|\mотразить\w*|\mпротивостоять\w*|\mизбежать\w*|\mизбавиться\w*))';

-- 'Приоритет 6' (ddos-упоминание -> 'ddos атака') сознательно убран: это не
-- интент, а просто подтверждение темы, которая и так ясна из hub_id/cluster_id.
-- Такие строки остаются topic_id = NULL ("специфичный интент не определён"),
-- а не превращаются в бесполезно широкую категорию. Шаг 0 выше уже сбросил
-- всё, что раньше сюда попало. В DataLens NULL превращается в человекочитаемое
-- "Не определено" через IFNULL([topic_name], 'Не определено') — ничего
-- выдумывать в БД не нужно.

-- Приоритет 6: слово 'атака' есть, но ничего конкретнее не нашли.
UPDATE common.requests SET topic_id = (SELECT topic_id FROM common.topics WHERE topic_name = 'удалить')
WHERE topic_id IS NULL AND request ~* '(\mатак\w*|(\mattack\w*|\matack\w*|\mataka\w*))' AND request ~* '(\mчто\M|\mэто\M|\mкак\M|\mкакой\M|\mкто такой\M|\mкто такие\M)';

UPDATE common.requests SET topic_id = (SELECT topic_id FROM common.topics WHERE topic_name = 'другой вид атаки')
WHERE topic_id IS NULL AND request ~* '(\mатак\w*|(\mattack\w*|\matack\w*|\mataka\w*))';

-- ============================================================
-- ЧАСТЬ 3: hub_id — упоминание ddos + уточнение продукта
-- Большинство строк уже получили hub_id из исходного файла (колонка 'Хаб') —
-- их WHERE hub_id IS NULL не тронет. Это правило — только для строк без хаба:
--   0. Упоминание L3/L4 (в любом написании: L3 4, l3-4, l3/4, l3l4 и т.п.) ->
--      хаб 'Сети'. Если L3/L4 нет, но есть L7 -> хаб 'Сайт'. Если в запросе
--      есть и L3/L4, и L7 одновременно -> 'Сети' (проверяется первым).
--   1. Есть упоминание ddos (в любом написании) + уточнение продукта
--      (сайт/сеть/хостинг/vds/сервер) -> хаб соответствующего продукта.
--   2. Есть упоминание ddos, но продукт не уточнён -> хаб 'DDoS'.
-- ============================================================

-- Коррекция: строки с упоминанием L3/L7 могли уже получить hub_id из исходного
-- файла (например, общий 'DDoS'), не совпадающий с этим уточняющим правилом.
-- Сбрасываем именно такие строки, чтобы приоритет 0 ниже мог их переопределить.
UPDATE common.requests SET hub_id = NULL
WHERE request ~* '\ml3\w*\M'
  AND hub_id IS DISTINCT FROM (SELECT hub_id FROM common.hubs WHERE hub_name = 'Сети');

UPDATE common.requests SET hub_id = NULL
WHERE request ~* '\ml7\M' AND request !~* '\ml3\w*\M'
  AND hub_id IS DISTINCT FROM (SELECT hub_id FROM common.hubs WHERE hub_name = 'Сайт');

-- Приоритет 0: любое упоминание L3 (l3, l3-4, l3/l4, l3 l7, ...) -> 'Сети', побеждает
-- даже при наличии L7 в том же запросе ('l3 l7' -> Сети, не Сайт). Только L7 без
-- L3 в любом виде -> 'Сайт'.
UPDATE common.requests SET hub_id = (SELECT hub_id FROM common.hubs WHERE hub_name = 'Сети')
WHERE hub_id IS NULL AND request ~* '\ml3\w*\M';

UPDATE common.requests SET hub_id = (SELECT hub_id FROM common.hubs WHERE hub_name = 'Сайт')
WHERE hub_id IS NULL AND request ~* '\ml7\M';

-- Приоритет 1: ddos + конкретный продукт -> хаб продукта.

UPDATE common.requests SET hub_id = (SELECT hub_id FROM common.hubs WHERE hub_name = 'Сайт')
WHERE hub_id IS NULL AND request ~* '(\mddos\w*|\mдудос\w*|\mддос\w*|\mdos\w*|\mдосс\w*|\mдоос\w*|\mдос\w*|\md o s\w*|\mдедос\w*|\mдидос\w*|\mдодос\w*|\mдудокс\w*|\mdoss\w*|\mдудоса\w*|\mд дос\w*|\mддс\w*|\mмдос\w*|\mдтос\w*|\mdds\w*|\mdudos\w*|\mдэдос\w*|\mdoc\w*|\mdo dos\w*|\mдосить\w*|\mддосить\w*|\mдоус\w*|\mотказ в обслуживании\w*|\mддосить\w*|\mдудосить\w*|\mзаддосить\w*|\mзадудосить\w*)' AND request ~* '(\mсайт\w*|\msite\w*)';

UPDATE common.requests SET hub_id = (SELECT hub_id FROM common.hubs WHERE hub_name = 'Сети')
WHERE hub_id IS NULL AND request ~* '(\mddos\w*|\mдудос\w*|\mддос\w*|\mdos\w*|\mдосс\w*|\mдоос\w*|\mдос\w*|\md o s\w*|\mдедос\w*|\mдидос\w*|\mдодос\w*|\mдудокс\w*|\mdoss\w*|\mдудоса\w*|\mд дос\w*|\mддс\w*|\mмдос\w*|\mдтос\w*|\mdds\w*|\mdudos\w*|\mдэдос\w*|\mdoc\w*|\mdo dos\w*|\mдосить\w*|\mддосить\w*|\mдоус\w*|\mотказ в обслуживании\w*|\mддосить\w*|\mдудосить\w*|\mзаддосить\w*|\mзадудосить\w*)' AND request ~* '\mсет\w*';

UPDATE common.requests SET hub_id = (SELECT hub_id FROM common.hubs WHERE hub_name = 'Хостинг')
WHERE hub_id IS NULL AND request ~* '(\mddos\w*|\mдудос\w*|\mддос\w*|\mdos\w*|\mдосс\w*|\mдоос\w*|\mдос\w*|\md o s\w*|\mдедос\w*|\mдидос\w*|\mдодос\w*|\mдудокс\w*|\mdoss\w*|\mдудоса\w*|\mд дос\w*|\mддс\w*|\mмдос\w*|\mдтос\w*|\mdds\w*|\mdudos\w*|\mдэдос\w*|\mdoc\w*|\mdo dos\w*|\mдосить\w*|\mддосить\w*|\mдоус\w*|\mотказ в обслуживании\w*|\mддосить\w*|\mдудосить\w*|\mзаддосить\w*|\mзадудосить\w*)' AND request ~* '\mхостинг\w*';

UPDATE common.requests SET hub_id = (SELECT hub_id FROM common.hubs WHERE hub_name = 'VDS')
WHERE hub_id IS NULL AND request ~* '(\mddos\w*|\mдудос\w*|\mддос\w*|\mdos\w*|\mдосс\w*|\mдоос\w*|\mдос\w*|\md o s\w*|\mдедос\w*|\mдидос\w*|\mдодос\w*|\mдудокс\w*|\mdoss\w*|\mдудоса\w*|\mд дос\w*|\mддс\w*|\mмдос\w*|\mдтос\w*|\mdds\w*|\mdudos\w*|\mдэдос\w*|\mdoc\w*|\mdo dos\w*|\mдосить\w*|\mддосить\w*|\mдоус\w*|\mотказ в обслуживании\w*|\mддосить\w*|\mдудосить\w*|\mзаддосить\w*|\mзадудосить\w*)' AND request ~* '\mvds\w*';

UPDATE common.requests SET hub_id = (SELECT hub_id FROM common.hubs WHERE hub_name = 'DS / Дедик / Выделенный')
WHERE hub_id IS NULL AND request ~* '(\mddos\w*|\mдудос\w*|\mддос\w*|\mdos\w*|\mдосс\w*|\mдоос\w*|\mдос\w*|\md o s\w*|\mдедос\w*|\mдидос\w*|\mдодос\w*|\mдудокс\w*|\mdoss\w*|\mдудоса\w*|\mд дос\w*|\mддс\w*|\mмдос\w*|\mдтос\w*|\mdds\w*|\mdudos\w*|\mдэдос\w*|\mdoc\w*|\mdo dos\w*|\mдосить\w*|\mддосить\w*|\mдоус\w*|\mотказ в обслуживании\w*|\mддосить\w*|\mдудосить\w*|\mзаддосить\w*|\mзадудосить\w*)' AND request ~* '(\mсервер\w*|\mserver\w*)';

-- Приоритет 2: ddos без уточнения продукта -> хаб 'DDoS'.
UPDATE common.requests SET hub_id = (SELECT hub_id FROM common.hubs WHERE hub_name = 'DDoS')
WHERE hub_id IS NULL AND request ~* '(\mddos\w*|\mдудос\w*|\mддос\w*|\mdos\w*|\mдосс\w*|\mдоос\w*|\mдос\w*|\md o s\w*|\mдедос\w*|\mдидос\w*|\mдодос\w*|\mдудокс\w*|\mdoss\w*|\mдудоса\w*|\mд дос\w*|\mддс\w*|\mмдос\w*|\mдтос\w*|\mdds\w*|\mdudos\w*|\mдэдос\w*|\mdoc\w*|\mdo dos\w*|\mдосить\w*|\mддосить\w*|\mдоус\w*|\mотказ в обслуживании\w*|\mддосить\w*|\mдудосить\w*|\mзаддосить\w*|\mзадудосить\w*)';

COMMIT;
