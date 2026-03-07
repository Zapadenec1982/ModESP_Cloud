# ModESP Cloud

**Хмарна платформа для централізованого управління парком ModESP контролерів**

---

## Що це таке

ModESP Cloud — серверна інфраструктура яка перетворює окремі ESP32 контролери
в єдину керовану систему. Забезпечує віддалений моніторинг, push сповіщення про
аварії, управління користувачами і доступом, збереження і аналіз телеметрії.

**Зв'язаний проект:** `D:\ModESP_v4` — прошивка ESP32 контролерів

---

## Архітектура

```
ESP32 (ModESP_v4)
    │
    │ MQTT over TLS
    ▼
Mosquitto Broker (VPS)
    │
    ▼
Node.js Backend
├── MQTT Listener       → приймає події від пристроїв
├── WebSocket Server    → real-time до браузера
├── REST API            → для WebUI і зовнішніх інтеграцій
├── Push Service        → FCM + Telegram
└── Auth Service        → JWT авторизація
    │
    ├── PostgreSQL       → пристрої, користувачі, аварії, телеметрія
    │
    └── Svelte WebUI     → хмарний дашборд (окремий від ESP32 WebUI)

Nginx → термінація HTTPS, роздача статики
```

---

## Структура репозиторію

```
ModESP_Cloud/
├── README.md
├── docs/
│   ├── ARCHITECTURE.md      # Детальна архітектура системи
│   ├── MQTT_PROTOCOL.md     # MQTT топіки, формати повідомлень, версіонування
│   ├── API_REFERENCE.md     # REST API endpoints
│   ├── DATABASE.md          # Схема БД, партиціонування, індекси
│   ├── DEPLOYMENT.md        # Розгортання на VPS
│   └── ROADMAP.md           # Фази розробки
├── backend/                 # Node.js сервіс (TODO)
├── webui/                   # Svelte хмарний дашборд (TODO)
└── infra/                   # Nginx конфіг, systemd юніти, скрипти (TODO)
```

---

## Стек

| Компонент | Технологія |
|-----------|-----------|
| MQTT Брокер | Mosquitto |
| Бекенд | Node.js |
| База даних | PostgreSQL + партиціонування (майбутнє: TimescaleDB) |
| WebUI | Svelte 4 |
| Reverse proxy | Nginx |
| Push (мобільні) | Firebase FCM |
| Push (месенджер) | Telegram Bot |
| Авторизація | JWT |
| Хостинг | VPS Ubuntu 24 LTS |

---

## Поточний статус

**Фаза: Документація і проектування архітектури**

- [x] Структура репозиторію
- [x] Документація архітектури
- [x] MQTT протокол і версіонування
- [x] Схема бази даних
- [ ] Backend: Node.js сервіс
- [ ] WebUI: Svelte дашборд
- [ ] Infra: VPS налаштування

---

## Changelog

- 2026-03-07 — Створено репозиторій. Базова структура і документація.
