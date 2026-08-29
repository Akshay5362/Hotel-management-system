# HPMS-Sky5 — Reusable Feature Implementation Quality Checklist
**Document Version**: 1.0.0  
**Purpose**: Standard Quality Gate Checklist for All Future Feature Implementations  

---

## Standard Feature Implementation Quality Checklist

Every future HPMS-Sky5 feature or domain expansion **MUST** satisfy all 15 checklist gates prior to code submission:

### 1. Requirements & Discovery
- [ ] 1. Operational objective and business requirements clearly specified.
- [ ] 2. Source code and database schemas empirically inspected (no blind assumptions).

### 2. Architecture & Design
- [ ] 3. Database schema impacts and foreign key dependencies mapped.
- [ ] 4. API endpoints, HTTP methods, and payload contracts defined.
- [ ] 5. Firebase Auth custom claims and RBAC permissions (`super_admin`, `admin`, `receptionist`, `housekeeper`, etc.) assigned.
- [ ] 6. Concurrency risks evaluated and row-level locking (`SELECT ... FOR UPDATE`) specified where needed.

### 3. Outbox & Dual-Write Design (If Applicable)
- [ ] 7. Transactional Outbox event payload schema defined.
- [ ] 8. Sensitive data protection verified (Passwords, hashes, and secrets strictly excluded from events).
- [ ] 9. Deterministic Firestore document ID strategy specified.
- [ ] 10. Stale event guard (`isStaleUpdate()`) and idempotency handling confirmed.

### 4. Implementation & Testing
- [ ] 11. Dedicated automated pilot test suite created in `backend/tests/test<Feature>DualWritePilot.mjs`.
- [ ] 12. Test cleanup logic strictly enclosed inside `try ... finally` blocks.
- [ ] 13. Operational backend write operations enqueued inside active MySQL transactions.

### 5. Verification & Delivery
- [ ] 14. All automated test suites passing with 100% success (`node backend/tests/test*.mjs`).
- [ ] 15. Production build (`npm run build`) and syntax check (`node --check`) passing cleanly without errors.
