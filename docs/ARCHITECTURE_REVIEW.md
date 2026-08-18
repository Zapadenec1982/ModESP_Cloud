# ModESP Cloud - Architecture Review

**Date:** 2026-03-31
**Scope:** Full architecture review of ModESP Cloud IoT fleet management platform
**Methodology:** Automated multi-agent analysis + deep code-level verification

---

## 1. Executive Summary

ModESP Cloud is a **production-grade IoT fleet management platform** for refrigeration monitoring (ESP32 controllers). The architecture is well-structured with clear separation of concerns across 4 main layers:

```
ESP32 Devices → MQTT Broker → Node.js Backend → PostgreSQL
                                    ↕
                              Svelte Frontend (SPA)
```

**Overall Assessment: Strong engineering with pragmatic trade-offs**

| Category | Rating | Notes |
|----------|--------|-------|
| Architecture Design | ★★★★☆ | Clean layered design, good separation |
| Security | ★★★★★ | Excellent: JWT, bcrypt, TLS, RLS, audit logs |
| Code Quality | ★★★★☆ | Consistent, well-organized, zero TODO debt |
| Test Coverage | ★★★☆☆ | Routes well-covered; core services need attention |
| Scalability | ★★★★☆ | Appropriate for current scale; known growth path |
| Configuration | ★★★★★ | All env-driven, no hardcoded secrets |
| Documentation | ★★★★☆ | Comprehensive docs/ folder |

---

## 2. Architecture Overview

*(tech stack, project structure, data flow diagrams unchanged — see sections above)*

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

### 3.6 Memory Management in mqtt.js (Partially Good)
Deep investigation revealed that **3 of 5 Maps are well-managed:**
- `deviceRegistry` — cleared and reloaded from DB every 60s
- `tenantRegistry` — cleared and reloaded every 60s
- `recentAssigns` — has TTL cleanup (240s, pruned during registry refresh)
- `powerProfiles` — cleared and reloaded every 60s

This is better than the initial review suggested.

---

## 4. Issues & Recommendations (Verified)

### 4.1 MEDIUM-HIGH: Test Coverage Gaps in Core Services

**Initial claim:** "mqtt.js (1433 lines) and ws.js (340 lines) have zero tests"

**Verified finding:** **Partially true but nuanced.**

- `parseTopic()` and `parseScalar()` **ARE tested** in `test_mqtt_logic.js` (19 test cases)
- However, this file runs outside Vitest and is **excluded from CI** (`vitest.config.js` explicitly excludes it)
- Coverage config only tracks `routes/`, `middleware/`, `services/auth.js` — mqtt.js and ws.js are out of scope
- **~1400 lines of mqtt.js** (alarm detection, state sync, telemetry sampling, offline detection) are untested
- **ws.js has zero pure functions** — almost entirely coupled to WebSocket/DB/MQTT, harder to unit test

**What's actually at risk:**
- Alarm detection logic (false positives/negatives for critical refrigeration alarms)
- Tenant isolation in state updates (data leak between tenants if stateMap assignment wrong)
- Event detection (compressor_on/off, defrost cycles) — used for analytics

**What's lower risk than it seems:**
- WebSocket broadcast — failures visible to users immediately
- JWT verification in WS — covered by existing auth tests

**Realistic effort:** ~15-20 hours for meaningful coverage improvement

**Recommendation:**
1. Move `test_mqtt_logic.js` into Vitest framework (30 min, improves CI)
2. Add mqtt.js and ws.js to coverage config
3. Add alarm detection integration tests (highest impact, ~4-5 hours)
4. ws.js: focus on subscribe() RBAC logic, not broadcast plumbing

---

### 4.2 MEDIUM: stateMap Unbounded Growth (Confirmed for 1 of 5 Maps)

**Initial claim:** "5 Maps grow unbounded without cleanup"

**Verified finding:** **Only stateMap is a real concern.** The other 4 Maps are regenerated every 60 seconds from DB (see 3.6).

**stateMap specifics:**
- Entries added when first MQTT message arrives for a device
- Entries removed **only** via `removeDeviceState()` — called on explicit device deletion
- Devices that go **permanently offline stay in stateMap forever** — `offlineDetector()` marks `_online=false` but does NOT remove entries

