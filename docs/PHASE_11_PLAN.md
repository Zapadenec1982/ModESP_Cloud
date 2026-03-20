# Phase 11: Platform Hardening & Compliance — Implementation Plan

> Generated: 2026-03-15 | Updated: 2026-03-15 (post-research revision)
> Based on competitor research (Danfoss, Dixell, Carel, ThingsBoard) and standards analysis (HACCP, NIST 800-63B, ISA-18.2, OWASP)

---

## Overview

| Sub-phase | Feature | Effort | Files Changed |
|-----------|---------|--------|---------------|
| **11a** | Events API & Activity Log | ~3h | 5 new/modified |
| **11b** | HACCP Data Export (CSV + PDF) | ~8h | 6 new/modified |
| **11c** | Password Change UI + NIST Policy | ~4h | 6 new/modified |
| **11d** | Alarm Severity Classification | ~4h | 6 modified |

**Total estimated effort: ~19 hours**

---

## 11a: Events API & Device Activity Log

### Problem
Events table (compressor on/off, defrost, online/offline) receives ~150 records/day/device, but **no endpoint exists to read them**. This is "dead data" — valuable diagnostics invisible to technicians.

### Implementation

#### 1. Backend Route: `backend/src/routes/events.js` (NEW)

**Per-device only** — fleet-wide endpoint відкладено (низький ROI: технік завжди дивиться конкретний пристрій, а 150 events/day × N devices = шум без контексту).

```js
'use strict';
const { Router } = require('express');
const db = require('../services/db');
const { checkDeviceAccess } = require('../middleware/device-access');
const router = Router();

// GET /api/devices/:id/events — per-device events
router.get('/:id/events', checkDeviceAccess(), async (req, res, next) => {
  // Resolve device (UUID vs mqtt_device_id)
  // Params: event_type, from, to, limit (default 50, max 200), offset
  // SQL: SELECT id, event_type, payload, time FROM events
  //      WHERE tenant_id = $1 AND device_id = $2 ORDER BY time DESC
});

module.exports = router;
```

#### 2. Route Mounting: `backend/src/index.js`

```js
app.use('/api/devices', require('./routes/events'));   // /:id/events
```

#### 3. API Client: `webui/src/lib/api.js`

```js
export function getDeviceEvents(deviceId, { event_type, from, to, limit } = {}) {
  const params = new URLSearchParams();
  if (event_type) params.set('event_type', event_type);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (limit) params.set('limit', limit);
  const qs = params.toString();
  return request(`/devices/${deviceId}/events${qs ? '?' + qs : ''}`);
}
```

#### 4. Events on Chart: Chart Overlay (замість окремого таба)

> **Рішення:** Не додаємо 6-й таб — це UX clutter. Використовуємо існуючий `bandPlugin` паттерн в `TelemetryChart.svelte` для overlay маркерів подій на графіку телеметрії.

**Існуючий паттерн** (вже працює для compressor/defrost shaded regions):
```js
// TelemetryChart.svelte — bandPlugin використовує drawSeries hook + ctx.fillRect()
// Ми додаємо аналогічний eventsPlugin:
function eventsPlugin(events) {
  return {
    hooks: {
      drawClear: (u) => {
        // drawClear рендерить ЗА даними (background layer)
        // Вертикальні лінії для online/offline з легендою
        for (const ev of events) {
          const x = u.valToPos(ev.time / 1000, 'x', true);
          u.ctx.strokeStyle = ev.type === 'device_online' ? '#22c55e' : '#ef4444';
          u.ctx.setLineDash([4, 4]);
          u.ctx.beginPath();
          u.ctx.moveTo(x, u.bbox.top);
          u.ctx.lineTo(x, u.bbox.top + u.bbox.height);
          u.ctx.stroke();
          u.ctx.setLineDash([]);
        }
      }
    }
  };
}
```

**Що показуємо на графіку:**
- Online/offline — зелена/червона пунктирна вертикальна лінія
- Compressor/defrost — вже є через `bandPlugin` (shaded regions)

**Fallback таблиця** для non-chart подій (або коли потрібен повний список):
- Простий компонент `EventHistory.svelte` — модалка або expandable section під графіком
- Таблиця: Time, Type (badge), Details — як в `AlarmHistory.svelte`

#### 5. Integration in DeviceDetail: `webui/src/pages/DeviceDetail.svelte`

