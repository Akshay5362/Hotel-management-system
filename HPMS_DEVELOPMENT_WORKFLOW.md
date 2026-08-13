# HPMS-Sky5 — Recommended Development Lifecycle & Feature Readiness Framework
**Document Version**: 2.0.0  
**Audit Date**: August 11, 2026  
**Purpose**: Standard Engineering Lifecycle & Quality Checklist  

---

## 1. Standard Development Lifecycle (16 Stages)

```
1. Requirement & Discovery
       │
       ▼
2. Architecture & Database Schema Design
       │
       ▼
3. API Contract & Security/RBAC Definition
       │
       ▼
4. Implementation Plan Document Creation (implementation_plan.md)
       │
       ▼
5. User Review & Explicit Plan Approval
       │
       ▼
6. Feature Development (Services & Controllers)
       │
       ▼
7. Outbox Event Staging (Inside MySQL Transaction)
       │
       ▼
8. Outbox Dispatcher & Firestore Repository Mapping
       │
       ▼
9. Automated Pilot Test Creation (with try/finally cleanup)
       │
       ▼
10. Automated Pilot Test Execution (node backend/tests/test*.mjs)
       │
       ▼
11. Regression Test Execution (Phase 2 & Pilot Suites)
       │
       ▼
12. Syntax Verification (node --check backend/...)
       │
       ▼
13. Production Build Verification (npm run build)
       │
       ▼
14. Git Safety Audit (git diff --check)
       │
       ▼
15. Walkthrough Report Creation (walkthrough.md / PHASE_*_REPORT.md)
       │
       ▼
16. Code Submission & User Review
```

---

## 2. Pre-Implementation Quality Checklist

Before starting implementation of any future HPMS feature, the following 15-point quality gate **MUST** be completed:

- [ ] **1. Requirement & Business Goal Defined**: Clear operational objective established.
- [ ] **2. Source Code & Schema Inspected**: Codebase inspected empirically (no blind assumptions).
- [ ] **3. Database Impact Mapped**: MySQL table modifications and foreign keys identified.
- [ ] **4. API Contract Defined**: Endpoints, HTTP methods, request/response JSON schemas documented.
- [ ] **5. Security & RBAC Verified**: User role permissions (`super_admin`, `admin`, `receptionist`, etc.) assigned.
- [ ] **6. Concurrency Requirements Analyzed**: Row-level locking (`FOR UPDATE`) evaluated.
- [ ] **7. Outbox Event Schema Defined**: Payload keys and aggregate IDs specified.
- [ ] **8. Sensitive Data Protection Verified**: Password hashes & secrets strictly excluded from outbox.
- [ ] **9. Automated Test Suite Written**: Dedicated test file created in `backend/tests/`.
- [ ] **10. Cleanup Safety Guaranteed**: Test cleanup enclosed inside `try ... finally` blocks.
- [ ] **11. Automated Regression Passing**: All pilot tests pass with 100% success.
- [ ] **12. Syntax Check Clean**: `node --check` verifies zero syntax errors.
- [ ] **13. Production Build Passing**: `npm run build` compiles without errors.
- [ ] **14. Git Safety Clean**: `git diff --check` shows zero whitespace or merge marker issues.
- [ ] **15. User Approval Obtained**: Implementation plan reviewed and approved.

---

## 3. Phase 3K Evaluation & Recommendation

### Remaining Unmigrated Operational Domains
The following operational domains remain MySQL-only for mutations:
1. **Bookings & Check-In / Check-Out** (`bookings`, `booking_history`)
2. **Reservations** (`reservations`)
3. **Payments** (`payments`)
4. **Ledger Items** (`ledger_items`)
5. **Invoices** (`invoices`)
6. **Cash Drawer Logs** (`cash_logs`, `cash_submissions`)
7. **Night Audit** (Multi-table transaction engine)

### Recommended Candidate for Phase 3K: Bookings Domain (`bookings`)
- **Reasoning**:
  - `bookings` is the central hub connecting `rooms`, `guests`, `payments`, and `ledger_items`.
  - Phase 2 Firestore repository ([`bookingsRepository.js`](file:///d:/projects/hotel/backend/repositories/firestore/bookingsRepository.js)) is already fully implemented and verified.
  - Phase 3C (Rooms) and Phase 3H (Guest Profiles) dual-write outbox event structures are already in place, providing the exact required dependencies for Bookings outbox event staging (`BOOKING_CREATED`, `BOOKING_UPDATED`, `CHECK_IN_COMPLETED`, `CHECK_OUT_COMPLETED`).
- **Phase 3K Readiness**: **READY FOR DESIGN (DO NOT IMPLEMENT YET)**.