**Memory impact calculation:**
- Per device: ~10 KB (48 state keys × ~200 bytes + metadata)
- 1,000 devices: ~10 MB (manageable)
- 5,000 devices with 2,000 stale: ~50 MB (noticeable but not critical)

**Mitigating factors:**
- Backend restart rebuilds stateMap from DB (only active devices)
- Production likely has <500 devices currently
- Memory usage is logged every 60s (`stateMapMonitor`)

**Verdict:** Real concern for long-running instances, but **not urgent at current scale**. Simple fix: prune offline devices after 30 days.

---

### 4.3 LOW-MEDIUM: UUID Detection Duplication (Overstated)

**Initial claim:** "UUID detection duplicated 11 times — HIGH priority"

**Verified finding:** **Technically 11 occurrences, but the severity is overstated.**

Breakdown:
- **1 is the definition** (`buildDeviceWhere()` helper at devices.js:49) — not duplication
- **4 in devices.js** should call the existing `buildDeviceWhere()` but don't — **missed refactoring, worth fixing**
- **2 in export.js/telemetry.js** — identical `resolveDevice()` helpers — **should be extracted**
- **3 in alarms.js/events.js/device-access.js** — different enough patterns (field extraction vs WHERE building)
- **1 in reassign handler** — unique single-field pattern

**Verdict:** Worth a ~1 hour cleanup, not a critical issue. The existing `buildDeviceWhere()` helper should be reused in 4 places where it's not. The `resolveDevice()` duplicate should be extracted to a shared utility.

---

### 4.4 LOW-MEDIUM: Device Deletion Cascade (Justified Duplication)

**Initial claim:** "Deletion cascade duplicated 3 times — HIGH"

**Verified finding:** **The SQL is identical, but the surrounding logic is meaningfully different.**

| Aspect | Pending Delete | Single Delete | Bulk Delete |
|--------|---------------|---------------|-------------|
| MQTT Reset | None | Yes (active devices) | None |
| Audit Context | No | Yes | No |
| WebSocket Emit | Yes (pending listeners) | No | No |
| Error Handling | Fail fast | Fail fast | Per-device try/catch |
| Registry Refresh | Immediate | Immediate | Batched after all |

**Verdict:** Extracting the 6-query SQL sequence into a `deleteDeviceData(uuid, mqttId)` helper is reasonable (~30 min fix). But this is **not harmful duplication** — each route has distinct pre/post-deletion behavior. Severity downgraded from HIGH to LOW-MEDIUM.

---

### 4.5 CONTEXT-DEPENDENT: WebSocket Scalability

**Initial claim:** "Single-instance scalability bottleneck — HIGH"

**Verified finding:** **True architecturally, but NOT a problem at current scale.**

- Current deployment: single Hetzner VPS, <500 devices, <100 concurrent users
- Node.js `ws` library handles 10k-50k connections per process
- Backpressure handling is implemented (64KB buffer check)
- Per-device subscription model is efficient (O(subscribers) per broadcast)
- No Redis, no clustering, no sticky sessions — **by deliberate choice**

**At current scale (100 devices, ~50 users):**
- ~100 WS connections × 300 bytes = ~30 KB in-flight — **trivial**

**When it becomes a problem:**
- ~5k concurrent users (unlikely near-term for refrigeration monitoring SaaS)

**Verdict:** **Pragmatic engineering.** Solving this now would be premature optimization. The limitation is already documented in ARCHITECTURE.md. Downgraded from HIGH to informational.

---

### 4.6 MEDIUM: Telemetry Retention (Partially Addressed)

**Initial claim:** "Telemetry grows unbounded — no retention policy"

**Verified finding:** **Retention script EXISTS but is not automatically deployed.**

- `backend/scripts/cleanup-telemetry.js` — drops partitions older than 90 days
- Documented in `DEPLOYMENT.md` as a recommended cron job
- **NOT a systemd timer** (unlike partition creation which IS a timer)
- Requires manual `--apply` flag and cron setup

