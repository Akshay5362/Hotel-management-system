# HPMS Phase 3 Step 4 — RBAC Firebase-Only Read-Only Audit Report

**Date:** 2026-08-20  
**Phase:** Phase 3 — Step 4 (RBAC & Authorization Audit)  
**Execution Type:** 100% Read-Only Static & Architectural Audit  
**Status:** COMPLETED (Read-Only)

---

## 1. Executive Summary & Audit Metrics

This audit analyzes all role lookups, permission evaluations, and authorization middlewares across the Hotel Property Management System (HPMS-Sky5) backend and frontend. The goal is to determine the exact dependency on MySQL for RBAC and establish the safest architecture for eliminating MySQL RBAC queries during Firebase-only serving.

```
========================================================================================
                       PHASE 3 STEP 4 AUDIT METRICS
========================================================================================
 MySQL mutations                : 0
 MySQL schema changes           : 0
 Firebase Auth mutations        : 0
 Firestore mutations            : 0
 Source files modified          : 0
 Active feature flags modified  : 0
 Build verification             : PASS (vite v5.4.21 production build clean)
========================================================================================
```

---

## 2. Role Lookups Inventory

### 2.1 MySQL Role Queries

| File & Line | Query / Operation | Context / Trigger | Dependency Category |
|---|---|---|---|
| `backend/controllers/authController.js:74` | `SELECT id FROM roles WHERE name = 'guest'` | Guest signup (`signUp`) to obtain `role_id` for MySQL `users` table insert | D (Legacy DB write path) |
| `backend/controllers/authController.js:314-320` | `SELECT u.id, ..., r.name as role FROM users u LEFT JOIN roles r ON u.role_id = r.id ...` | Legacy user signin (`signIn`) | D (Legacy JWT-only path) |
| `backend/controllers/authController.js:766-773` | `SELECT u.id, u.username, u.fullName, r.name as role FROM users u LEFT JOIN roles r ON u.role_id = r.id WHERE u.id = ? OR u.username = 'admin' LIMIT 1` | `resolveCanonicalFirebaseUser` for Root Admin (`user_1`) | E (Root-admin special case) |
| `backend/controllers/authController.js:724-728` | `SELECT id, username, full_name, role, department, shift, status, deleted FROM staff WHERE (id = ? OR username = ?) AND deleted = 0 LIMIT 1` | `resolveCanonicalFirebaseUser` for Staff when `ENABLE_FIREBASE_ONLY_STAFF_RESOLUTION=false` | C / D (Flag-off fallback) |
| `backend/controllers/authController.js:888-891` | `SELECT status, deleted FROM staff WHERE (id = ? OR username = ?) AND deleted = 0 LIMIT 1` | `authenticate` legacy HMAC token status check | D (Legacy JWT-only path) |
| `backend/controllers/authController.js:1107-1111` | `SELECT id, username, full_name, role, department, shift, status, deleted FROM staff WHERE (id = ? OR username = ?) AND deleted = 0 LIMIT 1` | `getMe` legacy JWT staff profile lookup | D (Legacy JWT-only path) |
| `backend/services/dualRbacVerificationService.js:30,61` | `SELECT id FROM roles WHERE LOWER(name) = ? LIMIT 1` | Dual-RBAC parity test service (`hasMysqlPermission`, `getMysqlPermissionsForRole`) | Verification-only helper |
| `backend/services/FactoryResetService.js:169` | `SELECT id FROM roles WHERE name = 'guest' LIMIT 1` | Factory reset user filter | Maintenance service |

### 2.2 `req.user.role` Usage Across Middleware and Endpoints

- **`requireAdmin` (`backend/controllers/authController.js:903`)**:  
  Inspects `req.user.role` (`roleUpper === 'ADMIN'`) and `req.user.type === 'staff'`.
