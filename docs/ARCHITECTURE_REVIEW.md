# ModESP Cloud - Architecture Review

**Date:** 2026-03-31
**Scope:** Full architecture review of ModESP Cloud IoT fleet management platform

---

## 1. Executive Summary

ModESP Cloud is a **production-grade IoT fleet management platform** for refrigeration monitoring (ESP32 controllers). The architecture is well-structured with clear separation of concerns across 4 main layers:

```
ESP32 Devices → MQTT Broker → Node.js Backend → PostgreSQL
                                    ↕
                              Svelte Frontend (SPA)
```

**Overall Assessment: SOLID foundation with specific areas for improvement**

| Category | Rating | Notes |
|----------|--------|-------|
| Architecture Design | ★★★★☆ | Clean layered design, good separation |
| Security | ★★★★★ | Excellent: JWT, bcrypt, TLS, RLS, audit logs |
| Code Quality | ★★★★☆ | Consistent, well-organized |
| Test Coverage | ★★★☆☆ | Backend routes covered; MQTT/WS/frontend untested |
| Scalability | ★★★☆☆ | Single-instance bottleneck; good for <5k devices |
| Configuration | ★★★★★ | All env-driven, no hardcoded secrets |
| Documentation | ★★★★☆ | Comprehensive docs/ folder |

---

## 2. Architecture Overview

### 2.1 Tech Stack

| Component | Technology | Version |
|-----------|-----------|---------|
| Backend | Node.js + Express | Node 22, Express 4.21 |
| Frontend | Svelte (SPA) | Svelte 4.18, Vite 5.4 |
| Database | PostgreSQL | 16 |
| MQTT Broker | Mosquitto + go-auth | 2.x |
| WebSocket | ws | 8.18 |
| Testing | Vitest + Supertest | 3.2 |
| Reverse Proxy | Nginx | + Let's Encrypt |
| CI/CD | GitHub Actions | Node 22, PG 16 |

### 2.2 Project Structure

```
ModESP_Cloud/
├── backend/
│   ├── src/
│   │   ├── config/         # Auth configuration
│   │   ├── db/             # Schema, migrations (17), seed
│   │   ├── middleware/      # Auth, RBAC, device-access, validation
│   │   ├── routes/          # 15 route modules (60+ endpoints)
│   │   ├── services/        # MQTT, WebSocket, Push, OTA, Telegram
│   │   └── index.js         # Entry point
│   └── test/               # 17 test files, 150+ test cases
├── webui/
│   ├── src/
│   │   ├── components/     # UI + domain components
│   │   ├── pages/          # 8 main pages
│   │   ├── lib/            # API client, WS client, stores
│   │   └── styles/         # Global CSS
│   └── vite.config.js
├── infra/                   # Nginx, Mosquitto, systemd, setup
├── docs/                    # Architecture, API, DB, MQTT docs
└── docker-compose.yml       # Dev stack (PG + Mosquitto)
```

### 2.3 Data Flow

```
Device (ESP32)
  │
  ├── MQTT publish → modesp/{tenant}/{deviceId}/state (48 keys)
  ├── MQTT publish → modesp/{tenant}/{deviceId}/alarm
  └── MQTT subscribe → modesp/{tenant}/{deviceId}/cmd
          │
          ▼
  Mosquitto Broker (TLS 8883, go-auth ACL)
          │
          ▼
  Backend MQTT Service (mqtt.js, 1433 lines)
  ├── State aggregation (30s debounce window)
  ├── Alarm detection & nuisance filtering
  ├── Telemetry sampling (5 min interval)
  ├── Device auto-discovery
  └── Backfill ingestion (rate-limited)
          │
          ├── PostgreSQL (INSERT telemetry, alarms, state)
          └── WebSocket broadcast (delta updates)
                  │
                  ▼
          Svelte Frontend
          ├── Real-time dashboard
          ├── Device detail view
          ├── Alarm management
          └── Admin panels
```

