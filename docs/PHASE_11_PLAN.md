# Phase 11: Platform Hardening & Compliance — Implementation Plan

> Generated: 2026-03-15 | Based on competitor research (Danfoss, Dixell, Carel, ThingsBoard) and standards analysis (HACCP, NIST 800-63B, ISA-18.2, OWASP)

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

Follow `alarms.js` pattern exactly (dual-mount, tenant scoping, RBAC):

```js
'use strict';
const { Router } = require('express');
const db = require('../services/db');
const { filterDeviceAccess, checkDeviceAccess } = require('../middleware/device-access');
const router = Router();

// GET /api/events — fleet-wide events list
router.get('/', filterDeviceAccess(), async (req, res, next) => {
  // Params: event_type, from, to, limit (default 50, max 200), offset
  // Superadmin: no tenant_id filter, JOIN devices + tenants
  // Regular: filter by req.tenantId + req.deviceMqttIds (RBAC)
  // SQL: SELECT e.id, e.device_id, e.event_type, e.payload, e.time,
  //             d.name AS device_name FROM events e LEFT JOIN devices d ...
  // ORDER BY e.time DESC LIMIT $N OFFSET $N
});

// GET /api/devices/:id/events — per-device events
router.get('/:id/events', checkDeviceAccess(), async (req, res, next) => {
  // Resolve device (UUID vs mqtt_device_id)
  // Params: event_type, from, to, limit, offset
  // SQL: SELECT id, event_type, payload, time FROM events
  //      WHERE tenant_id = $1 AND device_id = $2 ORDER BY time DESC
});

module.exports = router;
```

#### 2. Route Mounting: `backend/src/index.js`

```js
app.use('/api/events',  require('./routes/events'));   // fleet-wide
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

#### 4. Component: `webui/src/components/EventHistory.svelte` (NEW)

Model on `AlarmHistory.svelte`:
- Table columns: Time, Type (translated + color badge), Details (payload)
- Color coding: compressor = blue, defrost = amber, online/offline = green/red
- Empty state with hint text
- Default limit: 50 events

#### 5. Tab in DeviceDetail: `webui/src/pages/DeviceDetail.svelte`

```js
// Add to tabs array after 'alarms':
{ id: 'events', label: $t('device.tab_events') }

// Add to template:
{:else if activeTab === 'events'}
  <EventHistory deviceId={resolvedId} />
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

---

## 11b: HACCP Data Export (CSV + PDF)

### Problem
HACCP обов'язковий в Україні з 2019. Форма 498-10/о вимагає журнал температур. Всі конкуренти мають export. Зараз дані є, але скачати їх неможливо.

### NPM Dependencies

```bash
npm install pdfmake   # Pure JS PDF, no headless browser, ~5MB, <30MB RAM for 10k rows
```

No CSV library needed — manual string building + `res.write()` streaming.

### Implementation

#### 1. Backend Route: `backend/src/routes/export.js` (NEW)

**CSV Endpoints:**

```
GET /api/devices/:id/telemetry/export.csv
  Middleware: checkDeviceAccess()
  Query: from, to, channels
  Headers: Content-Type: text/csv; Content-Disposition: attachment
  Streaming: pg-cursor, 500 rows/batch, 500k cap
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
- **PDF fonts**: pdfmake default Roboto covers Cyrillic

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

#### 1. Backend: HIBP Check in `backend/src/services/auth.js`

```js
const crypto = require('crypto');

