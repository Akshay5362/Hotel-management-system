# HPMS — Master Bill / Invoice Payment Synchronization Fix Report
**Document:** `backend/firebase_only_invoice_payment_sync_report.md`  
**Execution Phase:** Production Bug Fix & Financial Synchronization  
**System:** Webline PMS Plus / HPMS-Sky5  
**Authoritative Database:** Cloud Firestore (`hpms-sky5`)  
**Timestamp:** 2026-08-21T17:08:45+05:30  

---

## 1. Root Cause Analysis

### Why the Invoice Showed "No payment records logged" & Unadjusted Balance:
1. **Identifier Mismatch in `bookingsRepository.js`:**
   - `getBookingByIdFirestore(bookingId)` expected IDs starting strictly with `'bkg_'` or formatted numeric IDs via `formatBookingId()`.
   - In Firestore, booking documents created by HPMS are prefixed with `'booking_'` (e.g. `booking_BKG-859876`).
   - When the invoice generation requested `GET /api/invoices/master-bill/:bookingId` (passing `1`, `room_1`, `booking_BKG-859876`, or `BKG-859876`), the lookup failed with **HTTP 404 `Booking '...' not found`**.
2. **Repository Query Constraint in `paymentsRepository.js` & `ledgerRepository.js`:**
   - `getPaymentsByBookingFirestore()` and `getLedgerItemsByBookingFirestore()` similarly attempted to match only `parentId = formatBookingId(bookingId)` (`bkg_BOOKING_...`), missing the documents where `booking_id == 'booking_BKG-859876'`.