---

## 3. Strengths

### 3.1 Security (Excellent)
- **No hardcoded credentials** anywhere in the codebase
- Production guard: `AUTH_ENABLED=false` blocks production start
- JWT secret validation: minimum 32 characters, rejects default value
- bcrypt 12-round password hashing (users + MQTT devices)
- JWT with short-lived access tokens (15 min) + refresh tokens (30 days)
- Refresh tokens stored as SHA-256 hashes in DB
- Rate limiting on auth (50/5min), registration (30/hr), bootstrap (3 burst)
- Helmet security headers with strict CSP
- MQTT TLS 1.2+ with per-device ACL
- Row-Level Security (RLS) policies in PostgreSQL
- Immutable audit logging with DB trigger protection
- Zod schema validation on all inputs

### 3.2 Multi-Tenancy (Thorough)
- Tenant isolation at every layer: MQTT topics, DB queries, API responses, Telegram bot
- Dedicated test suite (`tenant-isolation.test.js`) validates cross-tenant boundaries
- RBAC: superadmin / admin / technician / viewer with per-device M:N access control
- Tenant-scoped refresh tokens

### 3.3 Real-Time Architecture (Well-Designed)
- WebSocket delta broadcasting (only changed keys, not full state)
- 30-second state aggregation to reduce DB writes
- 1-second event batching before INSERT
- Backpressure handling: skips slow clients (>64KB buffer)
- Exponential backoff reconnection on frontend (1s → 30s max)

### 3.4 Configuration Management (Excellent)
- All configuration via environment variables
- `.env.example` with comprehensive documentation
- Separate dev/prod Mosquitto configs
- Docker Compose for local development
- Comprehensive `.gitignore` (certs, env, build artifacts)

### 3.5 Database Design (Solid)
- 15 tables with clear relationships
- Telemetry partitioned by month (RANGE on time)
- Proper indexes on lookup paths
- Migration system (17 migrations)
- Parameterized queries throughout (no SQL injection vectors)
- Batch inserts with ON CONFLICT deduplication

---

## 4. Issues & Recommendations

### 4.1 CRITICAL: Untested Core Services

**Problem:** The two most critical backend services have zero tests:
- `mqtt.js` (1,433 lines) — state sync, alarm detection, telemetry, auto-discovery
- `ws.js` (340 lines) — subscriptions, broadcast, auth handshake

**Also untested:**
- `fcm.js`, `push.js`, `telegram.js`, `webpush.js` — push notifications
- All frontend components (55 files)

**Impact:** Any refactoring or bug fix in MQTT/WS services carries regression risk.

**Recommendation:**
1. Add unit tests for MQTT pure functions (parseTopic, parseScalar, alarm logic)
2. Add integration tests for WS subscribe/broadcast/auth
3. Add Svelte component tests with Vitest + @testing-library/svelte
4. Target: 80% coverage for services/

### 4.2 HIGH: Single-Instance Scalability Bottleneck

**Problem:** WebSocket connections stored in process memory (Map). No clustering support.

```javascript
// ws.js — all connections in-memory
const subscriptions = new Map();  // deviceId → Set<WebSocket>
const globalListeners = new Set();
```

**Impact:** Maximum ~10k concurrent WebSocket connections per server. No horizontal scaling.

**Recommendation:**
1. Add Redis pub/sub adapter for WS message routing
2. Deploy behind sticky-session load balancer
3. Implement distributed subscription tracking
4. **Timeline:** Before scaling beyond 1k concurrent users

### 4.3 HIGH: No Telemetry Retention Policy

**Problem:** Telemetry data grows unbounded. Partitions created 3 months ahead but no cleanup.

**Impact:** At 5k devices × 6 channels × 288 samples/day = **8.6M rows/day** (~260M rows/month).

**Recommendation:**
1. Implement automatic partition cleanup (>12 months)
2. Add downsampling for historical data (1h averages after 30 days)
3. Add systemd timer for partition management (already partially exists)