**Data growth at realistic scale:**
- 100 devices × 7 channels × 5 min intervals = ~480 MB/month
- 500 devices = ~2.4 GB/month
- **Without cleanup at 100 devices: ~5.7 GB/year** — manageable on modern VPS

**Verdict:** The retention mechanism exists, but the deployment gap (no systemd timer, requires manual cron) is a real operational risk. The data growth is **not alarming at current scale** but needs attention before scaling to 500+ devices.

**Recommendation:** Create `modesp-telemetry-cleanup.timer` (consistent with existing partition creation timer pattern).

---

### 4.7 MEDIUM: Export Memory (Edge Case, Not Typical)

**Initial claim:** "500k rows loaded into memory — HIGH"

**Verified finding:** **Technically true, but hard to trigger in practice.**

- LIMIT 500000 is hardcoded in CSV telemetry export
- `pg` library's `query()` buffers all rows before returning (~50-100 MB for 500k rows)
- CSV output IS streamed to client, but input is fully buffered

**To reach 500k rows with a single device:**
- 5-min sampling × 7 channels = 8,640 rows/day
- 31 days (max range) = ~268k rows — **under the limit**
- Only reachable with sub-minute sampling or multiple devices in export

**Comparison with other endpoints:**
- Regular telemetry API: LIMIT 10,000
- PDF export: LIMIT 10,000
- Alarm export: LIMIT 50,000

**Verdict:** Edge case, not a daily problem. The 30s query timeout provides a safety net. Worth reducing LIMIT to 100k for consistency with other endpoints, but not urgent.

---

### 4.8 LOW: Naming Inconsistency (Confirmed, Count Corrected)

`isSuperAdmin` vs `isSuperadmin` — the inconsistency is real, but the "11 occurrences" figure was wrong. Verified counts: **88 occurrences of `isSuperAdmin`** (51 backend + 37 webui) vs **37 of `isSuperadmin`** (backend only).

- The split is clean per-file (lowercase-a in export.js, alarms.js, events.js, telemetry.js, fleet.js; capital-A elsewhere), except `devices.js` which mixes both variants in different handler scopes
- **No cross-file risk:** every occurrence is a local variable or module-private function parameter. The only exported symbol (`isSuperAdmin` in webui `stores.js:54`) is consistently capital-A across all 6 importing pages
- **Verdict: purely cosmetic.** Both variants compute the identical expression; a typo'd reference would throw `ReferenceError`, not silently bypass auth. Fix during other touches, not as standalone work

### 4.9 MEDIUM-HIGH: Dead `req.log` — Silent Error Swallowing (NEW FINDING)

**Discovered during verification — a genuine bug, not a style issue.**

Error handlers in `users.js` log via optional chaining:

```js
req.log?.error?.({ err }, 'List users failed');
```

But `req.log` is **never assigned anywhere**: `pino-http` is not a dependency (only bare `pino`), no middleware sets `req.log`, and a grep for `req.log =` across `backend/src/` returns zero hits. The optional chain always short-circuits, so:

- **19 error sites in `users.js` log absolutely nothing** — failures across the entire user-management surface are silently swallowed with a generic 500
- **6 sites in `auth.js`** accidentally survive via a fallback (`|| console.error(...)`) — but log unstructured console output instead of pino JSON
- **`firmware-download.js:58`** has no logging at all

By contrast, the 57 routes using `next(err)` get proper structured logging through the global Express error handler (`index.js:348-351`).

**Recommendation (pick one):**
1. Replace all direct-500 sites with `next(err)` — routes inherit the global handler's pino logging (preferred, also fixes the style inconsistency)
2. Or add `pino-http` middleware so `req.log` actually exists

Effort: ~1-2 hours. Impact: restores error visibility for user management — currently a debugging blind spot in production.

### 4.10 Frontend WebSocket Claims — Verified FALSE (with one new real bug)

**Initial claim 1:** "WS client doesn't share token refresh events with API client — possible 401 during refresh window"