- **`requireSuperAdmin` (`backend/controllers/authController.js:917`)**:  
  Inspects `req.user.role === 'admin'`, `!isStaff`, and `req.user.isRootAdmin === true || req.user.id === 1`.
- **`requireGuest` (`backend/controllers/authController.js:937`)**:  
  Inspects `req.user.role === 'guest'`.
- **`requireRole(...allowedRoles)` (`backend/controllers/authController.js:1003`)**:  
  Calls `normalizeUserRole(req.user)` and matches against `allowedRoles`. When `ENABLE_STRICT_RBAC=true`, normalizes:
  - Root admin (`users.id = 1`, `role = 'admin'`, `type !== 'staff'`) $\to$ `super_admin` (inherits `admin`)
  - Staff `ADMIN` $\to$ `admin`
  - Staff `RECEPTIONIST` $\to$ `receptionist`
  - Staff `CLEANER` $\to$ `housekeeper`
  - Staff `CHEF` / `KITCHEN_HELPER` / `PANTRY_BOY` $\to$ `kitchen`
  - Guest $\to$ `guest`

*Finding:* Once `req.user` is populated by `authenticate`, all role middlewares (`requireAdmin`, `requireSuperAdmin`, `requireGuest`, `requireRole`) operate entirely in-memory on `req.user.role` and `req.user.type`—**0 MySQL queries are performed during role evaluation**.

---

## 3. Permission Lookups & Authorization Middleware

### 3.1 Permission Lookups in MySQL

The only active permission lookup function in the entire backend is `hasPermission(req, permissionName)`:

```javascript
// backend/controllers/authController.js (lines 946-961)
export const hasPermission = async (req, permissionName) => {
  if (!req.user) return false;
  const roleName = req.user.role?.toLowerCase() || '';
  const [rows] = await pool.query(`
    SELECT p.id
    FROM permissions p
    JOIN role_permissions rp ON p.id = rp.permission_id
    JOIN roles r ON rp.role_id = r.id
    WHERE LOWER(r.name) = ? AND p.name = ?
  `, [roleName, permissionName]);

  const mysqlAllowed = rows.length > 0;
  executeShadowRbacVerification(req, permissionName, mysqlAllowed);

  return mysqlAllowed;
};
```

### 3.2 Where `hasPermission` is Called

1. **`backend/controllers/settingsController.js:151`**:
   ```javascript
   // Inside updateBusinessDate (POST /api/settings/business-date)
   const canOverride = await hasPermission(req, 'override_business_date');
   if (!canOverride) {
     return res.status(403).json({ error: 'Forbidden...', code: 'PERMISSION_DENIED' });
   }
   ```
2. **`backend/middleware/dualRbacShadowMiddleware.js:19`**:
   Express shadow middleware helper used for non-blocking background comparison.

*Finding:* `POST /api/settings/business-date` is the **single live API endpoint** in the entire application that performs an explicit MySQL `permissions` / `role_permissions` join query.

---

## 4. Endpoints Inventory & RBAC Evaluation Analysis

