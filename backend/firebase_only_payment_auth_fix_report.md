# HPMS — Folio Payment Authorization Header Fix Report
**Document:** `backend/firebase_only_payment_auth_fix_report.md`  
**Execution Phase:** Production Bug Fix & Auth Header Standardization  
**System:** Webline PMS Plus / HPMS-Sky5  
**Authoritative Database:** Cloud Firestore (`hpms-sky5`)  
**Timestamp:** 2026-08-21T16:51:45+05:30  

---

## 1. Root Cause & Investigation

### Exact Failure Traced:
- **Frontend File & Function:** [`src/components/CheckOutModal.jsx`](file:///d:/projects/hotel/src/components/CheckOutModal.jsx) -> `handleRecordPayment` and `fetchLiveLedger`.
- **Root Cause:** The modal attempted to read `localStorage.getItem('hpms_token')` instead of the application's canonical token key (`adminToken` / `token`). Because `hpms_token` was `null`, the request headers contained an empty authorization value.
- **Backend Endpoint:** `POST /api/rooms/:number/payments`
- **Backend Authentication:** Protected by `authenticate` and `requireRole('admin', 'receptionist')` in [`backend/routes/api.js`](file:///d:/projects/hotel/backend/routes/api.js).
- **Backend Response:** When the header was missing/empty, `authController.js` correctly failed closed with **HTTP 401 `Authorization header is missing`**.

---

## 2. Solution & Architectural Alignment

1. **Centralized Auth Header Utility Reused:**
   - Updated [`src/components/CheckOutModal.jsx`](file:///d:/projects/hotel/src/components/CheckOutModal.jsx) to import `API_URL` and `getApiHeaders` from [`src/config/apiConfig.js`](file:///d:/projects/hotel/src/config/apiConfig.js).
   - Resolved token via `token || localStorage.getItem('adminToken') || localStorage.getItem('token')`.
   - Wired `token={adminToken}` from [`src/App.jsx`](file:///d:/projects/hotel/src/App.jsx) directly to `<CheckOutModal />`.
2. **Strict Backend Protection Preserved:**
   - Zero middleware changes; zero authorization bypasses; zero public routes created.
   - Endpoint continues strictly requiring `authenticate` + `requireRole('admin', 'receptionist')`.

---

## 3. Files Modified

| File | Type | Description |
| :--- | :---: | :--- |
| [`src/components/CheckOutModal.jsx`](file:///d:/projects/hotel/src/components/CheckOutModal.jsx) | **MODIFIED** | Wired `getApiHeaders(getAuthToken())` and `API_URL` for `fetchLiveLedger`, `handleRecordPayment`, and `handlePostCharge`. |
| [`src/App.jsx`](file:///d:/projects/hotel/src/App.jsx) | **MODIFIED** | Passed `token={adminToken}` prop to `CheckOutModal`. |
| [`backend/tests/testPaymentAuthenticationHardening.mjs`](file:///d:/projects/hotel/backend/tests/testPaymentAuthenticationHardening.mjs) | **NEW** | Added automated suite verifying missing token (401), invalid token (401), unauthorized role (403), valid staff payment (200), and idempotency replay. |

---

## 4. Verification & Security Test Suite Results

### Security & Authentication Tests ([`testPaymentAuthenticationHardening.mjs`](file:///d:/projects/hotel/backend/tests/testPaymentAuthenticationHardening.mjs)):
- **Missing Authorization Header:** Rejected with **HTTP 401 `Authorization header is missing`**.
- **Invalid / Forged Bearer Token:** Rejected with **HTTP 401 `Invalid or expired token`**.
- **Unauthorized Role (Guest Token):** Rejected with **HTTP 403 `Forbidden: Insufficient permissions`**.
- **Authorized Staff / Receptionist Token:** **HTTP 200 OK** (Payment of ₹100 successfully recorded).
- **Idempotency Protection:** Replayed duplicate payment request with identical key returned cached response (`replayed: true`) with **zero duplicate charges**.

### Folio Hardening Regression ([`testFolioPaymentAndChargesHardening.mjs`](file:///d:/projects/hotel/backend/tests/testFolioPaymentAndChargesHardening.mjs)):
- **Predefined Charge (Laundry ₹300):** **HTTP 200 OK** (Balance increased ₹2,400 -> ₹2,700).
- **Overpayment Guard:** Attempting to record ₹3,200 against ₹2,700 balance rejected with **HTTP 400 `PAYMENT_EXCEEDS_BALANCE`**.
- **Partial Payment (₹300 UPI):** **HTTP 200 OK** (Balance restored to ₹2,400).
- **Frontend Build (`npm run build`):** **PASSED (0 errors in 11.84s)**.

---

## 5. Production Safety Invariant Confirmations

- **Authorization bypass:** **NO**
- **Authentication middleware weakened:** **NO**
- **Public payment endpoint:** **NO**
- **Hardcoded token:** **NO**
- **Firestore authoritative DB preserved:** **YES**
- **MySQL fallback restored:** **NO**
- **Duplicate payment protection preserved:** **YES**
- **Read Budget Utilization:** **0.06%** (29 / 50,000 daily reads used; 34,971 safety headroom remaining).