```js
// НЕ додаємо новий таб
// Передаємо events дані в TelemetryChart як prop:
<TelemetryChart {deviceId} events={deviceEvents} />
// + опціональна кнопка "Show Event Log" під графіком для повного списку
```

#### 6. i18n Keys

**en.js:**
```js
device: { tab_events: 'Events' },
event: {
  history: 'Event History',
  no_events: 'No events recorded',
  col_time: 'Time', col_type: 'Type', col_details: 'Details',
  type_compressor_on: 'Compressor ON', type_compressor_off: 'Compressor OFF',
  type_defrost_start: 'Defrost Start', type_defrost_end: 'Defrost End',
  type_device_online: 'Device Online', type_device_offline: 'Device Offline',
}
```

**uk.js:**
```js
device: { tab_events: 'Події' },
event: {
  history: 'Історія подій',
  no_events: 'Немає записаних подій',
  col_time: 'Час', col_type: 'Тип', col_details: 'Деталі',
  type_compressor_on: 'Компресор увімкнено', type_compressor_off: 'Компресор вимкнено',
  type_defrost_start: 'Початок відтайки', type_defrost_end: 'Кінець відтайки',
  type_device_online: 'Пристрій онлайн', type_device_offline: 'Пристрій офлайн',
}
```

#### 7. No Schema Changes Needed
Events table, index (`idx_events_lookup`), and RLS policy already exist.

#### 8. Events Retention (Cron Cleanup)

Events table може рости необмежено (~150/day/device = ~55k/year/device). Додаємо retention:

```js
// backend/src/services/scheduler.js або cron job
// DELETE FROM events WHERE time < NOW() - INTERVAL '90 days'
// Запускати щоночі через setInterval або node-cron
// 90 днів — достатньо для HACCP (мінімум 30 днів) з запасом
```

**Альтернатива:** PostgreSQL partitioning by month (складніше, але O(1) drop). Відкладаємо до >1M rows.

---

## 11b: HACCP Data Export (CSV + PDF)

### Problem
HACCP обов'язковий в Україні з 2019. Форма 498-10/о вимагає журнал температур. Всі конкуренти мають export. Зараз дані є, але скачати їх неможливо.

### NPM Dependencies

```bash
npm install pdfmake csv-stringify
# pdfmake — Pure JS PDF, no headless browser, ~5MB, <30MB RAM for 10k rows
# csv-stringify — RFC 4180 CSV (~48KB, zero deps), handles commas/quotes/newlines in user text
```

> **⚠️ Чому не ручний CSV:** Manual string building (`value.replace(...)`) — типова помилка. Якщо device name містить кому, лапки або newline, CSV зламається. `csv-stringify` коректно обробляє escaping за RFC 4180.

### Implementation

#### 1. Backend Route: `backend/src/routes/export.js` (NEW)

**CSV Endpoints:**

```
GET /api/devices/:id/telemetry/export.csv
  Middleware: checkDeviceAccess()
  Query: from, to, channels
  Headers: Content-Type: text/csv; charset=utf-8; Content-Disposition: attachment
  Streaming: pg-query-stream → csv-stringify (transform stream pipeline)
  BOM: \uFEFF prefix for Excel Cyrillic compatibility
  Cap: 500k rows max
  Filename: telemetry_{deviceId}_{from}_{to}.csv
  Columns: "Timestamp","Channel","Value"

GET /api/devices/export.csv
  Middleware: filterDeviceAccess()
  Headers: Content-Type: text/csv
  Filename: devices_{tenantSlug}_{date}.csv
  Columns: "Device ID","Name","Location","Serial","Model","Firmware","Online","Last Seen"

GET /api/alarms/export.csv
  Middleware: filterDeviceAccess()
  Query: from, to, active
  Filename: alarms_{tenantSlug}_{from}_{to}.csv
  Columns: "Device","Alarm Code","Severity","Active","Value","Limit","Started","Cleared"
```

**PDF Endpoint (HACCP):**

```
GET /api/devices/:id/telemetry/export.pdf
  Middleware: checkDeviceAccess()
  Query: from, to, channels (default: temperature keys), bucket (default: '1h')
  Headers: Content-Type: application/pdf
  Filename: haccp_report_{deviceName}_{from}_{to}.pdf
```

