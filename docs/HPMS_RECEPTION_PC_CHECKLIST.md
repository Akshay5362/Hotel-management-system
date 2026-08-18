# HPMS — RECEPTION PC DEPLOYMENT & ACCEPTANCE CHECKLIST

---

## RECEPTION PC PRE-FLIGHT CHECKLIST

Complete each item on the local Reception/Admin PC before releasing the system for live operations:

- [ ] **[1] Prerequisites Installed:** Node.js (v18+ LTS) and MySQL Server (v8.0+) installed and running as local Windows services.
- [ ] **[2] Project Source / Build Provisioned:** Repository cloned (`git clone -b firebase-migration`) or deployment package extracted to target path (`d:\projects\hotel`).
- [ ] **[3] Production Environment Configured:** `backend/.env` created with valid DB credentials, JWT secret, and Firebase Service Account key (`USE_FIRESTORE_SERVICES=true`).
- [ ] **[4] Database Provisioned:** `hotel_pms` database created in MySQL.
- [ ] **[5] Database Migrations Executed:** Ran `node backend/migrations/runner.js up` cleanly without errors.
- [ ] **[6] Backend Started:** Ran `node backend/server.js` on Port 5000.
- [ ] **[7] Health Check Verified:** GET `http://localhost:5000/api/health` returns HTTP 200 with `status: ok` and feature flags active.
- [ ] **[8] Client Application Launched:** Browser frontend (`npm run build && npm run preview`) or Electron desktop application (`npm run electron:prod`) opens cleanly without white/black screens.
- [ ] **[9] Receptionist Authentication Verified:** Login using `reception1@hotelsky5.com` succeeds and opens Reception dashboard.
- [ ] **[10] Admin Authentication Verified:** Login using `admin@hotelsky5.com` succeeds and grants access to Admin Settings & Staff Management.
- [ ] **[11] Guest Authentication & Payment Isolation Verified:** Guest login succeeds; guest payment records remain strictly isolated to the authenticated user.
- [ ] **[12] Firestore Service Reads Confirmed:** Service reads route through `FIRESTORE_WITH_MYSQL_FALLBACK` with zero console errors.
- [ ] **[13] MySQL Mutation Authority Confirmed:** Check-In, Check-Out, Payments, Invoices, Room Status, and Day-End mutations execute authoritatively inside MySQL transactions.
- [ ] **[14] Backup Scheduler Registered:** Windows Task Scheduler task `HPMS-MySQL-Daily-Backup` registered (`schtasks /Query /TN "HPMS-MySQL-Daily-Backup"`) and marked `Ready`.
- [ ] **[15] Backup Execution Verified:** Executed `powershell -ExecutionPolicy Bypass -File scripts/scheduleMysqlBackup.ps1` and confirmed timestamped `.sql` dump created in `backups/mysql/` with SHA-256 hash.
- [ ] **[16] Clean Application Restart Tested:** Restarted backend service and client application; state persisted cleanly.