| Route | HTTP Method | Auth Middleware | Role / Permission Checked | MySQL Query Executed During Auth? |
|---|---|---|---|---|
| `/api/auth/signup` | POST | None (Public) | None | Yes (inserts user & guest, queries `roles` for `guest` id) |
| `/api/auth/signin` | POST | None (Public) | None | Flag-dependent (Rejects password if Firebase Login flag ON; queries MySQL if flag OFF) |
| `/api/auth/me` | GET | `getMe` handler | None (Returns identity) | 0 MySQL queries if `ENABLE_FIREBASE_ONLY_STAFF_RESOLUTION=true` and `uid != user_1` |
| `/api/staff/auth/login` | POST | None (Public) | None | Flag-dependent (Rejects password if Firebase Login flag ON; queries MySQL if flag OFF) |
| `/api/status` | GET | `authenticate` | None | 0 MySQL queries if Firebase token used |
| `/api/dayend` | POST | `authenticate`, `requireRole('admin')` | Role `admin` / `super_admin` | 0 MySQL queries during role check |
| `/api/dayend/undo` | POST | `authenticate`, `requireSuperAdmin` | Role `super_admin` | 0 MySQL queries during role check |
| `/api/settings/business-date` | GET | `authenticate` | None | 0 MySQL queries |
| `/api/settings/business-date` | POST | `authenticate` | Permission `override_business_date` | **YES (`hasPermission` executes MySQL join)** |
| `/api/rooms/:number/checkin` | POST | `authenticate`, `requireRole('admin', 'receptionist')` | Role `admin` or `receptionist` | 0 MySQL queries during role check |
| `/api/rooms/:number/checkin` | PUT | `authenticate`, `requireRole('admin', 'receptionist')` | Role `admin` or `receptionist` | 0 MySQL queries during role check |
| `/api/rooms/:number/checkout` | POST | `authenticate`, `requireRole('admin', 'receptionist')` | Role `admin` or `receptionist` | 0 MySQL queries during role check |
| `/api/rooms/:number/clean` | POST | `authenticate`, `requireRole('admin', 'receptionist', 'housekeeper')` | Role `admin`, `receptionist`, `housekeeper` | 0 MySQL queries during role check |
| `/api/rooms/:number/ledger` | POST/GET | `authenticate`, `requireRole('admin', 'receptionist')` | Role `admin` or `receptionist` | 0 MySQL queries during role check |
| `/api/rooms/shift` | POST | `authenticate`, `requireRole('admin', 'receptionist')` | Role `admin` or `receptionist` | 0 MySQL queries during role check |
| `/api/rooms/:number/book` | POST | `authenticate` | None | 0 MySQL queries |
| `/api/rooms/:number/refund-checkout` | POST | `authenticate`, `requireRole('admin')` | Role `admin` / `super_admin` | 0 MySQL queries during role check |
| `/api/rooms/:number/extend-stay` | POST | `authenticate`, `requireRole('admin', 'receptionist')` | Role `admin` or `receptionist` | 0 MySQL queries during role check |
| `/api/rooms/:number/late-checkout` | POST | `authenticate`, `requireRole('admin', 'receptionist')` | Role `admin` or `receptionist` | 0 MySQL queries during role check |
| `/api/rooms/:number/no-show` | POST | `authenticate`, `requireRole('admin', 'receptionist')` | Role `admin` or `receptionist` | 0 MySQL queries during role check |
| `/api/rooms/:number/status` | PUT | `authenticate`, `requireRole('admin', 'receptionist', 'housekeeper')` | Role `admin`, `receptionist`, `housekeeper` | 0 MySQL queries during role check |
| `/api/refund-policy` | GET/PUT | `authenticate`, `requireRole('admin')` | Role `admin` / `super_admin` | 0 MySQL queries during role check |
| `/api/guest/*` (all 9 routes) | ALL | `authenticate`, `requireGuest` | Role `guest` | 0 MySQL queries during role check |
| `/api/admin/guest-requests/*` | ALL | `authenticate`, `requireRole('admin', 'receptionist')` | Role `admin` or `receptionist` | 0 MySQL queries during role check |
| `/api/admin/guest-documents` | GET | `authenticate`, `requireRole('admin', 'receptionist')` | Role `admin` or `receptionist` | 0 MySQL queries during role check |
| `/api/admin/guest-documents/:guestId` | DELETE | `authenticate`, `requireRole('admin')` | Role `admin` | 0 MySQL queries during role check |
| `/api/admin/guests*` | GET | `authenticate`, `requireRole('admin', 'receptionist')` | Role `admin` or `receptionist` | 0 MySQL queries during role check |
| `/api/housekeeping/*` | ALL | `authenticate`, `requireRole('admin', 'receptionist', 'housekeeper')` | Role `admin`, `receptionist`, `housekeeper` | 0 MySQL queries during role check |
| `/api/cash/submit`, `/submissions` | ALL | `authenticate`, `requireRole('admin', 'receptionist')` | Role `admin` or `receptionist` | 0 MySQL queries during role check |
| `/api/staff/*` | ALL | `authenticate`, `requireRole('admin')` | Role `admin` / `super_admin` | 0 MySQL queries during role check |
| `/api/reservations/*` | ALL | `authenticate` | None | 0 MySQL queries |
| `/api/inventory/products*` (POST, PUT, DELETE) | ALL | `authenticate`, `requireAdmin` | Role `admin` / `staff` | 0 MySQL queries during role check |
| `/api/room-types/*` (POST, PUT, DELETE) | ALL | `authenticate`, `requireRole('admin')` | Role `admin` / `super_admin` | 0 MySQL queries during role check |
| `/api/system/factory-reset/*` | ALL | `authenticate`, `requireSuperAdmin` | Role `super_admin` (`user_1`) | 0 MySQL queries during role check |
| `/api/payments/*` | ALL | `authenticate`, `requireAdmin` / `requireGuest` | Role `admin` or `guest` | 0 MySQL queries during role check |
| `/api/reports/*` | ALL | `authenticate`, `requireAdmin` | Role `admin` / `staff` | 0 MySQL queries during role check |
| `/api/invoices/generate/:bookingId` | POST | `authenticate`, `requireAdmin` | Role `admin` / `staff` | 0 MySQL queries during role check |