### 4.4 MEDIUM: Large Export Memory Pressure

**Problem:** Export routes load up to 500k telemetry rows into Node.js memory before streaming.

```javascript
// export.js
SELECT ... FROM telemetry ... LIMIT 500000  // All in memory
```

**Recommendation:** Use PostgreSQL CURSOR or streaming query (`pg-cursor`) for exports.

### 4.5 MEDIUM: WebSocket Token Race Condition

**Problem:** Frontend WS client doesn't share token refresh events with API client. Possible 401 during refresh window.

**Recommendation:** Share token refresh event between `ws.js` and `api.js` on the frontend. Add command queue for messages sent during reconnection.

### 4.6 MEDIUM: No npm audit in CI

**Problem:** CI pipeline runs tests but doesn't check for known vulnerabilities in dependencies.

**Recommendation:** Add `npm audit --audit-level=high` step to GitHub Actions workflow.

### 4.7 LOW: Frontend Memory Leak Potential

**Problem:** WebSocket listeners Map not cleared on reconnect. Old listeners may accumulate.

```javascript
// webui/src/lib/ws.js
const listeners = new Map();  // Not cleared on disconnect
```

**Recommendation:** Clear listeners on page navigation or reconnection.

### 4.8 LOW: No Telemetry Downsampling

**Problem:** Raw telemetry endpoint returns all points (limit 10,000). No automatic downsampling for large time ranges.

**Recommendation:** Add server-side downsampling for ranges >7 days (return hourly averages instead of raw points).

---

## 5. Code Quality Assessment

### 5.1 Positive Patterns
- Consistent naming conventions (camelCase JS, snake_case DB)
- Clean middleware chain: auth → tenant → device-access → route handler
- Structured JSON logging (Pino)
- Zod validation schemas for all API inputs
- Factory pattern in tests for fixture creation
- Clear separation: routes handle HTTP, services handle business logic

### 5.2 Areas for Improvement
- **Global state in mqtt.js:** `stateMap`, `metaMap`, `alarmState` as module-level Maps
  - Makes unit testing difficult (no dependency injection)
  - Consider extracting to a DeviceStateManager class
- **Long functions:** `mqtt.js` has functions >100 lines (handleMessage, handleBackfill)
  - Consider breaking into smaller, testable functions
- **Magic numbers:** Some timing values inline rather than in config
  - `64 * 1024` (WS backpressure), `10` (min keys for full state), etc.
- **TODO/FIXME comments:** Several found indicating incomplete features
  - Should be tracked as GitHub issues

### 5.3 Dependency Health
- 19 backend + 2 frontend production dependencies (minimal, focused)
- All use caret ranges (`^`) — locked via `package-lock.json` + `npm ci`
- No known abandoned/deprecated packages
- Recommendation: Consider `~` (tilde) ranges for critical packages (pg, jsonwebtoken)

---

## 6. Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                        INTERNET                             │
└──────────────┬──────────────────────────┬───────────────────┘
               │                          │
        HTTPS (443)                 MQTTS (8883)
               │                          │
