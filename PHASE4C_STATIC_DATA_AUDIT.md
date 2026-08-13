# PHASE 4C: STATIC / OPERATIONAL MASTER DATA MIGRATION AUDIT

## A. MySQL Source Counts (Current Baseline)
- `room_types`: 4 standard records
- `rooms`: 17 records
- `inventory_categories`: 11 records
- `inventory_products`: 3 records

## B. Complete Field Mapping

### 1. `rooms` Table -> `rooms` Collection
| MySQL Field | Firestore Field | Transformation / Notes |
| :--- | :--- | :--- |
| `id` | `mysql_room_id` | Crucial bridge field. |
| `number` | `number` | Cast to String. |
| `room_type_id` | `mysql_room_type_id` | Crucial bridge field. |
| *derived* | `type` | Must JOIN `room_types` in MySQL to get the `code` string. Required by `roomsRepository.js`. |
| `status` | `status` | Default `'vacant'`. |
| `housekeeping_status` | `housekeeping_status` / `cleaning_status` | Repo saves both fields. |
| `housekeeping_assigned_to` | `housekeeping_assigned_to` | |
| `housekeeping_priority` | `housekeeping_priority` | |
| `last_cleaned_at` | `last_cleaned_at` | Convert to ISO-8601 String. |
| *inferred* | `price` | Fetch `base_rate` from joined `room_types`. |
| *default* | `amenities` | `[]` |

### 2. `room_types` Table -> `room_types` Collection
*(Note: Seeded in Phase 4A, but included for completeness and idempotency).*
| MySQL Field | Firestore Field | Transformation / Notes |
| :--- | :--- | :--- |
| `id` | `mysql_room_type_id` | |
| `code` | `code` | Uppercase String. |
| `title` | `name` / `title` | Repo canonical is `name`, alias `title`. |
| `description` | `description` | |
| `base_rate` | `base_rate` | Number. |
| `image` | `image` | String (emoji/url). |

### 3. `inventory_categories` Table -> `inventory_categories` Collection
| MySQL Field | Firestore Field | Transformation / Notes |
| :--- | :--- | :--- |
| `id` | `mysql_category_id` | |
| `name` | `name` | String. |
| `department` | `department` | String (default 'General'). |
| `created_at` | `created_at` | ISO-8601 String. |

### 4. `inventory_products` Table -> `inventory_products` Collection
| MySQL Field | Firestore Field | Transformation / Notes |
| :--- | :--- | :--- |
| `id` | `mysql_product_id` | |
| `sku` | `sku` | Uppercase String. |
| `name` | `name` | String. |
| `category_id` | `mysql_category_id` | MySQL foreign key bridge. |
| *derived* | `category_id` | Firestore expects the Category Doc ID (`cat_{slug}`). Must JOIN `inventory_categories`. |
| `unit_of_measure` | `unit_of_measure` / `unit`| Repo saves both. |
| `minimum_stock_level` | `minimum_stock_level` / `reorder_level`| Repo saves both. |
| `current_stock` | `current_stock` / `stock_quantity` | Repo saves both. |
| `unit_price` | `unit_price` | Number. |
| `photo_url` | `photo_url` | String. |
| `status` | `status` | String (default 'Active'). |
| `created_at` / `updated_at` | `created_at` / `updated_at` | ISO-8601 String. |

## C. Firestore Target Collection Mapping
- `room_types` -> `/room_types`
- `rooms` -> `/rooms`
- `inventory_categories` -> `/inventory_categories`
- `inventory_products` -> `/inventory_products`

## D. Deterministic Document ID Convention
Based on `backend/repositories/firestore/firestoreUtils.js`:
1. **Rooms**: `formatRoomId(number)` -> `room_{number}`
2. **Room Types**: `type_{CODE}` (uppercase, e.g., `type_STANDARD`)
3. **Inventory Categories**: `formatCategoryDocId(name)` -> `cat_{lowercase_slug}`
4. **Inventory Products**: `formatProductDocId(sku)` -> `prod_{lowercase_slug}`

## E. Foreign-Key / Reference Mapping
1. **Rooms**: Needs `room_types.code` to populate the `type` field in the Firestore `/rooms` doc. The migration script must perform a SQL `JOIN` on `room_types` to fetch this.
2. **Inventory Products**: Needs `inventory_categories.name` to generate the Firestore `cat_{slug}` doc ID for the `category_id` relationship field. The script must perform a SQL `JOIN` on `inventory_categories`.

## F. Required Timestamps/Date Conversions
MySQL `DATETIME` / `TIMESTAMP` fields must be mapped using `new Date(row.timestamp).toISOString()`.

## G. Null / Default Handling
The migration scripts will respect the defaults defined in the respective repositories (e.g., `status: 'vacant'`, `current_stock: 0`).

## H. Existing Firestore Document Conflicts
- `room_types` contains duplicate schemas (e.g., `room_type_1` vs `type_STANDARD`). 
- **Resolution**: We write exclusively to the canonical deterministic IDs (e.g. `type_STANDARD`) using `{ merge: true }`.

## I. Existing Orphan Documents
- We will NOT delete orphans (like `room_type_1`). It is safer to leave them unused until a later garbage collection phase.

## J. Security-Rule Requirements
- Verified in `firestore.rules`.
- `rooms`: `isAuthenticated()` read, `isStaff()` write.
- `inventory_*`: `isStaff()` read, `isAdmin()` write.
- **No changes required.**

## K. Index Requirements
- Default single-field indexes are sufficient. No composite indexes are required for this static data.

## L. Existing Repository Compatibility
- The migration scripts will use `batch.set(ref, data, { merge: true })` using the exact payload structures expected by the repositories.

## M. Missing Fields for Future Operation
- None.

## N. Exact Blockers
- **None.** The path is completely clear.

## O. Recommended Migration Order
1. **`room_types`**: Must run first (even though seeded in 4A, re-running ensures safety and idempotency).
2. **`rooms`**: Depends on `room_types` for code mapping.
3. **`inventory_categories`**: Must run first for inventory.
4. **`inventory_products`**: Depends on `inventory_categories` for doc ID mapping.

## P. Rollback Strategy
- Because `ENABLE_FIRESTORE_READS=false`, rollback is unnecessary. If bad data is written, the script can simply be corrected and re-run. 

## Q. Idempotency Strategy
- All writes will use `batch.set(docRef, payload, { merge: true })`. 
- No documents will be duplicated. Repeated executions will produce identical output.

## R. Risk Assessment
- **Risk Level**: ZERO.
- **Reasoning**: MySQL is strictly accessed via `SELECT`. The application does not yet read from Firestore. Data written to Firestore has no impact on current production flows.

## Proposed Files
- `scripts/phase4C_seedStaticData.mjs` (A single unified script running in the dependency-safe order).