**PDF Layout:**
```
┌─────────────────────────────────────────────┐
│  ModESP — HACCP Temperature Compliance Log  │
│  Device: Холодильник #3 (F27FCD)            │
│  Location: Склад №2, Київ                   │
│  Serial: SN-12345    Model: ModESP-R1       │
│  Period: 2026-03-01 — 2026-03-15            │
│  Generated: 2026-03-15 by admin@tenant.com  │
├─────────────────────────────────────────────┤
│  SUMMARY                                    │
│  ┌──────────┬──────┬──────┬──────┬────────┐ │
│  │ Channel  │ Min  │ Max  │ Avg  │Samples │ │
│  ├──────────┼──────┼──────┼──────┼────────┤ │
│  │ Air      │-2.1  │ 5.4  │ 2.85 │ 744    │ │
│  │ Evap     │-8.2  │-3.1  │-5.62 │ 744    │ │
│  └──────────┴──────┴──────┴──────┴────────┘ │
├─────────────────────────────────────────────┤
│  ALARMS DURING PERIOD (if any)              │
│  ┌────────────┬───────────┬────┬─────┐      │
│  │ Time       │ Code      │Sev │Value│      │
│  └────────────┴───────────┴────┴─────┘      │
├─────────────────────────────────────────────┤
│  TEMPERATURE LOG (hourly)                   │
│  ┌────────────┬──────┬──────┬──────────┐    │
│  │ Time       │ Air  │ Evap │ Setpoint │    │
│  ├────────────┼──────┼──────┼──────────┤    │
│  │ 03-10 00:00│ 3.20 │-5.10 │ 3.00     │    │
│  │ 03-10 01:00│ 3.15 │-5.22 │ 3.00     │    │
│  │ ...        │      │      │          │    │
│  └────────────┴──────┴──────┴──────────┘    │
├─────────────────────────────────────────────┤
│  Footer: Page N/M — ModESP HACCP Report     │
└─────────────────────────────────────────────┘
```

**Data volume:** 31 days × 1h bucket = 744 rows. 5min bucket = 8,928 rows. Guard: reject >10k rows.

#### 2. Route Mounting: `backend/src/index.js`

```js
app.use('/api/devices', require('./routes/export'));  // telemetry + devices CSV/PDF
app.use('/api/alarms',  require('./routes/export'));  // alarms CSV
```

#### 3. Frontend: Download Helper in `api.js`

> **Підтверджено:** `fetch + blob + createObjectURL` — єдиний правильний підхід для JWT auth.
> `<a href="...">` не працює (не передає Authorization header). Cookie-based auth не використовується.

```js
async function downloadFile(path, filename) {
  const headers = {};
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
  const res = await fetch(`${BASE}${path}`, { headers });
  if (!res.ok) throw new Error(`Export failed: ${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;  a.download = filename;
  document.body.appendChild(a);  a.click();
  a.remove();  URL.revokeObjectURL(url);
}

