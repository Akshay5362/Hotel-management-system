# HPMS — PRODUCTION OPERATIONS RUNBOOK

---

## 1. ARCHITECTURAL OVERVIEW

Webline PMS Plus (HPMS) operates under a dual-engine architecture:

- **READ PATH:** Clients query controllers, which route through `serviceStrategy.js` (`FIRESTORE_WITH_MYSQL_FALLBACK`). Requests attempt Firestore first; on timeout (>100ms), network exception, or permission error, the system transparently falls back to MySQL.
- **MUTATION PATH:** **MySQL is 100% authoritative for all business mutations** (`getMutationStrategy() === MYSQL`). Multi-table business operations execute inside MySQL ACID transactions (`BEGIN...COMMIT`), write outbox events to `dual_write_outbox`, and project changes asynchronously to Firestore via `outboxWorker.js`.

---

## 2. STARTUP, STOP & RESTART PROCEDURES

### Start HPMS Backend & Frontend
```bash
# 1. Start Backend Server (Production Node.js process)
cd d:\projects\hotel\backend
node server.js

# 2. Start Frontend Server / Serve Production Build
cd d:\projects\hotel
npm run dev
```

### Stop HPMS
To stop running processes cleanly:
- In backend/frontend terminals, press `Ctrl+C`.
- Or terminate Node processes:
  ```powershell
  Stop-Process -Name "node" -Force
  ```

### Restart HPMS
```powershell
# Stop and restart backend cleanly
Stop-Process -Name "node" -Force
node d:\projects\hotel\backend\server.js
```

---

## 3. HEALTH & STATUS DIAGNOSTICS

### 1. Check Application Health
Execute HTTP GET request against the health endpoint:
```powershell
curl http://localhost:5000/api/health
```
**Expected HTTP Response (200 OK):**
```json
{
  "status": "ok",
  "service": "hotel-pms-backend",
  "port": 5000,
  "feature_flags": {
    "outbox_worker": true,
    "dual_write": true,
    "firestore_reads": true,
    "use_firestore_services": true
  },
  "outbox_worker": {
    "enabled": true,
    "running": true
  },
  "telemetry": {
    "read_attempts": 180,
    "firestore_direct_successes": 180,
    "mysql_fallback_successes": 0,
    "read_fallbacks": 0,
    "fallback_rate_percent": 0,
    "total_latency_ms": 572,
    "average_latency_ms": 3.18,
    "max_latency_ms": 6.30
  }
}
```

### 2. Check Outbox Queue Health
Query MySQL database to verify outbox queue state:
```sql
SELECT status, COUNT(*) FROM dual_write_outbox GROUP BY status;
```
**Healthy State Target:**
- `PENDING`: 0
- `PROCESSING`: 0
- `FAILED`: 0
- `DEAD_LETTER`: 0

---

## 4. DISASTER RECOVERY & BACKUP OPERATIONS

### 1. Check Backup Scheduler Status
```powershell
schtasks /Query /TN "HPMS-MySQL-Daily-Backup" /FO LIST
```
Verify `Status: Ready` and `Next Run Time: 02:00:00 AM`.

### 2. Execute Manual Backup
```powershell
node d:\projects\hotel\scripts\backupMysql.js
```
Generates a timestamped dump in `d:\projects\hotel\backups\mysql\backup_hpms_<timestamp>.sql` with SHA-256 hash.

### 3. Safe Isolated Restore Sequence
**HARD SAFETY RULE:** NEVER restore over the production database `hotel_pms`.
```powershell
node d:\projects\hotel\scripts\restoreMysql.js d:\projects\hotel\backups\mysql\<backup-file>.sql hpms_restore_test
```
This restores the SQL dump into isolated target database `hpms_restore_test` and verifies table row counts.

---

## 5. EMERGENCY FAIL-SAFE ROLLBACK & INCIDENT RESPONSE

### Roll Back Service Read Layer to MySQL
If Firestore experiences extended regional outages, edit `d:\projects\hotel\backend\.env`:
```env
USE_FIRESTORE_SERVICES=false
```
Then restart backend server. All service reads will instantly route to MySQL directly without affecting business mutations or user state.

### Re-Enable Firestore Service Layer
Once Firestore connectivity is confirmed restored, set in `backend\.env`:
```env
USE_FIRESTORE_SERVICES=true
```
Then restart backend server. `FIRESTORE_WITH_MYSQL_FALLBACK` strategy re-activates automatically.

---

## 6. ESCALATION PROCEDURE

1. **Level 1 (System Administrator):** Check `/api/health`, inspect `backups/mysql/scheduled_backup.log`, verify MySQL pool status.
2. **Level 2 (Database Administrator):** Audit `dual_write_outbox` table, inspect slow query log, run `node scripts/backupMysql.js`.
3. **Level 3 (Lead Engineer / Architect):** Audit Firebase Console, verify Google Cloud service status, review `serviceStrategy.js` telemetry logs.