**Verified: harmless by design.**
- The WS client reads the token fresh from `getAccessToken()` at every (re)connect (`webui/src/lib/ws.js:35-38`) — there is no stale cached copy
- The backend verifies JWT **only during the upgrade handshake** (`backend/src/services/ws.js:54-74`) and never re-validates a live socket — token expiry cannot drop an established connection
- The auth-failure reconnect path (close codes 4401/1008) already refreshes the token *before* reconnecting, and `tryRefresh()` dedupes concurrent refreshes via a shared promise
- Worst case is one extra round trip on an unlucky race — it self-heals

**Initial claim 2:** "listeners Map not cleared on reconnect — memory leak"

**Verified: FALSE.**
- `on()` is never called from any reconnect path — only from component `onMount` bodies
- All 6 call sites (App, Dashboard, DeviceDetail, Alarms, PendingDevices, TelemetryChart) pair registration with disposal in `onDestroy`
- Storage is a `Set` (dedupes), key space is bounded by ~8 message types. Not clearing on reconnect is *correct* — clearing would break every mounted component's subscriptions

**NEW real bug found in the same code path:** `handleAuthReconnect` (`webui/src/lib/ws.js:195`) calls `restoreSession()` instead of `tryRefresh()`. `restoreSession()` additionally does `GET /users/me` and calls `clearAuth()` on **any** failure (`api.js:350-368`) — wiping the refresh token from localStorage. A transient network blip or a backend 500 during a WS reconnect **silently logs the user out**. And when it fails, `ws.js:200-203` dead-ends with no navigation and no toast — the page sits disconnected with no feedback.

**Recommendation:** use `tryRefresh()` semantics for WS recovery (only clear auth on a definitive 401 from the refresh endpoint), and surface a session-expired state when recovery fails. Effort: ~1 hour.

---

## 5. Code Quality Scorecard (Revised)

| Aspect | Score | Notes |
|--------|-------|-------|
| Error Handling | 6/10 | Consistent response format & Zod validation, BUT dead `req.log` silently swallows errors in 19 users.js sites (see 4.9) |
| Memory Management | 7/10 | 4/5 Maps well-managed; only stateMap needs TTL pruning; frontend listeners verified clean |
| String Safety | 9/10 | Parameterized queries, Zod validation, no SQL injection |
| Encapsulation | 6/10 | mqtt.js module globals are standard Node.js pattern, but testability suffers |
| Naming | 7/10 | Strong overall; isSuperAdmin/isSuperadmin inconsistency |
| Code Duplication | 7/10 | Exists but less severe than initially reported |
| Magic Numbers | 6/10 | All 5 flagged file:line refs verified accurate; none env-configurable despite the project already having a Tuning-section pattern in `.env.example` |
| Function Sizes | 8/10 | Mostly reasonable; 2-3 functions could benefit from splitting |
| TODO/FIXME | 10/10 | Zero found — clean, actively maintained codebase |
| Test Infrastructure | 8/10 | Vitest + Supertest + factories well-configured |

---

## 6. Revised Prioritized Action Items

### Immediate (High Impact, Low Effort)

| # | Task | Effort | Impact |
|---|------|--------|--------|
| 1 | Fix dead `req.log`: switch direct-500 sites to `next(err)` (users.js ×19, auth.js ×6, firmware-download.js ×1) | 1-2 hrs | **Restores error logging** — currently silent failures |
| 2 | Fix WS auth-reconnect: `tryRefresh()` instead of `restoreSession()`, surface session-expired state | 1 hr | Stops silent logouts on transient errors |
| 3 | Move `test_mqtt_logic.js` into Vitest framework | 30 min | Adds 19 tests to CI |
| 4 | Reuse `buildDeviceWhere()` in 4 places in devices.js | 1 hr | Eliminates real duplication |
| 5 | Create systemd timer for `cleanup-telemetry.js` | 1 hr | Closes operational gap |
| 6 | Add `npm audit` to CI pipeline | 15 min | Security hygiene |

### Short-Term (High Impact, Medium Effort)