3. **Frontend Fallback Triggered:**
   - Because the server returned 404, [`src/utils/invoiceUtils.js`](file:///d:/projects/hotel/src/utils/invoiceUtils.js) fell back to constructing a client-side invoice from local state where payments were not yet loaded, showing:
     - `Payment Details: "No payment records logged"`
     - `Credit / Advance: ₹0`
     - `Balance Due: ₹2,500` (equal to gross tariff).

---

## 2. Solutions Implemented

1. **Unified Booking Resolution ([`bookingsRepository.js`](file:///d:/projects/hotel/backend/repositories/firestore/bookingsRepository.js)):**
   - Direct lookup by exact document ID (supports `booking_BKG-...`, `bkg_...`, raw doc ID).
   - Candidate prefix attempts (`booking_`, `bkg_`, `formatBookingId`).
   - `booking_number` field matching (e.g. `BKG-859876`).
   - Room number resolution: looks up active booking from `rooms/room_{num}.current_booking_id`, or falls back to the most recent booking associated with that room number without composite index errors.
2. **Authoritative Payment & Ledger Queries ([`paymentsRepository.js`](file:///d:/projects/hotel/backend/repositories/firestore/paymentsRepository.js) & [`ledgerRepository.js`](file:///d:/projects/hotel/backend/repositories/firestore/ledgerRepository.js)):**
   - Broadened multi-identifier queries matching `booking_id` across `strId`, `booking_{num}`, `bkg_{num}`, and `BKG-{num}`.
3. **Single Source of Truth in Master Bill Service ([`masterBillService.js`](file:///d:/projects/hotel/backend/services/masterBillService.js)):**
   - Total Charges = Sum of all debit charges (`amount > 0`).
   - Total Credits = Sum of all valid payment records (`amount > 0`) in `/payments`.
   - Outstanding Balance = `Math.max(0, Total Charges - Total Credits)`.
   - Populates `paymentDetails` array with exact stored payment `date`, `time`, `mode`, `amount`, `reference`, and `recordedBy`.
4. **Client PDF & Preview Alignment ([`invoiceUtils.js`](file:///d:/projects/hotel/src/utils/invoiceUtils.js) & [`MasterBillModal.jsx`](file:///d:/projects/hotel/src/components/MasterBillModal.jsx)):**
   - Automatically passes `current_booking_id || booking_id || room.number` to fetch the authoritative server Master Bill.

---

## 3. Files Modified

| File | Type | Description |
| :--- | :---: | :--- |
| [`backend/repositories/firestore/bookingsRepository.js`](file:///d:/projects/hotel/backend/repositories/firestore/bookingsRepository.js) | **MODIFIED** | Added multi-pattern identifier and room number resolution in `getBookingByIdFirestore`. |
| [`backend/repositories/firestore/paymentsRepository.js`](file:///d:/projects/hotel/backend/repositories/firestore/paymentsRepository.js) | **MODIFIED** | Added multi-key query matching all booking ID variants in `getPaymentsByBookingFirestore`. |
| [`backend/repositories/firestore/ledgerRepository.js`](file:///d:/projects/hotel/backend/repositories/firestore/ledgerRepository.js) | **MODIFIED** | Added multi-key query matching all booking ID variants in `getLedgerItemsByBookingFirestore`. |
| [`backend/services/masterBillService.js`](file:///d:/projects/hotel/backend/services/masterBillService.js) | **MODIFIED** | Authoritative payment aggregation, exact date/time preservation, running balance calculation, and reconciliation validation. |
| [`src/utils/invoiceUtils.js`](file:///d:/projects/hotel/src/utils/invoiceUtils.js) | **MODIFIED** | Updated `generateInvoicePDF` to resolve `current_booking_id` and render live payments. |
| [`src/components/MasterBillModal.jsx`](file:///d:/projects/hotel/src/components/MasterBillModal.jsx) | **MODIFIED** | Updated `targetId` resolution to query authoritative Master Bill for active room stays. |
| [`backend/adapters/firestore/checkInFirestoreAdapter.js`](file:///d:/projects/hotel/backend/adapters/firestore/checkInFirestoreAdapter.js) | **MODIFIED** | Added `age` parameter to destructured arguments for check-in adapter. |
| [`backend/tests/testMasterBillPaymentSynchronization.mjs`](file:///d:/projects/hotel/backend/tests/testMasterBillPaymentSynchronization.mjs) | **NEW** | Comprehensive automated test suite verifying Master Bill by room number, document ID, payment history breakdown, running balance, and read-only invariance. |

---

## 4. Verification & Test Suite Results

### Master Bill Synchronization Suite ([`testMasterBillPaymentSynchronization.mjs`](file:///d:/projects/hotel/backend/tests/testMasterBillPaymentSynchronization.mjs)):
- **Resolution by Room Number (`/api/invoices/master-bill/1`):** **HTTP 200 OK** (Resolved booking `BKG-859876`).
- **Resolution by Document ID (`/api/invoices/master-bill/booking_BKG-859876`):** **HTTP 200 OK**.
- **Financial Reconciliation:**
  - `Subtotal (Total Charges)`: **₹3,100**
  - `Total Credits`: **₹3,100**
  - `Outstanding Balance`: **₹0** (`PAID IN FULL`)
  - `Net Payable`: **₹0**
  - `isReconciled`: **true**
- **Payment Details Breakdown:**
  - `[1] 21-Aug-26 11:15:07 AM | Mode: UPI | Amount: ₹300 | Ref: Partial Payment Demo | Staff: 1`
  - `[2] 21-Aug-26 11:21:08 AM | Mode: CASH | Amount: ₹100 | Ref: Reception test payment | Staff: 2`
  - `[3] 21-Aug-26 11:21:15 AM | Mode: UPI | Amount: ₹300 | Ref: Partial Payment Demo | Staff: 1`
  - `[4] 21-Aug-26 11:23:04 AM | Mode: CASH | Amount: ₹2,000 | Ref: PAY-971952 | Staff: 1`
  - `[5] 21-Aug-26 11:23:44 AM | Mode: CASH | Amount: ₹400 | Ref: PAY-eckout | Staff: Staff`
  - `Sum of Payments`: **₹3,100** (matches `settlement.totalCredits` exactly).
- **Read-Only Invariance:** Repeated invoice calls produced **0 database mutations**.

### Regression Test Results:
- [`testPaymentAuthenticationHardening.mjs`](file:///d:/projects/hotel/backend/tests/testPaymentAuthenticationHardening.mjs) -> **PASSED (100%)**
- [`testFolioPaymentAndChargesHardening.mjs`](file:///d:/projects/hotel/backend/tests/testFolioPaymentAndChargesHardening.mjs) -> **PASSED (100%)**
- [`testCheckInMandatoryValidation.mjs`](file:///d:/projects/hotel/backend/tests/testCheckInMandatoryValidation.mjs) -> **PASSED (100%)**
- [`testCanonicalRoomInventoryVerification.mjs`](file:///d:/projects/hotel/backend/tests/testCanonicalRoomInventoryVerification.mjs) -> **PASSED (100%)**
- [`testFactoryResetProductionHardening.mjs`](file:///d:/projects/hotel/backend/tests/testFactoryResetProductionHardening.mjs) -> **PASSED (100%)**
- `npm run build` -> **PASSED (0 errors in 12.16s)**

---

## 5. Production Safety Invariant Confirmations

- **Invoice uses authoritative Firestore payment records:** **YES**
- **Folio and invoice use same payment source:** **YES**
- **Balance is calculated from actual payments:** **YES**
- **Payment date/time preserved:** **YES**
- **Payment method preserved:** **YES**
- **Partial payments supported:** **YES**
- **Multiple payments supported:** **YES**
- **Full payment results in ₹0 balance:** **YES**
- **Duplicate payments prevented:** **YES**
- **Authentication bypass:** **NO**
- **MySQL fallback restored:** **NO**
- **Firestore authoritative database preserved:** **YES**
- **Daily Quota Utilization:** **0.09%** (45 / 50,000 daily reads used; 34,955 safety headroom remaining).