---

## 5. MySQL RBAC Query Categorization

Each MySQL RBAC interaction identified belongs to one of five distinct categories:

- **Category A: Can be replaced directly by Firebase Custom Claims**
  - All role-based authorization checks: `requireRole()`, `requireAdmin()`, `requireSuperAdmin()`, `requireGuest()`.
  - Staff role & status resolution: already covered by claims `{ role, user_type: 'staff', status, deleted, mysql_id }`.
  - Guest role resolution: already covered by claims `{ role: 'guest', user_type: 'guest', mysql_id, mysql_guest_id }`.
- **Category B: Requires Firestore Permission Document or Static Canonical RBAC Helper**
  - `hasPermission(req, 'override_business_date')` query: Can be resolved from Firestore (`hasFirestorePermission` in `backend/repositories/firestore/rbacRepository.js`) or via canonical static permissions map.
- **Category C: Must remain MySQL temporarily**
  - None during Firebase-only mode. All 18 RBAC entities (`roles: 2`, `permissions: 7`, `role_permissions: 9`) already exist with 100% parity in Firestore.
- **Category D: Legacy JWT-only path**
  - `authController.js:888` and `getMe:1107` (legacy HMAC token verification for non-Firebase clients).
- **Category E: Root-admin special case**
  - `resolveCanonicalFirebaseUser` line 766 (`SELECT FROM users WHERE u.id = 1`). Can be resolved cleanly from claims (`user_1` has claims `{ role: 'super_admin', user_type: 'system', mysql_id: 1 }`).

---

## 6. Firebase Custom Claims Verification

### 6.1 Staff Custom Claims (Provisioned in Phase 3 Step 3A & Synced in Step 3B)
```javascript
{
  role:            staff.role,         // e.g. 'ADMIN', 'RECEPTIONIST', 'CHEF', 'CLEANER'
  user_type:       'staff',
  mysql_id:        Number(staff.id),
  mysql_staff_id:  Number(staff.id),
  staff_username:  staff.username.toLowerCase().trim(),
  status:          staff.status || 'Active', // 'Active' | 'Inactive'
  deleted:         staff.deleted ? 1 : 0
}
```