export function exportTelemetryCsv(deviceId, from, to) { ... }
export function exportTelemetryPdf(deviceId, from, to) { ... }
export function exportAlarmsCsv(from, to) { ... }
export function exportDevicesCsv() { ... }
```

#### 4. Frontend: Export Buttons

**TelemetryChart.svelte** — two buttons (CSV, PDF) in `.chart-header`, use current date range.
**Alarms.svelte** — CSV export button in section header.
**Dashboard** — "Export Devices CSV" button near device filter.

#### 5. Performance & Safety

- **Streaming**: `pg-cursor` for telemetry CSV (500 rows/batch), cap 500k rows
- **Rate limiting**: 10 exports/min/user (separate limiter on export routes)
- **PDF memory**: ~15-30MB peak for 744-row report, well within 256MB VPS
- **PDF fonts**: pdfmake default Roboto **НЕ** містить Cyrillic — потрібна явна реєстрація шрифту

> **⚠️ КРИТИЧНО:** pdfmake за замовчуванням містить Roboto Latin only. Для української потрібно:
> 1. Скачати DejaVu Sans (або Roboto з Cyrillic subset) TTF файли
> 2. Конвертувати через `pdfmake/build/vfs_fonts.js` або завантажити через `vfs`
> ```js
> const fonts = {
>   DejaVuSans: {
>     normal: path.join(__dirname, '../../fonts/DejaVuSans.ttf'),
>     bold: path.join(__dirname, '../../fonts/DejaVuSans-Bold.ttf'),
>   }
> };
> const printer = new PdfPrinter(fonts);
> ```
> 3. Без цього кроку PDF з кирилицею буде порожнім або з квадратиками

---

## 11c: Password Change UI + NIST Password Policy

### Problem
Backend PUT /users/me supports password change, but no UI exists. Password minimum is only 8 chars.

### IMPORTANT DISCOVERY
**`alarmSeverity()` function and `severity` column ALREADY EXIST in the codebase!**
- Backend: `mqtt.js:451-456` has `alarmSeverity(code)` mapping sensor/temp → critical, rest → warning
- DB: `alarms.severity VARCHAR(8) NOT NULL DEFAULT 'warning'` already in schema
- Telegram: `SEVERITY_EMOJI` map exists
- Frontend: `format.js:86-90` has client-side `alarmSeverity()` (different mapping from backend!)

### Implementation

#### 1. HIBP Check: Client-Side (Browser) — NOT Backend

> **Рішення змінено:** HIBP перевірка виконується в браузері, не на сервері.
>
> **Обґрунтування:**
> - HIBP Pwned Passwords API має `Access-Control-Allow-Origin: *` — CORS дозволений
> - k-Anonymity model: в API відправляється лише 5 символів SHA-1 prefix — безпечно
> - Сервер не потребує зовнішнього мережевого виклику для кожної зміни пароля
> - Якщо API недоступний — fail-open (попередження, але дозволяємо)
> - NIST/OWASP рекомендують breach check, але не вимагають server-side

```js
// В ChangePasswordModal.svelte:
async function checkHIBP(password) {
  try {
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-1', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const sha1 = hashArray.map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);

    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { 'Add-Padding': 'true' }
    });
    const text = await res.text();
    const match = text.split('\r\n').find(line => line.startsWith(suffix));
    return match ? parseInt(match.split(':')[1], 10) : 0;
  } catch {
    return 0; // Fail-open: API unreachable → allow password
  }
}
```

#### 2. Backend: Password Policy in `backend/src/routes/users.js`

- `createUserSchema`: `z.string().min(8)` → `z.string().min(15)`
- `updateProfileSchema`: `z.string().min(8)` → `z.string().min(15)`
- **НЕ додаємо HIBP на бекенді** — перевірка на клієнті достатня
- Backend валідує лише довжину (15 chars) — single source of truth

> **Password length: 15 chars (NIST/OWASP aligned)**
> - NIST SP 800-63B Rev 4: мінімум 15 символів без MFA
> - OWASP ASVS 4.0: 15 chars для систем без MFA
> - Для існуючих користувачів: при наступному логіні показати попередження "Ваш пароль коротший за рекомендований мінімум", але НЕ блокувати доступ
> - Міграційна стратегія: м'який перехід, force change через 90 днів (опціонально в майбутньому)

#### 3. Frontend: `webui/src/components/layout/ChangePasswordModal.svelte` (NEW)

- Overlay modal (backdrop + card, use existing CSS vars — модалки вже є в 5+ сторінках)
- Fields: current password, new password, confirm
- Client validation: min 15 chars, passwords match, differs from current
- **HIBP check**: перед submit, async, показує warning з кількістю breaches
- On submit: `changePassword(old, new)` → toast success → close
- Error handling: wrong current (400), too short (400)
- **Fail-open**: якщо HIBP API недоступний — пропускаємо перевірку без помилки

#### 4. Frontend: Trigger in `Sidebar.svelte`

- "Change Password" icon button in `.user-section` (lock icon)
- State: `showPasswordModal = false`
- Render: `<ChangePasswordModal>` conditionally

#### 5. Frontend: API Function in `api.js`

```js
export function changePassword(oldPassword, newPassword) {
  return request('/users/me', {
    method: 'PUT',
    body: JSON.stringify({ old_password: oldPassword, password: newPassword }),
  });
}
```

#### 6. i18n Keys

```
password.change_password / Змінити пароль
password.current_password / Поточний пароль
password.new_password / Новий пароль
password.confirm_password / Підтвердження пароля
password.min_length / Мінімум 15 символів
password.passwords_mismatch / Паролі не збігаються
password.password_breached / Цей пароль знайдено у витоках даних
password.wrong_current / Поточний пароль невірний
password.password_changed / Пароль успішно змінено
```

---

## 11d: Alarm Severity Classification

### Problem
ISA-18.2: alarm fatigue when >10 alarms/10 min. 2/3 BMS operators ignore alerts. Not all alarms are equal, but platform treats them identically for notifications.

### Discovery: Severity Infrastructure ALREADY EXISTS

| Component | Status | Gap |
|-----------|--------|-----|
| `alarms.severity` DB column | ✅ Exists | — |
| Backend `alarmSeverity()` | ✅ Exists (2-tier: critical/warning) | Add `info` tier |
| Frontend `alarmSeverity()` | ⚠️ Different mapping from backend | Should use DB value |
| Badge severity colors | ✅ danger/warning/info variants | — |
| Telegram severity emoji | ✅ Exists | — |
| Severity filter on API | ❌ Missing | Add query param |
| Nuisance alarm delay | ❌ Missing | Add for door/pulldown |
| Push severity filtering | ❌ Missing | Info → admin only |

### Implementation

#### 1. Backend: Expand `alarmSeverity()` in `mqtt.js`

```js
function alarmSeverity(code) {
  if (['sensor1_alarm','sensor2_alarm','high_temp_alarm','low_temp_alarm'].includes(code)) return 'critical';
  if (['rate_alarm','short_cycle_alarm','rapid_cycle_alarm'].includes(code)) return 'info';
  return 'warning';  // door, pulldown, continuous_run
}
// Синхронізувати з frontend format.js (зараз frontend вже має 3-tier, але маппінг відрізняється!)
```

#### 2. Backend: Nuisance Alarm Delay in `mqtt.js`

```js
const pendingAlarms = new Map();  // "deviceId:alarmCode" -> setTimeout handle
const NUISANCE_DELAY = { door_alarm: 120000, pulldown_alarm: 300000 };  // 2min, 5min

