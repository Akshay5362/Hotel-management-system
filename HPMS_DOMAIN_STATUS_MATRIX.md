# HPMS-Sky5 — Phase 3A–3J Master Domain Status Matrix
**Document Version**: 2.0.0  
**Audit Date**: August 11, 2026  
**Audit Scope**: Empirical Code Verification of Phases 3A through 3J  

---

## Master Domain Inventory Table

| Phase | Operational Domain | MySQL Source-of-Truth | Firestore Collection | Controller / Service Write Paths | Outbox Event Types | Firestore Repository | Pilot Test File | Assertions Executed | Realized Status | Known Limitations |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **3A** | **Outbox Infrastructure** | `dual_write_outbox` | N/A | `outboxService.enqueue`, `outboxWorker.processOutboxBatch` | All Event Types | N/A | `testOutboxInfrastructure.mjs` | 12 | **Code Complete** (Flag Locked) | Worker process requires PM2/systemd daemon supervision in production |
| **3B** | **Room Types** | `room_types` | `room_types` | `roomTypeController.createRoomType`, `updateRoomType`, `deleteRoomType` | `ROOM_TYPE_CREATED`, `UPDATED`, `DELETED` | `roomTypesRepository.js` | `testRoomTypeDualWritePilot.mjs` | 12 | **Code Complete** (Flag Locked) | Room type code changes must maintain deterministic `type_${code}` ID format |
| **3C** | **Rooms** | `rooms` | `rooms` | `roomController.createRoom`, `updateRoom`, `updateRoomStatus`, `deleteRoom` | `ROOM_CREATED`, `UPDATED`, `STATUS_CHANGED`, `DELETED` | `roomsRepository.js` | `testRoomsDualWritePilot.mjs` | 14 | **Code Complete** (Flag Locked) | Check-In status transitions must coordinate with booking outbox events |
| **3D** | **Staff Profiles** | `staff`, `users` | `staff` | `staffController.createStaff`, `updateStaff`, `updateStaffStatus`, `deleteStaff` | `STAFF_CREATED`, `UPDATED`, `STATUS_CHANGED`, `DELETED` | `staffRepository.js` | `testStaffDualWritePilot.mjs` | 15 | **Code Complete** (Flag Locked) | `password_hash` strictly stripped from outbox payload & Firestore |
| **3E** | **Inventory Categories** | `inventory_categories` | `inventory_categories` | `inventoryController.createCategory`, `updateCategory`, `deleteCategory` | `INVENTORY_CATEGORY_CREATED`, `UPDATED`, `DELETED` | `inventoryCategoriesRepository.js` | `testInventoryCategoriesDualWritePilot.mjs` | 10 | **Code Complete** (Flag Locked) | Category deletions check for dependent products in MySQL first |
| **3F** | **System Settings** | `system_settings` | `system_settings` | `settingsController.updateSystemDate`, `updateSetting` | `SYSTEM_DATE_UPDATED`, `SYSTEM_SETTING_UPDATED` | `systemSettingsRepository.js` | `testSystemSettingsDualWritePilot.mjs` | 10 | **Code Complete** (Flag Locked) | Business date changes broadcast live via Socket.IO |
| **3G** | **Inventory Products** | `inventory_products` | `inventory_products` | `inventoryController.createProduct`, `updateProduct`, `updateStock`, `deleteProduct` | `INVENTORY_PRODUCT_CREATED`, `UPDATED`, `STOCK`, `DELETED` | `inventoryProductsRepository.js` | `testInventoryProductsDualWritePilot.mjs` | 11 | **Code Complete** (Flag Locked) | Photo uploads stored on disk (`/inventory-photos/`) and Firestore URL |
| **3H** | **Guest Profiles** | `guests`, `users` | `guests` | `checkInService.executeCheckIn`, `guestController` | `GUEST_CREATED`, `GUEST_UPDATED` | `guestsRepository.js` | `testGuestDualWritePilot.mjs` | 12 | **Code Complete** (Flag Locked) | Uploaded identity files (`id_doc_*`) stored on disk & Storage |
| **3I** | **Housekeeping** | `rooms`, `housekeeping_logs` | `housekeeping`, `rooms` | `housekeepingController.updateHousekeepingStatus`, `assignHousekeeper` | `HOUSEKEEPING_STATUS_UPDATED`, `LOG_CREATED` | `housekeepingRepository.js`, `roomsRepository.js` | `testHousekeepingDualWritePilot.mjs` | 12 | **Code Complete** (Flag Locked) | Dispatches dual outbox events (`HOUSEKEEPING` & `ROOM_STATUS_CHANGED`) |
| **3J** | **Audit Logs** | `audit_logs` | `audit_logs` | `auditController.createAuditLog` | `AUDIT_LOG_CREATED` | `auditLogsRepository.js` | `testAuditLogsDualWritePilot.mjs` | 8 | **Code Complete** (Flag Locked) | Append-only event stream; no update or deletion events supported |