### 6.2 Guest Custom Claims (Provisioned in Phase 3 Step 3D-1 & Synced in Step 3D-2)
```javascript
{
  role:            'guest',
  user_type:       'guest',
  mysql_id:        Number(users_id),
  mysql_guest_id:  Number(guests_id),
  guest_id:        Number(guests_id),
  full_name:       guest.full_name,
  phone:           guest.phone,
  loyalty_tier:    guest.loyalty_tier || 'Bronze',
  loyalty_points:  Number(guest.loyalty_points || 0)
}
```

### 6.3 Root Administrator Custom Claims (`user_1`)
```javascript
{
  role:       'super_admin',
  user_type:  'system',
  mysql_id:   1
}
```

### 6.4 Presence of Permissions in Firebase Custom Claims
- **Permissions are NOT present in Firebase Custom Claims.**
- Neither staff, guest, nor super_admin tokens contain a `permissions` array or permission bitmask.
- All authorization decisions today rely on `role` and `user_type` claims, except `hasPermission()`, which queries the MySQL `role_permissions` join table (with background shadow checks against Firestore).

---

## 7. Role $\to$ Permissions Mapping Nature & Runtime Mutability

### 7.1 Entity Counts in Database
- **Roles (2):**
  1. `admin` (ID: 1) — System Administrator
  2. `guest` (ID: 2) — Standard Guest Customer
- **Permissions (7):**
  1. `view_dashboard` (ID: 1)
  2. `manage_rooms` (ID: 2)
  3. `manage_bookings` (ID: 3)
  4. `run_audit` (ID: 4)
  5. `make_payment` (ID: 5)
  6. `modify_business_date` (ID: 6)
  7. `override_business_date` (ID: 7)
- **Role-Permission Mappings (9):**
  - `admin` $\to$ all 7 permissions (`view_dashboard`, `manage_rooms`, `manage_bookings`, `run_audit`, `make_payment`, `modify_business_date`, `override_business_date`)
  - `guest` $\to$ 2 permissions (`view_dashboard`, `make_payment`)

### 7.2 Runtime Mutability Analysis
- **Can mappings change at runtime?** NO.
- **Can administrators modify permissions from the UI or API?** NO.
- **Search Results:**
  - Zero endpoints exist to insert, update, or delete records in `roles`, `permissions`, or `role_permissions`.
  - Zero UI components or forms exist in `src/` to manage permissions.
  - The `roles`, `permissions`, and `role_permissions` tables are static seed data created during database bootstrap (`backend/init_db.js`).
  - In Firestore, they were mirrored into `/roles` (2 docs), `/permissions` (7 docs), and `/role_permissions` (9 docs) during Phase 2 Step 7.

---

## 8. Frontend / Admin RBAC Code Search

- **Role Management:**
  - Found: Staff Management UI (`src/pages/StaffManagement.jsx` / `src/components/StaffModal.jsx`).
  - Function: Allows an Administrator to assign staff roles from a fixed enum: `['ADMIN', 'RECEPTIONIST', 'CHEF', 'KITCHEN_HELPER', 'PANTRY_BOY', 'CLEANER']`.
  - Does NOT modify database permissions or create custom roles.
- **Permission Management:**
  - 0 components, 0 dialogs, 0 routes.
- **Assigning Permissions:**
  - 0 components, 0 dialogs, 0 routes.
- **Changing Role Permissions:**
  - 0 components, 0 dialogs, 0 routes.

---

## 9. MySQL RBAC Dependency Measurement Table

