# HPMS-Sky5 — Engineering Gaps, Security Audit & Technical Debt Matrix
**Document Version**: 2.0.0  
**Audit Date**: August 11, 2026  
**Scope**: Technical Debt, Security Boundaries, Process Gaps & Risk Analysis  

---

## 1. Security & Sensitive Data Audit

1. **Password & Hash Stripping**:
   - Outbox dispatcher [`outboxDispatcher.js`](file:///d:/projects/hotel/backend/services/outboxDispatcher.js) and staff repository [`staffRepository.js`](file:///d:/projects/hotel/backend/repositories/firestore/staffRepository.js) explicitly strip `password` and `password_hash` fields from payload data prior to staging events or writing to Firestore documents.
2. **Role-Based Access Control (RBAC)**:
   - Configured via Firebase Custom Claims (`role`) and verified by [`backend/middleware/firebaseAuthMiddleware.js`](file:///d:/projects/hotel/backend/middleware/firebaseAuthMiddleware.js).
   - Enforced strictly across endpoints when `ENABLE_STRICT_RBAC=true`. Tested by [`scripts/testStrictRbac.js`](file:///d:/projects/hotel/scripts/testStrictRbac.js) for all 6 user roles (`super_admin`, `admin`, `receptionist`, `housekeeper`, `kitchen`, `guest`).
3. **Firestore Security & Storage Rules**:
   - `firestore.rules` enforces authenticated staff read/write access to administrative collections and restricts guest read access to owning documents (`request.auth.uid == resource.data.user_uid`).
   - `storage.rules` restricts image/PDF uploads to staff or owning guests and enforces a 5MB maximum file size limit.

---

## 2. Technical Debt Backlog

| Priority | Category | Problem Statement | Impact | Recommended Remediation |
| :--- | :--- | :--- | :--- | :--- |
| **P0 (Critical)**| Architecture | Direct SQL execution inside Express controllers (`roomController.js`, `paymentController.js`) | Monolithic controller files, difficult unit testing | Refactor database interactions into dedicated Service & Repository classes |
| **P1 (High)** | Testing | Absence of standard test runner (Vitest/Jest) in `package.json` | Manual CLI execution required for test suites | Add `vitest` dependency and `"test"` script commands |
| **P1 (High)** | Automation | Lack of automated CI/CD GitHub Actions workflow | Risk of regression code slipping into main branch | Implement GitHub Actions workflow running tests & build checks |
| **P2 (Medium)** | Frontend | Monolithic React components (`ReceptionPortal.jsx` is 99.8 KB) | High component complexity, rendering overhead | Split large components into smaller, modular sub-components |
| **P2 (Medium)** | Auth | Coexistence of legacy JWT auth alongside Firebase Auth | Duplicate authentication pathways | Deprecate legacy JWT auth routes in favor of Firebase Auth |
| **P3 (Low)** | Logging | Unstructured `console.log` statements in backend | Unformatted logs, harder log aggregation | Replace `console.log` with a structured logger (Winston/Pino) |

---

## 3. System Risk Matrix

| Risk Area | Severity | Risk Description | Empirical Evidence | Mitigation Recommendation |
| :--- | :--- | :--- | :--- | :--- |
| **Data Divergence** | HIGH | Background dual-write worker disabled, causing data divergence if enabled without seed sync | `ENABLE_FIRESTORE_DUAL_WRITE=false` in `.env` | Execute initial seed catch-up scripts before turning flag `true` |
| **Overbooking Race** | MEDIUM | Simultaneous check-in calls for a single vacant room could race if row locks omitted | Omission of `FOR UPDATE` in `checkInService.js` | Add `SELECT ... FOR UPDATE` row locks in check-in transactions |
| **Test Automation** | MEDIUM | Regression tests must be executed manually via CLI | Missing `"test"` command in `package.json` | Configure standard npm test scripts |

---

## 4. Engineering Process Gap Analysis

The audit identified key process gaps that should be formalized before initiating future domain developments:
1. **Formal PR Review Gate**: Lack of automated CI check enforcing test passing prior to code merge.
2. **Unit Test Standard**: Lack of unit tests for isolated business logic functions.
3. **Structured API Specification**: API endpoints are documented in markdown reports, but lack an OpenAPI / Swagger schema specification.
