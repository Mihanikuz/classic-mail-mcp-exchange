# Exchange (EWS) и claude.ai: развёртывание

Этот форк добавляет к [kapitelh/classic-mail-mcp](https://github.com/kapitelh/classic-mail-mcp) две вещи:

1. **Подключение к claude.ai** как кастомного коннектора (веб, Desktop, мобильное приложение) через OAuth со входом Google.
2. **Модуль Microsoft Exchange (EWS) только для чтения** для ящиков, где IMAP выключен или закрыт извне, но работает Outlook (Exchange Web Services по HTTPS).

Всё остальное — модель безопасности, мастер настройки, режимы запуска — как в оригинальном проекте. Общие инструкции: [deployment.md](deployment.md), [security.md](security.md).

## Что изменено по сравнению с оригиналом

| Файл                | Изменение                                                                                                                                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/auth.ts`       | В список разрешённых адресов возврата OAuth добавлен `https://claude.ai/api/mcp/auth_callback`. Параметр `resource` принимается и в виде `BASE_URL`, и в виде `BASE_URL/mcp`, как его отправляют клиенты MCP.                 |
| `src/server.ts`     | Разрешён Origin `https://claude.ai`. В CSP `form-action` добавлен `https://accounts.google.com`, иначе Chrome блокирует переход к Google после нажатия Approve на странице согласия. Выбор модуля почты через `MAIL_BACKEND`. |
| `src/ews.ts`        | Новый модуль EWS: папки, поиск, чтение, вложения, проверка соединения. В нём нет ни одной операции записи.                                                                                                                    |
| `compose.yaml`      | Исправлен `tmpfs` (новые версии Docker Compose падали с ошибкой `invalid mount path: 'mode=1777'`), добавлена переменная `MAIL_BACKEND`.                                                                                      |
| `tests/ews.test.ts` | Тесты EWS на имитированных ответах Exchange, включая постраничную выдачу со смешанными типами элементов.                                                                                                                      |

## Модуль EWS

- Включается при `MAIL_BACKEND=ews` **и** `ACCESS_MODE=read-only`. В режиме `read-write` всегда используется исходный модуль IMAP/SMTP, поэтому случайно получить запись через EWS нельзя.
- Адрес EWS строится из `imapHost` учётной записи: `https://<imapHost>/EWS/Exchange.asmx`. Сертификат сервера проверяется, перенаправления запрещены.
- Авторизация Basic (логин и пароль из конфигурации). Поля SMTP мастер настройки всё равно спрашивает: укажите тот же хост, они не используются.
- Письма при чтении не помечаются прочитанными (`GetItem` не меняет `IsRead`). Текст и вложения извлекаются из MIME-содержимого письма тем же парсером, что и в IMAP-модуле, с теми же лимитами: письмо до 8 МиБ, вложение до 4 МиБ.
- Папки задаются путём из `list_folders` (`Входящие/Проект`) или как `INBOX`. В поиске `nextBeforeUid` означает смещение для следующей страницы.
- Фильтры по дате, прочтению, теме и тексту выполняет Exchange. Фильтры по отправителю и получателю применяются уже к результатам (просматривается до 1000 писем за запрос).

Проверить, что EWS доступен и пароль подходит, можно ещё до установки. Ответ `401` на запрос без пароля означает, что сервис есть:

```sh
curl -s -o /dev/null -w "%{http_code}\n" https://mail.example.com/EWS/Exchange.asmx
```

## Установка

Нужны Linux-сервер с Docker, домен с HTTPS на **порту 443** (claude.ai не подключается к нестандартным портам) и Google-аккаунт для входа.

### 1. OAuth-клиент Google

В Google Cloud Console → Google Auth Platform:

- Создайте клиент типа **Web application**.
- Redirect URI: `https://mcp.example.com/oauth/callback`.
- Если приложение в режиме тестирования, добавьте свой Google-аккаунт в тестовые пользователи.
- Ключ клиента никому не пересылайте: он вводится только в мастер настройки на сервере.

### 2. Конфигурация

```sh
git clone https://github.com/<you>/<this-repo>.git /opt/classic-mail-mcp
cd /opt/classic-mail-mcp
python3 scripts/setup.py --mode oauth
```

Ответы мастеру настройки для Exchange: IMAP hostname — почтовый хост Exchange (тот, на котором `/EWS/Exchange.asmx`), порт 993, SMTP — тот же хост, порт 465.

Затем `.env`:

```sh
cat >> .env <<'EOF'
BASE_URL=https://mcp.example.com
MAIL_BACKEND=ews
EOF
# Не запускайте контейнер от root
sed -i 's/^LOCAL_UID=0/LOCAL_UID=1000/; s/^LOCAL_GID=0/LOCAL_GID=1000/' .env
chown -R 1000:1000 .secrets .data
docker compose up --build -d
```

Проверка:

```sh
curl -s http://127.0.0.1:8080/status          # "accessMode":"read-only"
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:8080/mcp   # 401
```

### 3. HTTPS на 443

Если порт 443 свободен, проще всего поставить Caddy:

```caddyfile
mcp.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

#### Если 443 занят прокси Telegram (MTProto с маскировкой)

Прокси MTProto с маскировкой (`mask = true`) отдаёт всё, что не похоже на Telegram, на «маскировочный» nginx (обычно `127.0.0.1:8443`). В этот nginx можно добавить второй сайт по имени домена (SNI). Маскировка останется сайтом по умолчанию, прокси работать не перестанет.

1. Сертификат получает Caddy на свободном порту (проверка через порт 80; способ TLS-ALPN отключён, потому что 443 занят):

   ```caddyfile
   mcp.example.com:9443 {
       tls {
           issuer acme {
               disable_tlsalpn_challenge
           }
       }
       reverse_proxy 127.0.0.1:8080
   }
   ```

2. Сайт для nginx. Имя файла начинается с `zz-`, чтобы он не стал сайтом по умолчанию:

   ```nginx
   # /etc/nginx/sites-available/zz-mail-mcp
   server {
       listen 127.0.0.1:8443 ssl;
       server_name mcp.example.com;
       ssl_certificate     /var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/mcp.example.com/mcp.example.com.crt;
       ssl_certificate_key /var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/mcp.example.com/mcp.example.com.key;
       ssl_protocols TLSv1.2 TLSv1.3;
       location / {
           proxy_pass http://127.0.0.1:8080;
           proxy_http_version 1.1;
           proxy_set_header Host $host;
           proxy_set_header X-Forwarded-Proto https;
           proxy_buffering off;
           proxy_read_timeout 180s;
           proxy_send_timeout 180s;
       }
   }
   ```

   ```sh
   ln -s /etc/nginx/sites-available/zz-mail-mcp /etc/nginx/sites-enabled/
   nginx -t && systemctl reload nginx
   # nginx перечитывает сертификат только при перезагрузке; Caddy продлевает его сам
   echo '0 4 * * 1 root systemctl reload nginx' > /etc/cron.d/reload-nginx-cert
   ```

3. Проверьте, что маскировка не сломалась:

   ```sh
   curl -sk --resolve <mask-domain>:443:127.0.0.1 https://<mask-domain>/ | head -c 150
   ```

### 4. Коннектор в claude.ai

Настройки → Коннекторы → **Add custom connector** → URL `https://mcp.example.com/mcp`. Поля Client ID и Secret оставьте пустыми: сервер поддерживает динамическую регистрацию клиентов. Дальше **Connect** → страница согласия сервера → **Approve** → вход тем Google-аккаунтом, который указан в мастере настройки.

## Частые проблемы

| Симптом                                                                                    | Причина и решение                                                              |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `invalid mount path: 'mode=1777'` при `docker compose up`                                  | Старый `compose.yaml`; в этом форке исправлено.                                |
| `listen tcp :8443: bind: address already in use` у Caddy                                   | Порт занят маскировочным nginx прокси MTProto; возьмите другой порт для Caddy. |
| claude.ai: «Couldn't reach this address», в журнале нет запросов с `160.79.104.0/21`       | Нестандартный порт или закрытый файрвол. Нужен 443.                            |
| Approve на странице согласия ничего не делает                                              | Старая CSP `form-action 'self'`; в этом форке исправлено.                      |
| Google: `redirect_uri_mismatch`                                                            | Redirect URI в Google должен ровно совпадать с `BASE_URL/oauth/callback`.      |
| Все инструменты отвечают «Mail operation failed», порт 993 у почтового сервера не отвечает | IMAP закрыт, ящик на Exchange. Включите `MAIL_BACKEND=ews`.                    |

## Безопасность

- Пароль от почты хранится на сервере в `.secrets/config.json` (права 600). Защищайте сам сервер: вход по SSH только по ключу, без пароля.
- Доступ к почте получает любой, кто войдёт в разрешённый Google-аккаунт или в аккаунт claude.ai с подключённым коннектором. Включите двухфакторную аутентификацию в обоих.
- Если это рабочая почта, сначала убедитесь, что правила ИБ компании разрешают такое подключение.
- Код EWS-модуля и правки для claude.ai покрыты тестами, но независимого аудита безопасности не было.