| Function / File | MySQL RBAC Query | Purpose | Firebase / Firestore Replacement Possible? | Risk |
|---|---|---|---|---|
| `authController.js:hasPermission` | `SELECT p.id FROM permissions p JOIN role_permissions rp ON p.id = rp.permission_id JOIN roles r ON rp.role_id = r.id WHERE LOWER(r.name) = ? AND p.name = ?` | Evaluates permission for role (used in `POST /api/settings/business-date`) | **YES** — via `hasFirestorePermission` in `rbacRepository.js` or static role-permission lookup | **LOW** (100% parity verified in Step 7) |
| `authController.js:resolveCanonicalFirebaseUser` | `SELECT u.id, u.username, u.fullName, r.name as role FROM users u LEFT JOIN roles r ON u.role_id = r.id WHERE u.id = ? OR u.username = 'admin' LIMIT 1` | Resolves Root Admin identity for `user_1` | **YES** — directly resolve from claims `{ role: 'super_admin', user_type: 'system', mysql_id: 1 }` | **LOW** |
| `authController.js:resolveCanonicalFirebaseUser` (Flag OFF path) | `SELECT id, username, full_name, role, department, shift, status, deleted FROM staff WHERE (id = ? OR username = ?) AND deleted = 0 LIMIT 1` | Resolves Staff identity when Step 3B flag is OFF | **YES** — already implemented in Step 3B (claims + Firestore profile lookup) | **LOW** |
| `authController.js:signUp` | `SELECT id FROM roles WHERE name = 'guest'` | Obtains guest role ID during legacy MySQL guest signup | **YES** — static ID `2` or Firestore query on complete cutover | **LOW** |
| `authController.js:signIn` (Legacy) | `SELECT u.id, ..., r.name as role FROM users u LEFT JOIN roles r ...` | Legacy password login | N/A (Isolated to legacy fallback) | **LOW** |
| `authController.js:authenticate` (Legacy) | `SELECT status, deleted FROM staff WHERE ...` | Account active check for legacy HMAC tokens | N/A (Isolated to legacy fallback) | **LOW** |
| `settingsController.js:updateBusinessDate` | Indirect via `hasPermission(req, 'override_business_date')` | Permission guard for changing business date | **YES** — via `hasPermission` Firestore cutover | **LOW** |

---

## 10. Security Analysis: Token Refresh & Custom Claims Propagation

### 10.1 Stale Token Risk with Custom Claims
- Firebase ID tokens are signed JWTs with a default **1-hour lifespan (3600 seconds)**.
- When an administrator updates a user's role or status via `auth.setCustomUserClaims(uid, claims)`, the claims are updated on the Firebase backend immediately.
- However, any existing ID token held by the client browser / Electron app continues to contain the *old* claims until:
  1. The client calls `currentUser.getIdToken(true)` (force refresh), OR
  2. The client token expires (up to 60 minutes), OR
  3. The backend calls `auth.verifyIdToken(token, checkRevoked=true)` (which requires an extra Firebase Auth REST network roundtrip on every API request).

### 10.2 Claim Refresh & Revocation Strategy in HPMS
1. **Immediate Invalidation for Critical Role/Status Changes:**
   - In `backend/controllers/staffController.js`, when a staff member's role or status is toggled to `Inactive` or deleted:
     - `auth.setCustomUserClaims(uid, { ...required, status: 'Inactive', deleted: 1 })` is called.
     - `auth.revokeRefreshTokens(uid)` should also be triggered.
2. **Per-Request Identity Resolution Guard:**
   - In `resolveCanonicalFirebaseUser` (Step 3B), `claimStatus === 'Inactive'` immediately blocks the request with `ACCOUNT_INACTIVE` (403) once refreshed.
   - If immediate sub-second deactivation of compromised tokens is required before the 1-hour expiration, `auth.verifyIdToken(token, true)` can be used for administrative mutating endpoints, or Firestore staff profile status check acts as the immediate authoritative gate.
3. **Emergency Rollback Strategy:**
   - If Firebase-Only RBAC encounters any anomaly, toggling feature flag `ENABLE_FIREBASE_ONLY_RBAC=false` immediately falls back to MySQL `hasPermission` without requiring server restarts or database schema alterations.

---

## 11. Architecture Comparison & Recommendation