┌──────────────▼──────────┐  ┌────────────▼──────────────────┐
│      Nginx              │  │       Mosquitto               │
│  ┌─────────────────┐    │  │  ┌─────────────────────────┐  │
│  │ Rate Limiting    │    │  │  │ go-auth (PG backend)    │  │
│  │ TLS Termination  │    │  │  │ Dynamic ACL per device  │  │
│  │ Static Files     │    │  │  │ TLS 1.2+               │  │
│  │ gzip Compression │    │  │  └─────────────────────────┘  │
│  └────────┬────────┘    │  └────────────┬──────────────────┘
└───────────┼─────────────┘               │
            │                             │
   ┌────────▼─────────────────────────────▼──────────────────┐
   │                  Node.js Backend (:3000)                │
   │                                                         │
   │  ┌──────────┐  ┌──────────┐  ┌───────────────────────┐ │
   │  │ Express  │  │    WS    │  │     MQTT Client       │ │
   │  │ REST API │  │ Server   │  │                       │ │
   │  │ 15 route │  │ Realtime │  │ • State aggregation   │ │
   │  │ modules  │  │ deltas   │  │ • Alarm detection     │ │
   │  └────┬─────┘  └────┬─────┘  │ • Telemetry sampling  │ │
   │       │              │        │ • Auto-discovery      │ │
   │       │              │        └──────────┬────────────┘ │
   │  ┌────▼──────────────▼───────────────────▼────────────┐ │
   │  │              Services Layer                        │ │
   │  │  Auth │ OTA │ Push │ Telegram │ FCM │ WebPush      │ │
   │  └──────────────────────┬─────────────────────────────┘ │
   └─────────────────────────┼───────────────────────────────┘
                             │
              ┌──────────────▼──────────────┐
              │      PostgreSQL 16          │
              │                             │
              │  15 tables + partitioned    │
              │  telemetry (monthly RANGE)  │
              │  RLS policies               │
              │  Immutable audit log        │
              └─────────────────────────────┘