// In detectAlarm():
// if value=true AND code in NUISANCE_DELAY → setTimeout, store handle
// if value=false AND pending exists → clearTimeout, skip (transient)
// if value=false AND no pending → proceed with clear logic (confirmed alarm)
// Cleanup in shutdown()
```

#### 3. Backend: Severity Filter in `alarms.js`

```js
if (req.query.severity) {
  const valid = ['critical', 'warning', 'info'];
  const severities = req.query.severity.split(',').filter(s => valid.includes(s));
  if (severities.length > 0) {
    sql += ` AND a.severity = ANY($${idx++})`;
    params.push(severities);
  }
}
```

#### 4. Backend: Push Severity Filter in `push.js`

> **Місце фільтрації:** в `handleAlarm()`, НЕ в `dispatchToLinkedUsers()`.
> `dispatchToLinkedUsers()` — generic dispatcher (використовується і для інших push). Severity logic повинна бути в caller.

```js
// In mqtt.js handleAlarm() — BEFORE calling push.dispatchToLinkedUsers():
if (severity === 'info') {
  // Info alarms → only admin/superadmin get push notifications
  // Technicians/viewers still see them in UI, just no push
  logger.debug({ code, deviceId }, 'info alarm — push to admins only');
}
// Pass severity filter to dispatchToLinkedUsers as option:
await push.dispatchToLinkedUsers(tenantId, deviceId, payload, {
  roleFilter: severity === 'info' ? ['admin', 'superadmin'] : null
});
```

#### 5. Frontend: Use DB Severity in `Alarms.svelte`

Replace `alarmSeverity(alarm.alarm_code)` → `alarm.severity` (already returned by API).

#### 6. Frontend: Severity Filter UI in `Alarms.svelte`

Pill buttons: All / Critical / Warning / Info — filter toggles.

#### 7. One-time SQL Migration + Deploy Order

> **⚠️ DEPLOY ORDER TRAP:** Frontend перехід на `alarm.severity` (з DB) замість `alarmSeverity(code)` (client-side) ПОВИНЕН відбутися ПІСЛЯ оновлення бекенду. Інакше старі записи з `severity='warning'` для rate_alarm/short_cycle/rapid_cycle будуть показані невірно.

**Порядок деплою 11d:**
1. Backend: оновити `alarmSeverity()` → 3-tier (critical/warning/info)
2. SQL migration: оновити історичні записи
3. Frontend: перейти на `alarm.severity` з DB

```sql
-- Оновити історичні записи (3 alarm codes → info)
UPDATE alarms SET severity = 'info'
WHERE alarm_code IN ('rate_alarm', 'short_cycle_alarm', 'rapid_cycle_alarm')
  AND severity = 'warning';