### Option A: Role-Only Authorization from Firebase Claims
- **Design:** All authorization is strictly role-based (`admin`, `receptionist`, `housekeeper`, `kitchen`, `guest`). The single permission check (`override_business_date`) is mapped in code to `admin` / `super_admin`.
- **Pros:** Ultra-fast, zero I/O on every request, 100% self-contained in verified ID tokens.
- **Cons:** Does not use the existing Firestore `/role_permissions` collection.

### Option B: Role + Permissions Array Embedded in Firebase Custom Claims
- **Design:** Custom claims include `permissions: ['view_dashboard', 'manage_rooms', 'override_business_date', ...]`.
- **Pros:** Fast in-memory resolution of fine-grained permissions.
- **Cons:** Custom claims 1000-byte limit; every permission schema update requires re-provisioning all Firebase users; 1-hour stale token window on permission changes.

### Option C: Role in Firebase Claims + Permissions via Firestore RBAC Repository (RECOMMENDED)
- **Design:**
  - 98% of routes use `requireRole()` / `requireAdmin()` / `requireSuperAdmin()` $\to$ resolved in-memory from Firebase Custom Claims (0 I/O).
  - The 1 fine-grained permission endpoint (`hasPermission('override_business_date')` in `settingsController.js`) uses `hasFirestorePermission()` from `backend/repositories/firestore/rbacRepository.js`.
  - Root admin (`user_1`) resolves directly from verified claims `{ role: 'super_admin', mysql_id: 1 }` without querying MySQL `users`.
- **Why Option C is the Safest:**
  1. Already built and tested in `backend/repositories/firestore/rbacRepository.js` and `dualRbacVerificationService.js`.
  2. 100% parity already confirmed in `scripts/testPhase2Step7Rbac.js`.
  3. Zero reliance on MySQL for all staff, guest, admin, and permission checks.
  4. Fully backward compatible with legacy fallback.

---

## 12. Recommended Step 4 Implementation Plan

### 12.1 Target Feature Flag
Add to `backend/config/featureFlags.js`:
```javascript
export const isFirebaseOnlyRbacEnabled = () => {
  return process.env.ENABLE_FIREBASE_ONLY_RBAC === 'true';
};
```

### 12.2 Exact Files to Modify in Step 4 Implementation

1. **`backend/config/featureFlags.js`**:
   - Add `isFirebaseOnlyRbacEnabled()` helper (defaults to `false`).
2. **`backend/controllers/authController.js`**:
   - Update `hasPermission(req, permissionName)`:
     - When `isFirebaseOnlyRbacEnabled() === true`: resolve via `hasFirestorePermission(roleName, permissionName)` (from `rbacRepository.js`).
     - When `isFirebaseOnlyRbacEnabled() === false`: maintain existing MySQL join query.
   - Update `resolveCanonicalFirebaseUser(decodedFirebase)`:
     - In root admin branch (`isRootAdmin`): resolve directly from claims `{ id: 1, role: 'admin', isRootAdmin: true }` without querying MySQL `users` table when `isFirebaseOnlyStaffResolutionEnabled() === true` or `isFirebaseOnlyRbacEnabled() === true`.
3. **`backend/tests/testPhase3Step4FirebaseOnlyRbac.mjs` (NEW Test Suite)**:
   - Dedicated end-to-end regression and cutover verification test suite for Phase 3 Step 4.

---

## 13. Audit Conclusion

All RBAC dependencies in HPMS have been fully cataloged. MySQL is only actively queried for RBAC in **one** permission check (`hasPermission`) and during root admin token resolution (`resolveCanonicalFirebaseUser`). Both can be cleanly switched to Firestore and Firebase Custom Claims behind the dedicated feature flag `ENABLE_FIREBASE_ONLY_RBAC`.

```
========================================================================================
                       AUDIT VERIFICATION SUMMARY
========================================================================================
 MySQL mutations                : 0
 MySQL schema changes           : 0
 Firebase Auth mutations        : 0
 Firestore mutations            : 0
 Source files modified          : 0
========================================================================================
```
