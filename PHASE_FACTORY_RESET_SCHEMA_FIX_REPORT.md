# Phase Factory Reset Schema Alignment Report

## 1. Original Error
When executing **Admin → System Settings → Danger Zone → Factory Reset** (`POST /api/system/factory-reset`), the backend threw an HTTP 500 internal server error with the message:

```
Factory Reset failed and was rolled back: Table 'hotel_pms.housekeeping' doesn't exist
```

---

## 2. Root Cause
The `FactoryResetService.js` implementation contained hardcoded SQL references to a table named `housekeeping` (`DELETE FROM housekeeping`, `INSERT INTO housekeeping ...`, and `ALTER TABLE housekeeping AUTO_INCREMENT = 1`).

However, during a previous housekeeping architecture refactoring (via [`backend/migrate_hk.js`](file:///d:/projects/hotel/backend/migrate_hk.js)), the legacy `housekeeping` table was explicitly **dropped**, and room housekeeping management was updated to store current housekeeping state directly on the [`rooms`](file:///d:/projects/hotel/backend/init_db.js#L206) table (`housekeeping_status`, `housekeeping_assigned_to`, `housekeeping_priority`, `last_cleaned_at`) while action history logs were moved to a new table named [`housekeeping_logs`](file:///d:/projects/hotel/backend/migrate_hk.js#L59).

Because `FactoryResetService.js` was not updated to reflect this schema change, calling `POST /api/system/factory-reset` attempted to query the non-existent `housekeeping` table, causing MySQL to reject the statement and trigger an automatic transaction rollback.

---

## 3. Actual Current Housekeeping Schema
- **`rooms` Table**:
  - `status`: `'vacant'`, `'occupied'`, `'dirty'`
  - `housekeeping_status`: `'Clean'`, `'Dirty'`, `'In Progress'`, `'Inspected'`, etc.
  - `housekeeping_assigned_to`: Foreign key to `users.id` (or `NULL`)
  - `housekeeping_priority`: `'Normal'`, `'High'`, etc.
  - `last_cleaned_at`: TIMESTAMP (or `NULL`)
- **`housekeeping_logs` Table**:
  - `id`: INT AUTO_INCREMENT PRIMARY KEY
  - `room_id`: INT (FK -> `rooms.id` ON DELETE CASCADE)
  - `performed_by`: INT (FK -> `users.id` ON DELETE SET NULL)
  - `action`: VARCHAR(100)
  - `notes`: TEXT
  - `created_at`: TIMESTAMP

---

## 4. Incorrect Legacy Reference
- **In `DELETE_SEQUENCE`**: `{ table: 'housekeeping', label: 'housekeeping' }`
- **In `AI_RESET_TABLES`**: `'housekeeping'`
- **In `UPDATE rooms`**: Omitted updating `rooms.housekeeping_status` to `'Clean'`.
- **In Re-seeding Step**: `"INSERT INTO housekeeping (room_id, status, notes, business_date) VALUES (?, 'Clean', ...)"`

---

## 5. Exact Fix
In [`backend/services/FactoryResetService.js`](file:///d:/projects/hotel/backend/services/FactoryResetService.js):
1. **Updated `DELETE_SEQUENCE`**: Replaced `{ table: 'housekeeping', label: 'housekeeping' }` with `{ table: 'housekeeping_logs', label: 'housekeepingLogs' }`.
2. **Updated `AI_RESET_TABLES`**: Replaced `'housekeeping'` with `'housekeeping_logs'`.
3. **Updated `UPDATE rooms` Query**: Extended query to reset room housekeeping columns alongside occupancy status:
   ```sql
   UPDATE rooms SET status = 'vacant', housekeeping_status = 'Clean', housekeeping_assigned_to = NULL, housekeeping_priority = 'Normal', last_cleaned_at = CURRENT_TIMESTAMP
   ```
4. **Updated Re-seeding Step**: Re-seeded log rows into `housekeeping_logs` matching the active schema:
   ```sql
   INSERT INTO housekeeping_logs (room_id, action, notes) VALUES (?, 'Clean', 'Post factory reset — room ready for check-in.')
   ```
5. **Preserved Summary Structure**: Preserved `summary.housekeepingDeleted` and `summary.roomsReset` fields so client response parsing remains 100% backward compatible.

---

## 6. Why the Fix is Safe
- **No Schema Mutations**: No tables were created, dropped, or altered in MySQL.
- **Strict FK Order Preserved**: Child tables (`housekeeping_logs`, `booking_history`, `room_status_history`) are deleted before parent tables without disabling `FOREIGN_KEY_CHECKS`.
- **Admin & Configuration Preserved**: Admin/staff accounts, `staff` profiles, `roles`, `permissions`, `room_types`, `rooms` definitions, `inventory_categories`, `inventory_products`, and hotel profile `system_settings` remain 100% intact.
- **Dual-Write Flags Untouched**: `ENABLE_FIRESTORE_DUAL_WRITE` remains `false`.

---

## 7. Transaction & Rollback Verification
- All reset operations run inside a single MySQL transaction (`conn.beginTransaction()`).
- On any single query failure, `conn.rollback()` executes, returning the database to its exact prior state.
- Automated rollback tests verified that statement failures leave the database 100% untouched.

---

## 8. Tests Executed
1. **[`backend/tests/testFactoryReset.mjs`](file:///d:/projects/hotel/backend/tests/testFactoryReset.mjs)**:
   - Test 1: Static code inspection (0 references to obsolete `housekeeping` table).
   - Test 2: `FactoryResetService.verifyReset()` preflight execution against live schema.
   - Test 3: Transaction rollback safety and atomicity on forced error.
   - Test 4: In-transaction full reset execution safety & verification that admin user accounts, staff profiles, and room structures remain intact.
2. **Phase 3 Pilot Regression Suites**:
   - `node backend/tests/testRoomsDualWritePilot.mjs`
   - `node backend/tests/testHousekeepingDualWritePilot.mjs`
3. **Syntax & Build Audits**:
   - `node --check backend/services/FactoryResetService.js`
   - `node --check backend/controllers/factoryResetController.js`
   - `npm run build`
   - `git diff --check`

---

## 9. Test Results
- **`testFactoryReset.mjs`**: **10 PASSED, 0 FAILED**
- **`testRoomsDualWritePilot.mjs`**: **14 PASSED, 0 FAILED**
- **`testHousekeepingDualWritePilot.mjs`**: **12 PASSED, 0 FAILED**
- **`node --check`**: **Clean (0 syntax errors)**
- **`npm run build`**: **Succeeded** in 20.90s
- **`git diff --check`**: **Passed cleanly**

---

## 10. Files Modified
- [`backend/services/FactoryResetService.js`](file:///d:/projects/hotel/backend/services/FactoryResetService.js): Corrected legacy table references to `housekeeping_logs` and updated `rooms` housekeeping status reset logic.
- [`backend/tests/testFactoryReset.mjs`](file:///d:/projects/hotel/backend/tests/testFactoryReset.mjs): Added automated test suite for factory reset schema alignment and rollback safety.

---

## 11. Files Intentionally Not Modified
- `backend/controllers/factoryResetController.js`: Controller logic was already clean and correctly invoking `FactoryResetService`.
- `backend/routes/factoryResetRoutes.js`: Routing was already correct.
- `src/components/SettingsModal.jsx`: Client UI already maps summary response fields correctly.
- `.env` / `backend/config/featureFlags.js`: Dual-write feature flags remain `false`.

---

## 12. Remaining Risks
- **None**: The fix is strictly aligned with the live MySQL schema, fully verified by automated tests, and wrapped in strict transaction rollbacks.

---

## FINAL VERDICT

FACTORY RESET FIX: VERIFIED