async function checkPasswordBreach(plain) {
  const sha1 = crypto.createHash('sha1').update(plain).digest('hex').toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  try {
    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { 'Add-Padding': 'true' }
    });
    const text = await res.text();
    const match = text.split('\n').find(line => line.startsWith(suffix));
    if (match) {
      const count = parseInt(match.split(':')[1], 10);
      return { breached: true, count };
    }
    return { breached: false, count: 0 };
  } catch (err) {
    // Fail open — don't block password change if HIBP is unreachable
    return { breached: false, count: 0 };
  }
}
```

#### 2. Backend: Password Policy in `backend/src/routes/users.js`

- `createUserSchema`: `z.string().min(8)` → `z.string().min(15)`
- `updateProfileSchema`: `z.string().min(8)` → `z.string().min(15)`
- After old password verification (line ~132): call `checkPasswordBreach(password)`, return 400 if breached
- Same check in POST `/users` route after schema validation

#### 3. Frontend: `webui/src/components/layout/ChangePasswordModal.svelte` (NEW)

- Overlay modal (backdrop + card, use existing CSS vars)
- Fields: current password, new password, confirm
- Client validation: min 15 chars, passwords match, differs from current
- On submit: `changePassword(old, new)` → toast success → close
- Error handling: wrong current (400), breached (400), too short (400)

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
  if (code === 'rate_alarm') return 'info';
  return 'warning';  // door, pulldown, short_cycle, rapid_cycle, continuous_run
}
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

```js
// In dispatchToLinkedUsers():
if (payload.severity === 'info' && user.role !== 'admin' && user.role !== 'superadmin') continue;
```

#### 5. Frontend: Use DB Severity in `Alarms.svelte`

Replace `alarmSeverity(alarm.alarm_code)` → `alarm.severity` (already returned by API).

#### 6. Frontend: Severity Filter UI in `Alarms.svelte`

Pill buttons: All / Critical / Warning / Info — filter toggles.

#### 7. One-time SQL Migration

```sql
UPDATE alarms SET severity = 'info' WHERE alarm_code = 'rate_alarm' AND severity = 'warning';
```

---

## Implementation Sequence

```
Phase 11a: Events API                    Phase 11c: Password
  ├─ events.js (backend)                   ├─ auth.js (HIBP check)
  ├─ index.js (mount)                      ├─ users.js (min 15)
  ├─ api.js (getDeviceEvents)              ├─ api.js (changePassword)
  ├─ EventHistory.svelte (NEW)             ├─ ChangePasswordModal.svelte (NEW)
  ├─ DeviceDetail.svelte (tab)             ├─ Sidebar.svelte (trigger)
  └─ i18n (en + uk)                        └─ i18n (en + uk)

Phase 11b: HACCP Export                  Phase 11d: Alarm Severity
  ├─ npm install pdfmake                   ├─ mqtt.js (3-tier + delay)
  ├─ export.js (backend, NEW)              ├─ push.js (severity filter)
  ├─ index.js (mount)                      ├─ alarms.js (severity param)
  ├─ api.js (downloadFile + exports)       ├─ format.js (sync mapping)
  ├─ TelemetryChart.svelte (buttons)       ├─ Alarms.svelte (DB severity + filter UI)
  ├─ Alarms.svelte (button)               └─ SQL migration (rate_alarm → info)
  ├─ Dashboard (button)
  └─ i18n (en + uk)
```

**Recommended order:** 11a → 11d → 11c → 11b (simplest first, export last as it needs pdfmake)

---

## Files Summary

### New Files (4)
| File | Description |
|------|-------------|
| `backend/src/routes/events.js` | Events REST API (fleet + per-device) |
| `backend/src/routes/export.js` | CSV/PDF export endpoints |
| `webui/src/components/EventHistory.svelte` | Events tab component |
| `webui/src/components/layout/ChangePasswordModal.svelte` | Password change modal |

### Modified Files (12)
| File | Changes |
|------|---------|
| `backend/src/index.js` | Mount events + export routes |
| `backend/src/services/auth.js` | Add `checkPasswordBreach()` (HIBP) |
| `backend/src/services/mqtt.js` | 3-tier severity, nuisance delay |
| `backend/src/services/push.js` | Severity-aware dispatch |
| `backend/src/routes/users.js` | Password min 15, HIBP check |
| `backend/src/routes/alarms.js` | Severity filter param |
| `webui/src/lib/api.js` | Events, export, password API functions |
| `webui/src/lib/format.js` | Sync alarmSeverity mapping |
| `webui/src/pages/DeviceDetail.svelte` | Events tab |
| `webui/src/pages/Alarms.svelte` | DB severity, filter UI, export button |
| `webui/src/lib/locales/en.js` | New i18n keys |
| `webui/src/lib/locales/uk.js` | New i18n keys |

### Optional
| File | Changes |
|------|---------|
| `webui/src/components/TelemetryChart.svelte` | CSV/PDF export buttons |
| `webui/src/pages/Dashboard.svelte` | Devices CSV export button |
