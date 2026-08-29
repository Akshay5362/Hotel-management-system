# HPMS — Check-In Guest Profile & Mandatory Field Validation Upgrade
**Document:** `backend/firebase_only_checkin_mandatory_fields_implementation.md`  
**Execution Phase:** Check-In Guest Profile Mandatory Validation Upgrade  
**System:** Webline PMS Plus / HPMS-Sky5  
**Authoritative Database:** Cloud Firestore (`hpms-sky5`)  
**Timestamp:** 2026-08-21T16:21:40+05:30  

---

## 1. Executive Summary

A production-safe validation and UI upgrade has been implemented for the HPMS Check-In workflow. Before any Firestore transaction or business-data mutation is initiated, **14 mandatory check-in fields** across Guest, Stay, and Billing domains are strictly validated both client-side and server-side.

All invalid check-in requests fail closed with structured **HTTP 400 `CHECKIN_VALIDATION_FAILED`** responses with zero Firestore mutations.

---

## 2. Files Modified & Created

| File | Type | Description |
| :--- | :---: | :--- |
| [`backend/validators/checkInValidator.js`](file:///d:/projects/hotel/backend/validators/checkInValidator.js) | **NEW** | Pre-transaction validator module enforcing all 14 mandatory fields and formatting rules. |
| [`backend/controllers/roomController.js`](file:///d:/projects/hotel/backend/controllers/roomController.js) | **MODIFIED** | Integrated `validateCheckInPayload` to fail closed before calling `CheckInCutoverService`. |
| [`backend/adapters/firestore/checkInFirestoreAdapter.js`](file:///d:/projects/hotel/backend/adapters/firestore/checkInFirestoreAdapter.js) | **MODIFIED** | Preserved transaction boundary while mapping sanitized `age`, `email`, `country`, `state`, `address`, `purpose_of_visit`, `children`, `room_tariff`. |
| [`src/components/CheckInModal.jsx`](file:///d:/projects/hotel/src/components/CheckInModal.jsx) | **MODIFIED** | Redesigned Check-In modal into 3 structured sections with `*` indicators and live field-level validation. |
| [`backend/tests/testCheckInMandatoryValidation.mjs`](file:///d:/projects/hotel/backend/tests/testCheckInMandatoryValidation.mjs) | **NEW** | Automated test suite covering 22 test cases (missing/invalid fields, edge cases, zero mutations). |

---

## 3. Mandatory Fields & Canonical Firestore Schema Mapping

| # | Field Label | Domain | Validation Rules | Canonical Firestore Field | Collection |
| :---: | :--- | :--- | :--- | :--- | :--- |
| 1 | **Full Name** | Guest | Required, trimmed, min 2 characters | `full_name` / `guest_name` | `/guests`, `/bookings` |
| 2 | **Age** | Guest | Required, integer (1–125) | `age` | `/guests`, `/bookings` |
| 3 | **Contact Number** | Guest | Required, phone format (min 7 digits) | `phone` | `/guests`, `/bookings` |
| 4 | **Email Address** | Guest | Required, valid RFC-compliant email | `email` | `/guests`, `/bookings` |
| 5 | **Country** | Guest | Required, non-blank string | `country` | `/guests`, `/bookings` |
| 6 | **State** | Guest | Required, non-blank string | `state` | `/guests`, `/bookings` |
| 7 | **Address** | Guest | Required, non-blank string (min 3 chars) | `address` | `/guests`, `/bookings` |
| 8 | **Purpose of Visit** | Guest | Required (Personal, Business, Official, Tourist, Function) | `purpose_of_visit` | `/bookings` |
| 9 | **Number of Pax** | Stay | Required, integer >= 1 | `adults` / `pax` | `/bookings` |
| 10 | **Arrival Date** | Stay | Required, valid date format | `check_in_date` | `/bookings` |
| 11 | **Departure Date** | Stay | Required, valid date, Departure > Arrival | `expected_check_out_date` | `/bookings` |
| 12 | **Number of Children** | Stay | Required, integer >= 0 | `children` | `/bookings` |
| 13 | **Billing Instructions** | Billing | Required (Direct to Guest, Bill to Company, Room Tariff Only) | `billing_instruction` | `/bookings` |
| 14 | **Room Rent / Tariff** | Billing | Required, positive number > 0 | `room_tariff` / `total_amount` | `/bookings`, `/ledger_items` |

---

## 4. Backend Validation Contract (Fail-Closed)

### HTTP 400 Response Format:
```json
{
  "error": "CHECKIN_VALIDATION_FAILED",
  "message": "Required check-in information is missing or invalid.",
  "fields": {
    "fullName": "Full name is required",
    "email": "Please enter a valid email address",
    "departureDate": "Departure date must be after arrival date"
  }
}
```

### Pre-Transaction Enforcement Guarantee:
Validation is executed in [`roomController.js`](file:///d:/projects/hotel/backend/controllers/roomController.js) **prior** to calling `CheckInCutoverService` and before opening any Cloud Firestore atomic transaction or writing any record.

---

## 5. Verification & Test Suite Results

### Automated Validation Suite ([`testCheckInMandatoryValidation.mjs`](file:///d:/projects/hotel/backend/tests/testCheckInMandatoryValidation.mjs)):
- **Case A: Missing Full Name** -> HTTP 400 (`fullName: "Full name is required"`)
- **Case B: Short Full Name** -> HTTP 400 (`fullName: "Full name must be at least 2 characters"`)
- **Case C: Missing Age** -> HTTP 400 (`age: "Age is required"`)
- **Case D: Invalid Age (<= 0)** -> HTTP 400 (`age: "Age must be a valid positive integer between 1 and 125"`)
- **Case E: Invalid Age (alphabetic)** -> HTTP 400 (`age: "Age must be a valid positive integer between 1 and 125"`)
- **Case F: Missing Phone** -> HTTP 400 (`contactNumber: "Contact number is required"`)
- **Case G: Invalid Phone** -> HTTP 400 (`contactNumber: "Please enter a valid contact number (minimum 7 digits)"`)
- **Case H: Missing Email** -> HTTP 400 (`email: "Email address is required"`)
- **Case I: Invalid Email Format** -> HTTP 400 (`email: "Please enter a valid email address"`)
- **Case J: Missing Country** -> HTTP 400 (`country: "Country is required"`)
- **Case K: Missing State** -> HTTP 400 (`state: "State is required"`)
- **Case L: Missing Address** -> HTTP 400 (`address: "Address is required"`)
- **Case M: Missing Purpose of Visit** -> HTTP 400 (`purposeOfVisit: "Purpose of visit is required"`)
- **Case N: Pax = 0** -> HTTP 400 (`pax: "Pax must be at least 1"`)
- **Case O: Pax Negative** -> HTTP 400 (`pax: "Pax must be at least 1"`)
- **Case P: Children Negative** -> HTTP 400 (`children: "Children must be a non-negative integer"`)
- **Case Q: Missing Arrival Date** -> HTTP 400 (`arrivalDate: "Arrival date is required"`)
- **Case R: Missing Departure Date** -> HTTP 400 (`departureDate: "Departure date is required"`)
- **Case S: Departure <= Arrival** -> HTTP 400 (`departureDate: "Departure date must be after arrival date"`)
- **Case T: Missing Billing Instructions** -> HTTP 400 (`billingInstructions: "Billing instructions are required"`)
- **Case U: Missing Room Rent** -> HTTP 400 (`roomRent: "Room rent is required"`)
- **Case V: Room Rent <= 0** -> HTTP 400 (`roomRent: "Room rent must be a positive number greater than 0"`)
- **Zero Mutation Confirmation:** Verified Room 4 remained `vacant` with 0 documents created across all 22 rejected test check-ins.

### Regression & Build Verification:
- [`testCanonicalRoomInventoryVerification.mjs`](file:///d:/projects/hotel/backend/tests/testCanonicalRoomInventoryVerification.mjs) -> **PASSED (100%)**
- [`testFactoryResetProductionHardening.mjs`](file:///d:/projects/hotel/backend/tests/testFactoryResetProductionHardening.mjs) -> **PASSED (100%)**
- `npm run build` -> **PASSED (0 errors, 11.88s)**

---

## 6. Implementation Invariant Summary

- **Invalid Check-In Firestore mutations:** **0**
- **MySQL fallback restored:** **NO**
- **Outbox restored:** **NO**
- **Factory Reset executed during this task:** **NO**
- **Production test fixtures created:** **0**
- **Existing Check-In transaction preserved:** **YES**
- **Authoritative Database:** Cloud Firestore (`hpms-sky5`)