| # | Task | Effort | Impact |
|---|------|--------|--------|
| 7 | Add alarm detection integration tests | 4-5 hrs | Highest-risk untested logic |
| 8 | Extract shared `resolveDevice()` to utility | 45 min | Eliminates true duplicate |
| 9 | Add stateMap TTL pruning (offline >30 days) | 2 hrs | Prevents memory growth |
| 10 | Normalize `isSuperadmin` → `isSuperAdmin` (37 sites, cosmetic — batch with other touches) | 30 min | Consistency |
| 11 | Reduce CSV export LIMIT from 500k to 100k | 5 min | Aligns with other endpoints |

### Medium-Term (When Needed)

| # | Task | Effort | Impact |
|---|------|--------|--------|
| 12 | Add WS subscribe() RBAC tests | 3 hrs | Tenant isolation verification |
| 13 | Extract `deleteDeviceData()` helper | 30 min | DRY improvement |
| 14 | Add mqtt.js/ws.js to coverage config | 15 min | Visibility |
| 15 | Frontend component tests | 10+ hrs | Currently zero coverage |
| 16 | Env-var tuning for hardcoded limits (rate limits, body size, export LIMIT) — extend existing `.env.example` Tuning section | 1 hr | Configurability |

### When Scaling Beyond 1k Users

| # | Task | Effort | Impact |
|---|------|--------|--------|
| 17 | Redis pub/sub for WebSocket clustering | Days | Horizontal scaling |
| 18 | Telemetry downsampling for long ranges | 4 hrs | Query performance |
| 19 | Streaming exports with pg-cursor | 3 hrs | Memory optimization |

---

## 7. Corrections to Initial Review

Transparency note — the initial automated review contained several overstated or inaccurate claims:

| Claim | Reality |
|-------|---------|
| "5 Maps grow unbounded" | Only 1 (stateMap). The other 4 are cleared & reloaded every 60s |
| "recentAssigns has no TTL cleanup" | It DOES have TTL cleanup (240s, pruned during registry refresh) |
| "UUID duplication 11x — HIGH" | 11 occurrences exist but only 6 are true duplication worth fixing |
| "Device deletion 3x — HIGH" | SQL is identical but surrounding logic is meaningfully different |
| "No retention policy" | Cleanup script EXISTS (`cleanup-telemetry.js`, 90-day default), just not automated |
| "WebSocket bottleneck — HIGH" | Architecturally true, but appropriate for current scale (<500 devices) |
| "500k rows memory pressure" | Edge case; typical usage stays under 270k rows per export |
| "TODO/FIXME comments found" | Zero found — initial claim was incorrect |
| "WS token race → possible 401" | Harmless: token read fresh at each connect; backend never re-validates a live socket; auth-close path refreshes before reconnecting |
| "Frontend listeners Map leak" | FALSE — all 6 call sites dispose in `onDestroy`; Set semantics dedupe; not clearing on reconnect is correct |
| "isSuperAdmin casing — 11 occurrences" | Actually 88 vs 37; purely cosmetic, no cross-file contract at risk |

**New bugs found during verification** (not in the initial review):
1. **Dead `req.log`** — 19 error sites in `users.js` log nothing (section 4.9)
2. **`restoreSession()` in WS reconnect** — transient errors silently log the user out (section 4.10)

---

## 8. Conclusion

ModESP Cloud is a **well-engineered production platform** with strong security practices, clean architecture, and pragmatic design choices. The codebase is actively maintained (zero TODO debt) and the team has made sensible trade-offs for their current scale.

**Top genuinely impactful improvements (in order):**
1. **Fix dead `req.log`** — 19 error sites in users.js currently log nothing; production failures there are invisible (section 4.9)
2. **Fix WS auth-reconnect logout bug** — transient network errors silently wipe the user's session (section 4.10)
3. **Bring mqtt.js tests into CI** — pure functions are tested but excluded from the pipeline
4. **Add alarm detection integration tests** — highest-risk untested business logic
5. **Automate telemetry cleanup** — script exists, just needs a systemd timer

Notably, the two most concrete bugs (items 1-2) were found not by the initial broad review but during **verification of claims that turned out to be false or overstated** — a reminder that deep code-level verification catches what pattern-level scanning misses.

The WebSocket scaling limitation, code duplication, and memory concerns are **real but appropriately deferred** for the project's current stage. The architecture supports incremental improvement without redesign.
