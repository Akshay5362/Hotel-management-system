# HPMS-Sky5 — Master Testing Strategy & Automated Test Audit
**Document Version**: 2.0.0  
**Audit Date**: August 11, 2026  
**Audit Scope**: Test Infrastructure, Test Coverage & Test Cleanup Safety  

---

## 1. Automated Test Infrastructure Inventory

The HPMS-Sky5 test suite is comprised of 12 dedicated automated test suites in `backend/tests/` and 74 operational verification scripts in `scripts/`. Tests are implemented as standalone Node.js ES Modules using the native Node `assert` module.

### Core Test Suite Catalog (`backend/tests/`)

| Test File | Primary Focus | Category | Assertions | Target DB / Layer | Cleanup Mechanism | Safety Rating |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`testFirestoreRepositories.mjs`** | 19 Repositories | Repository / Integration | 36 | Firestore Live | `finally` array iteration | **SAFE** |
| **`testOutboxInfrastructure.mjs`** | Outbox Engine | Infrastructure / Outbox | 12 | MySQL `dual_write_outbox` | `finally` block deletion | **SAFE** |
| **`testRoomTypeDualWritePilot.mjs`** | Room Types (3B) | Dual-Write Integration | 12 | MySQL & Firestore | `finally` block deletion | **SAFE** |
| **`testRoomsDualWritePilot.mjs`** | Rooms (3C) | Dual-Write Integration | 14 | MySQL & Firestore | `finally` block deletion | **SAFE** |
| **`testStaffDualWritePilot.mjs`** | Staff (3D) | Dual-Write Integration | 15 | MySQL & Firestore | `finally` block deletion | **SAFE** |
| **`testInventoryCategoriesDualWritePilot.mjs`**| Categories (3E) | Dual-Write Integration | 10 | MySQL & Firestore | `finally` block deletion | **SAFE** |
| **`testSystemSettingsDualWritePilot.mjs`** | System Settings (3F)| Dual-Write Integration | 10 | MySQL & Firestore | `finally` block deletion | **SAFE** |
| **`testInventoryProductsDualWritePilot.mjs`** | Products (3G) | Dual-Write Integration | 11 | MySQL & Firestore | `finally` block deletion | **SAFE** |
| **`testGuestDualWritePilot.mjs`** | Guest Profiles (3H)| Dual-Write Integration | 12 | MySQL & Firestore | `finally` block deletion | **SAFE** |
| **`testHousekeepingDualWritePilot.mjs`**| Housekeeping (3I) | Dual-Write Integration | 12 | MySQL & Firestore | `finally` block deletion (`hk` + `room`) | **SAFE** |
| **`testAuditLogsDualWritePilot.mjs`** | Audit Logs (3J) | Dual-Write Integration | 8 | MySQL & Firestore | `finally` block deletion | **SAFE** |
| **`testFactoryReset.mjs`** | Factory Reset Fix | System Integrity / Rollback| 10 | MySQL (In-Tx Rollback) | Transaction Rollback Wrapper | **SAFE** |

---

## 2. Test Category Breakdown

| Test Category | Executable Status | Execution Method | Real MySQL Usage? | Real Firestore Usage? | Coverage & Gaps |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Unit Tests** | **MISSING** | N/A | NO | NO | No unit testing library (Vitest/Jest) installed in `package.json`. |
| **Integration Tests** | **EXECUTABLE** | `node backend/tests/test*.mjs` | YES | YES | Comprehensive coverage of dual-write outbox dispatchers & repositories. |
| **Repository Tests** | **EXECUTABLE** | `node backend/tests/testFirestoreRepositories.mjs` | NO | YES | 100% coverage of all 19 Firestore repository abstraction modules. |
| **Controller Tests** | **EXECUTABLE** | Via pilot test suites | YES | YES | Direct controller handler invocation (`createRoom`, `updateStaff`, etc.). |
| **API End-to-End Tests** | **EXECUTABLE** | `node scripts/testStrictRbac.js` | YES | NO | Endpoint permission testing for all 6 user roles. |
| **Migration Tests** | **EXECUTABLE** | `npm run migrate:status` | YES | NO | MySQL migration runner (`backend/migrations/runner.js`). |
| **Frontend UI Tests** | **MISSING** | N/A | NO | NO | No React Testing Library or Cypress/Playwright installed. |

---

## 3. Test Cleanup Safety Audit

### Cleanup Mechanisms & Safety Protections
1. **Randomized Test Keys**: All pilot tests generate unique isolated test identifiers using timestamps and random base-36 tokens (e.g. `P3C_${rand}`, `staff_${rand}`, `BKG_P2_${rand}`). This prevents collision with production hotel room numbers or staff accounts.
2. **Guaranteed `finally` Execution**: All 11 pilot test suites run cleanup logic within `try ... finally` blocks. If an assertion fails or an unexpected exception occurs mid-test, MySQL queries (`DELETE FROM ... WHERE ...`) and Firestore API calls (`deleteRoomFirestore(...)`) are guaranteed to execute.
3. **Multi-Document Cleanup Verification**: `testHousekeepingDualWritePilot.mjs` explicitly cleans up both the `housekeeping/hk_room_${testRoomNumber}` document and the `rooms/room_${testRoomNumber}` document created by `ROOM_STATUS_CHANGED` outbox events.
4. **Transaction Rollback Testing**: `testFactoryReset.mjs` tests full reset execution inside a test transaction wrapper that is explicitly rolled back (`await conn.rollback()`), guaranteeing zero persistent modification to operational database tables.

---

## 4. Test Strategy Recommendations

1. **Install Standard Test Runner**: Install `vitest` in root `package.json` to allow standard `npm test` invocation.
2. **Add CI Automation**: Configure GitHub Actions to execute backend integration test suites automatically on every pull request.
3. **Frontend Component Testing**: Introduce `@testing-library/react` for critical frontend modules like `ReceptionPortal.jsx` and `ReservationModule.jsx`.
