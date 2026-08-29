# HPMS — PRODUCTION DEPLOYMENT & INSTALLATION GUIDE

---

## 1. SYSTEM PREREQUISITES

Before deploying HPMS on a Reception/Admin PC, ensure the target machine meets the following environment requirements:

| Requirement | Recommended Version | Details / Notes |
| :--- | :--- | :--- |
| **Operating System** | Windows 10 / 11 64-bit | Local Windows Reception PC |
| **Node.js** | v18.x LTS or higher (v24.x tested) | Required for Backend & Build tools |
| **npm** | v9.x or higher | Node Package Manager |
| **MySQL Server** | v8.0+ | Authoritative Relational Database |
| **Database Name** | `hotel_pms` | Target Production Database Name |
| **Backend Port** | 5000 | Production REST API & Socket Server |
| **Frontend Port** | 5173 / Electron Desktop Window | Web Client or Self-Contained Desktop App |

---

## 2. REPOSITORY & ENVIRONMENT SETUP

### Step 1: Clone Repository
```powershell
git clone -b firebase-migration https://github.com/Akshay5362/Hotel-management-system.git hpms
cd hpms
```

### Step 2: Install Dependencies
```powershell
# Root & Frontend dependencies
npm install

# Backend dependencies
cd backend
npm install
cd ..
```

### Step 3: Configure Environment (`backend/.env`)
Create `backend/.env` using the following template (replace placeholders with production credentials):

```env
PORT=5000
NODE_ENV=production
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_secure_mysql_password
DB_NAME=hotel_pms
JWT_SECRET=your_super_secret_jwt_key

# HPMS Service-Layer Feature Flags
ENABLE_FIRESTORE_OUTBOX_WORKER=true
ENABLE_FIRESTORE_DUAL_WRITE=true
ENABLE_FIRESTORE_READS=true
USE_FIRESTORE_SERVICES=true

# Firebase Service Account Credentials
FIREBASE_PROJECT_ID=hpms-sky5
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@hpms-sky5.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nYOUR_KEY_HERE\n-----END PRIVATE KEY-----\n"
```

---

## 3. DATABASE INITIALIZATION & MIGRATIONS

### Step 1: Create Database
In MySQL Workbench or command line:
```sql
CREATE DATABASE IF NOT EXISTS `hotel_pms` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
```

### Step 2: Run Database Migrations
```powershell
cd backend
node migrations/runner.js up
cd ..
```

---

## 4. PRODUCTION STARTUP PROCEDURES

### Option A: Standard Backend + Browser Frontend
```powershell
# Terminal 1: Backend API Server
cd backend
node server.js

# Terminal 2: Production Build & Serve
npm run build
npm run preview
```

### Option B: Self-Contained Electron Desktop Application
```powershell
# Build web app bundle and launch Electron desktop application
npm run electron:prod
```

### Option C: Build Standalone Windows Installer (.exe)
```powershell
# Generates release/Webline PMS Plus Setup 1.0.0.exe installer
npm run electron:build
```

---

## 5. POST-INSTALLATION HEALTH DIAGNOSTIC

Verify application health by sending a GET request:
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
  }
}
```

---

## 6. BACKUP SCHEDULER INSTALLATION & RESTORE

### Register Daily Automated MySQL Backup
Open PowerShell **as Administrator** and execute:
```powershell
schtasks /Create /TN "HPMS-MySQL-Daily-Backup" /TR "powershell.exe -ExecutionPolicy Bypass -File d:\projects\hotel\scripts\scheduleMysqlBackup.ps1" /SC DAILY /ST 02:00 /F
```

### Safe Restore into Isolated Test Target
**HARD SAFETY RULE:** NEVER restore over `hotel_pms`.
```powershell
node scripts/restoreMysql.js backups/mysql/<backup-filename>.sql hpms_restore_test
```

---

## 7. FAIL-SAFE ROLLBACK & TROUBLESHOOTING

- **Emergency Read Rollback:** Set `USE_FIRESTORE_SERVICES=false` in `backend/.env` and restart backend server (`node backend/server.js`). All service reads will instantly route directly to MySQL.
- **Log Inspection:** Review execution logs in `backups/mysql/scheduled_backup.log`.