-- Перевірка: SELECT alarm_code, severity, COUNT(*) FROM alarms GROUP BY 1,2 ORDER BY 1;
```

---

## Implementation Sequence

```
Phase 11a: Events API + Chart Overlay    Phase 11c: Password
  ├─ events.js (backend, per-device)       ├─ users.js (min 15)
  ├─ index.js (mount)                      ├─ api.js (changePassword)
  ├─ api.js (getDeviceEvents)              ├─ ChangePasswordModal.svelte (NEW, +HIBP client)
  ├─ TelemetryChart.svelte (overlay)       ├─ Sidebar.svelte (trigger)
  ├─ EventHistory.svelte (optional list)   └─ i18n (en + uk)
  ├─ scheduler.js (retention cron)
  └─ i18n (en + uk)

Phase 11b: HACCP Export                  Phase 11d: Alarm Severity
  ├─ npm install pdfmake csv-stringify     ├─ mqtt.js (3-tier + delay)
  ├─ fonts/ (DejaVu Sans TTF)             ├─ mqtt.js handleAlarm() (push filter)
  ├─ export.js (backend, NEW)              ├─ alarms.js (severity param)
  ├─ index.js (mount)                      ├─ format.js (sync mapping)
  ├─ api.js (downloadFile + exports)       ├─ Alarms.svelte (DB severity + filter UI)
  ├─ TelemetryChart.svelte (buttons)       └─ SQL migration (3 codes → info)
  ├─ Alarms.svelte (button)               ⚠️ Deploy: backend → SQL → frontend
  └─ i18n (en + uk)
```

**Recommended order:** 11a → 11d → 11c → 11b (simplest first, export last as it needs pdfmake + fonts)

---

## Files Summary

### New Files (4)
| File | Description |
|------|-------------|
| `backend/src/routes/events.js` | Events REST API (per-device only) |
| `backend/src/routes/export.js` | CSV/PDF export endpoints |
| `webui/src/components/EventHistory.svelte` | Events list component (expandable under chart) |
| `webui/src/components/layout/ChangePasswordModal.svelte` | Password change modal + HIBP client-side check |

### New Assets (2)
| File | Description |
|------|-------------|
| `backend/fonts/DejaVuSans.ttf` | Cyrillic font for PDF generation |
| `backend/fonts/DejaVuSans-Bold.ttf` | Cyrillic bold font for PDF generation |

### Modified Files (12)
| File | Changes |
|------|---------|
| `backend/src/index.js` | Mount events + export routes |
| `backend/src/services/mqtt.js` | 3-tier severity, nuisance delay, push severity filter in handleAlarm() |
| `backend/src/services/push.js` | Accept roleFilter option in dispatchToLinkedUsers() |
| `backend/src/routes/users.js` | Password min 15 |
| `backend/src/routes/alarms.js` | Severity filter param |
| `webui/src/lib/api.js` | Events, export, password API functions |
| `webui/src/lib/format.js` | Sync alarmSeverity mapping with backend |
| `webui/src/pages/DeviceDetail.svelte` | Pass events to TelemetryChart |
| `webui/src/pages/Alarms.svelte` | DB severity, filter UI, export button |
| `webui/src/components/TelemetryChart.svelte` | Events overlay (drawClear hook) + CSV/PDF export buttons |
| `webui/src/lib/locales/en.js` | New i18n keys |
| `webui/src/lib/locales/uk.js` | New i18n keys |

### Optional
| File | Changes |
|------|---------|
| `webui/src/pages/Dashboard.svelte` | Devices CSV export button |
| `backend/src/services/scheduler.js` | Events retention cron (DELETE > 90 days) |

---

## Research Notes (post-analysis)

### Ключові зміни після дослідження:
1. **Events: chart overlay замість 6-го таба** — uPlot drawClear hook для фонових маркерів, існуючий bandPlugin паттерн
2. **Events: per-device only** — fleet endpoint відкладено (низький ROI для техніків)
3. **CSV: csv-stringify замість ручного** — RFC 4180 compliance, escaping commas/quotes/newlines
4. **PDF: DejaVu Sans explicit** — pdfmake default Roboto НЕ містить Cyrillic
5. **Download: fetch+blob підтверджено** — єдиний підхід для JWT auth
6. **Password: 15 chars (NIST/OWASP)** — з м'якою міграцією для існуючих користувачів
7. **HIBP: client-side в Svelte** — CORS enabled, Web Crypto API, fail-open
8. **Alarm severity: deploy backend FIRST** — інакше frontend покаже старі severity з DB
9. **Push filter: в handleAlarm()** — не в generic dispatcher
10. **Events retention: 90-day cleanup** — cron або scheduled DELETE