```

---

## 7. Code Quality Deep Dive

### 7.1 Code Duplication (HIGH)

| Pattern | Occurrences | Files |
|---------|-------------|-------|
| UUID detection `id.length > 8` | 11x | devices.js, telemetry.js, export.js, alarms.js, events.js, device-access.js |
| Device lookup WHERE clause | 8x | devices.js (lines 48-56, 204-217, 305-317, 392-402) |
| Device deletion cascade (6 DELETEs) | 3x | devices.js (pending, single, bulk delete) |
| Tenant/device resolution | 4x | devices.js, export.js, telemetry.js |
| Time range parsing | 3x | telemetry.js, export.js |

**Fix:** Extract shared helpers:
- `utils/validation.js` — `isDeviceUuid(id)`
- `utils/dateUtils.js` — `parseTimeRange(query, maxDays)`
- `routes/devices.js` — consolidate `deleteDevice()` helper

### 7.2 Global State in mqtt.js (HIGH)

5 module-level Maps without encapsulation or size limits:

```
stateMap, deviceRegistry, tenantRegistry, recentAssigns, powerProfiles
```

- **Risk:** Unbounded memory growth for deleted/inactive devices
- `recentAssigns` has no TTL-based cleanup
- State mutations scattered across 40+ functions
- **Fix:** Wrap in `DeviceStateManager` class with max-size limits and LRU eviction

### 7.3 Naming Inconsistencies (MEDIUM)

- `isSuperAdmin` vs `isSuperadmin` — inconsistent casing (11 occurrences)
- `lastSeen` (code) vs `last_seen` (DB) vs `_lastSeen` (stateMap) — 3 conventions
- Middleware factories named as checks: `filterDeviceAccess()`, `checkDeviceAccess()`

### 7.4 Magic Numbers (MEDIUM)

Well-named constants exist for core timings (TELEMETRY_INTERVAL, OFFLINE_THRESHOLD), but many hardcoded values remain:

| Value | Location | Should Be |
|-------|----------|-----------|
| `'100kb'` | index.js:51 | `MAX_BODY_SIZE` |
| `50`, `30` | index.js:82-89 | `RATE_LIMIT_MAX`, `REGISTRATION_LIMIT_MAX` |
| `500000` | export.js:103 | `TELEMETRY_EXPORT_LIMIT` |
| `8` | devices.js:49 (11x) | `MIN_MQTT_ID_LENGTH` |
| `32` | index.js:37 | `JWT_SECRET_MIN_LENGTH` |
| `30` | telegram.js:377 | `TG_HISTORY_PAGE_SIZE` |

### 7.5 Function Complexity (MEDIUM)

| File | Function | Lines | Issue |
|------|----------|-------|-------|
| mqtt.js | `start()` | ~140 | Init + subscriptions + timers — split into 3 |
| devices.js | bulk import handler | ~170 | CSV parse + validate + upsert, 4 nested try/catch |
| devices.js | command handler | ~130 | Validation + routing + error handling |

### 7.6 Memory Management (MEDIUM)

**Good:** Proper shutdown handlers, timer cleanup, connection pooling, event listener cleanup.

**Issues:**
- `stateMap` in mqtt.js — no eviction for offline/deleted devices
- `recentAssigns` — timestamps stored indefinitely
- WebSocket `listeners` Map not cleared on reconnect (frontend)

### 7.7 Error Handling (GOOD)

- Consistent `{ error, message, status }` format (52x `validation_failed`, 45x `not_found`)
- Global Express error handler catches unhandled errors
- Zod validation on all inputs
- **Minor:** Some routes use `res.status(500).json()` directly vs `next(err)` — inconsistent

### 7.8 Quality Scorecard

| Aspect | Score | Notes |
|--------|-------|-------|
| Error Handling | 8/10 | Consistent, standardized |
| Memory Management | 6/10 | Good patterns, unbounded Maps |
| String Safety | 8/10 | Parameterized queries throughout |
| Encapsulation | 5/10 | mqtt.js needs refactoring |
| Naming | 7/10 | Strong overall, minor inconsistencies |
| Code Duplication | 5/10 | UUID check 11x, device lookup 8x |
| Magic Numbers | 6/10 | Core timings named, many hardcoded |
| Function Sizes | 8/10 | Mostly reasonable |
| TODO/FIXME | 10/10 | None found — clean codebase |
| Imports | 7/10 | No guards needed, inconsistent order |

---

## 8. Prioritized Action Items

### Immediate (Sprint 1-2)
1. [ ] Add unit tests for `mqtt.js` pure functions (alarm logic, parsers, state merge)
2. [ ] Extract UUID detection helper — eliminate 11x duplication
3. [ ] Consolidate device deletion cascade — eliminate 3x duplication
4. [ ] Add `npm audit` to CI pipeline
5. [ ] Implement telemetry partition cleanup (systemd timer)

### Short-Term (Sprint 3-4)
6. [ ] Add WebSocket integration tests
7. [ ] Stream large exports (pg-cursor instead of loading 500k rows)
8. [ ] Fix `isSuperAdmin`/`isSuperadmin` casing inconsistency
9. [ ] Extract shared `parseTimeRange()` to utils
10. [ ] Replace magic numbers with named constants
11. [ ] Fix frontend WS listener cleanup on navigation

### Medium-Term (Sprint 5-8)
12. [ ] Refactor mqtt.js: extract `DeviceStateManager` class with bounded Maps
13. [ ] Add Redis pub/sub for WebSocket horizontal scaling
14. [ ] Add frontend component tests (Vitest + @testing-library/svelte)
15. [ ] Add telemetry downsampling for ranges >7 days
16. [ ] Implement secret rotation policy documentation

### Long-Term
17. [ ] Route-based code splitting in frontend
18. [ ] Mobile fallback (HTTP long-polling on WS failure)
19. [ ] Database connection circuit breaker
20. [ ] Multi-region deployment guide

---

## 8. Conclusion

ModESP Cloud has a **strong architectural foundation** for a production IoT platform. Security is excellent, the multi-tenancy model is thorough, and the real-time data pipeline (MQTT → WS) is well-designed.

The main risks are:
1. **Testing gaps** in the most critical services (MQTT, WebSocket)
2. **Code duplication** — UUID check (11x), device deletion (3x), time parsing (3x)
3. **Single-instance scalability** ceiling for WebSocket connections
4. **Unbounded memory growth** in mqtt.js Maps (no eviction for deleted devices)
5. **Unbounded telemetry growth** without retention policy

These are typical growth-stage challenges and are addressable without architectural redesign. The codebase is clean, well-secured, and structured for incremental improvement. No TODO/FIXME debt was found, indicating active maintenance.
