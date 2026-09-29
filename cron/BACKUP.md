# Бэкап VDS

Настроен 2026-09-29. Скрипт: [weekly-backup.sh](weekly-backup.sh). Запуск — cron **от root**,
воскресенье 03:00, лог `logs/system/backup.log`.

## Что делает

Каждый запуск создаёт в `/var/backups/api-automation` (вне проекта, чтобы архив проекта не тащил
прошлые бэкапы) три файла и выгружает их в Yandex Object Storage:

| Файл | Содержимое | Размер на 2026-09-29 |
|---|---|---|
| `db_ГГГГММДД_ЧЧММ.dump` | `pg_dump -Fc` всей БД (сжат) | ~30 МБ |
| `config_*.tar.gz` | `.env`, `config/`, `tokens/`, `keys/` (права 600) | ~5 КБ |
| `project_*.tar.gz` | проект без `node_modules`, `logs`, `backups` | ~19 МБ |

- **Ротация:** файлы старше `BACKUP_RETENTION_DAYS` (56 дней = 8 недель) удаляются локально и
  в бакете (`rclone delete --min-age`). Чистятся только файлы по маскам `db_*`, `config_*`,
  `project_*`, чужое не трогается.
- **Ротация пропускается, если текущий запуск завершился с ошибкой** — чтобы серия сбоев не
  оставила без копий.
- Файлы пишутся во временный `*.tmp` и переименовываются только после успеха.
- При ошибке — сообщение в Telegram (`TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` из `.env`).
- Страховка в самом бакете: правило жизненного цикла «удалить через 56 дней» (на случай, если
  rclone на VDS сломается и перестанет чистить).

## Настройки (`.env`, все опциональны кроме rclone)

```
BACKUP_RCLONE_REMOTE=yc:ddg-api-automation-backup/api-automation   # без него внешняя копия не делается
BACKUP_DIR=/var/backups/api-automation                            # по умолчанию
BACKUP_RETENTION_DAYS=56                                          # по умолчанию
```

`.env` скрипт читает построчно (только нужные ключи), а не через `source`: в нём есть значения
с `|`, `;`, `<>`, которые shell ломают.

## Yandex Cloud: как настроено

- **Бакет** `ddg-api-automation-backup`, регион `ru-central1`, доступ **ограниченный** (в
  бэкапе лежит `.env` с секретами), класс хранилища — холодное, максимальный размер — квота
  с запасом (платим за занятое, не за лимит; оценка: (дамп + 5 МБ) × 9 × 1,5).
- **Сервисный аккаунт** с ролью `storage.editor` (нужна, чтобы rclone мог удалять старые файлы).
- **Статический ключ доступа** сервисного аккаунта; секрет показывается один раз — хранится
  в менеджере паролей.
- **Жизненный цикл бакета:** удалять объекты через 56 дней.
- **KMS не используется:** бакет приватный, KMS добавляет расходы, роль
  `kms.keys.encrypterDecrypter` и риск потерять все бэкапы при потере ключа. Если понадобится
  шифрование от самого облака — `rclone crypt` поверх `yc:` (ключ хранится у нас, не в облаке).
- **rclone на VDS** — remote `yc`, тип `s3`, provider `Other`, region `ru-central1`,
  endpoint `https://storage.yandexcloud.net`. Конфиг лежит в `/root/.config/rclone/rclone.conf`.

## Установка на новом VDS

```bash
apt install postgresql-client                     # pg_dump
curl https://rclone.org/install.sh | sudo bash
sudo rclone config                                # remote yc, см. выше (от root!)
printf '\nBACKUP_RCLONE_REMOTE=yc:ddg-api-automation-backup/api-automation\n' | sudo tee -a /opt/api-automation/.env
sudo mkdir -p /opt/api-automation/logs/system
sudo bash /opt/api-automation/cron/weekly-backup.sh          # пробный запуск
sudo rclone ls yc:ddg-api-automation-backup/api-automation   # три свежих файла
(sudo crontab -l 2>/dev/null; echo '0 3 * * 0 /opt/api-automation/cron/weekly-backup.sh >> /opt/api-automation/logs/system/backup.log 2>&1') | sudo crontab -
```

## Восстановление

```bash
sudo rclone copy yc:ddg-api-automation-backup/api-automation/db_ГГГГММДД_ЧЧММ.dump /tmp/
pg_restore -l /tmp/db_*.dump                                    # просмотр содержимого
pg_restore -d <база> --clean --if-exists /tmp/db_*.dump         # восстановление
```
Раз в квартал стоит проверять, что дамп реально восстанавливается (лучше в тестовую базу).

## Грабли (поймали при настройке)

- **Запускать только от root.** `/var/backups` пишет только root; под обычным пользователем —
  `Permission denied`.
- **rclone-конфиг per-user.** `rclone config` под `tori` создаёт `~tori/.config/rclone/`, root
  его не видит (`didn't find section ("yc")`). Конфиг должен быть в `/root/.config/rclone/`
  (или скопировать: `cp /home/tori/.config/rclone/rclone.conf /root/.config/rclone/`, `chmod 600`).
- **Строка `BACKUP_RCLONE_REMOTE` не попала в `.env`** — скрипт молча пропускает выгрузку
  (`BACKUP_RCLONE_REMOTE не задан`). Проверка: `grep BACKUP /opt/api-automation/.env`. Добавлять
  через `printf '\n...'`, если файл может не заканчиваться переводом строки (иначе строка
  приклеится к предыдущей).
- **`crontab -e` в консоли может «зациклиться»** на сохранении — добавляйте строку one-liner'ом
  (см. «Установка»). Не запускать его дважды — задублирует задачу.
- `cron/weekly-maintenance.sh`: строка `cp config/*.json backups/config_backup_$(date +%Y%m%d)/`
  не создаёт целевую папку и, скорее всего, падает; новый бэкап её покрывает, но саму строку
  не правили.
