# ASIQPAI — сервер проверки оплаты

Этот backend:

1. Проверяет подпись `Telegram.WebApp.initData`.
2. Создаёт уникальный заказ и комментарий.
3. Передаёт Mini App готовый TON payload.
4. Ищет входящую транзакцию через TON Center.
5. Проверяет адрес отправителя, адрес получателя, сумму и комментарий.
6. Не позволяет повторно использовать одну транзакцию.

## 1. Создай PostgreSQL

Подойдёт Render PostgreSQL или Supabase. Скопируй строку подключения в `DATABASE_URL`.

## 2. Получи переменные

- `BOT_TOKEN` — токен Telegram-бота от BotFather.
- `TONCENTER_API_KEY` — ключ TON Center.
- `MERCHANT_WALLET` — твой адрес для получения оплаты.
- `FRONTEND_ORIGIN=https://qaztrap.github.io`
- Остальные значения уже указаны в `.env.example`.

Никогда не добавляй настоящий `.env` в GitHub.

## 3. Локальный запуск

```bash
npm install
cp .env.example .env
npm start
```

Проверка:

```text
http://localhost:3000/health
```

## 4. Развёртывание на Render

1. Создай отдельный GitHub-репозиторий для этой папки.
2. В Render выбери **New → Web Service**.
3. Build Command: `npm install`
4. Start Command: `npm start`
5. Добавь все переменные окружения из `.env.example`.
6. После запуска получишь адрес вида:
   `https://asiqpai-api.onrender.com`

## 5. Подключение Mini App

В файле `index_server_payment.html` замени:

```js
const API_URL = "https://YOUR-BACKEND.onrender.com";
```

на адрес своего Render-сервера.

## Важное ограничение текущего этапа

Сервер надёжно подтверждает оплату, но обычные GP от тапов пока хранятся в `localStorage`.
Следующий этап — перенести весь баланс GP и Gold License в PostgreSQL.

## Обновление: серверный профиль и GP

В этой версии backend автоматически создаёт таблицу `users` и пользователя при первом подтверждённом запросе из Telegram Mini App.

### Новый endpoint

```http
GET /api/me
X-Telegram-Init-Data: <Telegram.WebApp.initData>
```

Пример ответа:

```json
{
  "ok": true,
  "user": {
    "telegramId": "123456789",
    "username": "asiqpai",
    "firstName": "User",
    "gp": "100000",
    "goldLicense": false
  }
}
```

`gp` и `telegramId` возвращаются строками, чтобы JavaScript не потерял точность больших чисел.

После подтверждения TON-платежа GP начисляются в PostgreSQL атомарно вместе с отметкой `credited_at`. Повторная проверка одного заказа не должна повторно начислять награду.
