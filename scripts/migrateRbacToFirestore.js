/**
 * migrateRbacToFirestore.js — Controlled Idempotent RBAC Migration Script
 * ========================================================================
 * Migrates ONLY RBAC master data from MySQL (roles, permissions, role_permissions)
 * to Firestore (/roles, /permissions, /role_permissions).
 *
 * Safety Rules:
 *  - ZERO MySQL writes.
 *  - Default mode: --dry-run (0 writes).
 *  - Requires explicit --commit argument to perform Firestore writes.
 *  - Uses deterministic document IDs and upsert (merge) behavior.
 *  - ZERO document deletions or purges.
 *  - ZERO changes to feature flags or auth state.
 *
 * Usage:
 *  node scripts/migrateRbacToFirestore.js --dry-run
 *  node scripts/migrateRbacToFirestore.js --commit
 */

import pool from '../backend/db.js';
import { db, isFirebaseConfigured } from '../backend/config/firebaseAdmin.js';

async function migrateRbac() {
  const isCommit = process.argv.includes('--commit');
  const isDryRun = !isCommit;

  console.log('\n========================================================================================');
  console.log(`        CONTROLLED FIRESTORE RBAC MIGRATION (${isCommit ? 'COMMIT MODE' : 'DRY-RUN MODE'})`);
  console.log('========================================================================================\n');

  if (!isFirebaseConfigured || !db) {
    console.error('❌ Firebase Admin SDK is not properly initialized.');
    process.exit(1);
  }

  let connection;
  try {
    connection = await pool.getConnection();

    // 1. Fetch MySQL Source Records
    const [roles] = await connection.query('SELECT * FROM roles ORDER BY id ASC');
    const [permissions] = await connection.query('SELECT * FROM permissions ORDER BY id ASC');
    const [rolePermissions] = await connection.query(`
      SELECT rp.role_id, r.name as role_name, rp.permission_id, p.name as permission_name
      FROM role_permissions rp
      JOIN roles r ON rp.role_id = r.id
      JOIN permissions p ON rp.permission_id = p.id
      ORDER BY rp.role_id, rp.permission_id
    `);

    console.log(`[MySQL Source Snapshot]`);
    console.log(` - Roles            : ${roles.length}`);
    console.log(` - Permissions      : ${permissions.length}`);
    console.log(` - Role-Permissions : ${rolePermissions.length}\n`);

    if (roles.length !== 2 || permissions.length !== 7 || rolePermissions.length !== 9) {
      throw new Error(`Safety Abort: MySQL source count assertion failed (Expected 2/7/9, got ${roles.length}/${permissions.length}/${rolePermissions.length}).`);
    }

    const nowIso = new Date().toISOString();

    // 2. Prepare /roles documents (2 docs)
    const roleDocs = roles.map(r => ({
      docId: `role_${r.name.toLowerCase().trim()}`,
      data: {
        role_id: r.id,
        name: r.name.toLowerCase().trim(),
        description: r.description,
        source: 'mysql',
        mysql_role_id: r.id,
        created_at: nowIso,
        updated_at: nowIso
      }
    }));

    // 3. Prepare /permissions documents (7 docs)
    const permDocs = permissions.map(p => ({
      docId: `perm_${p.name.toLowerCase().trim()}`,
      data: {
        permission_id: p.id,
        name: p.name.toLowerCase().trim(),
        description: p.description,
        source: 'mysql',
        mysql_permission_id: p.id,
        created_at: nowIso,
        updated_at: nowIso
      }
    }));

    // 4. Prepare /role_permissions documents (9 docs)
    const rpDocs = rolePermissions.map(rp => ({
      docId: `rp_${rp.role_name.toLowerCase().trim()}_${rp.permission_name.toLowerCase().trim()}`,
      data: {
        role_id: rp.role_id,
        role_name: rp.role_name.toLowerCase().trim(),
        permission_id: rp.permission_id,
        permission_name: rp.permission_name.toLowerCase().trim(),
        source: 'mysql',
        mysql_role_id: rp.role_id,
        mysql_permission_id: rp.permission_id,
        created_at: nowIso
      }
    }));

    const totalPlannedWrites = roleDocs.length + permDocs.length + rpDocs.length;

    console.log(`[Migration Plan]`);
    console.log(` - Planned /roles writes            : ${roleDocs.length}`);
    console.log(` - Planned /permissions writes      : ${permDocs.length}`);
    console.log(` - Planned /role_permissions writes : ${rpDocs.length}`);
    console.log(` - Total Planned Firestore Writes   : ${totalPlannedWrites}\n`);

    if (totalPlannedWrites !== 18) {
      throw new Error(`Safety Abort: Planned writes count is ${totalPlannedWrites}, expected 18.`);
    }

    if (isDryRun) {
      console.log('----------------------------------------------------------------------------------------');
      console.log(' DRY-RUN SUMMARY (NO FIRESTORE WRITES EXECUTED):');
      console.log('----------------------------------------------------------------------------------------');
      console.log(' Roles to be written:');
      roleDocs.forEach(d => console.log(`   - /roles/${d.docId} => ${JSON.stringify(d.data)}`));
      console.log('\n Permissions to be written:');
      permDocs.forEach(d => console.log(`   - /permissions/${d.docId} => ${JSON.stringify(d.data)}`));
      console.log('\n Role-Permissions to be written:');
      rpDocs.forEach(d => console.log(`   - /role_permissions/${d.docId} => ${JSON.stringify(d.data)}`));
      console.log('----------------------------------------------------------------------------------------');
      console.log(' ✔ Dry-run completed successfully with 0 database modifications.');
      console.log('   Run with --commit to execute the 18 Firestore document writes.\n');
      return;
    }

    // ── COMMIT MODE: Execute Writes ──────────────────────────────────────────
    console.log('[Executing Firestore Writes...]');
    const batch = db.batch();

    roleDocs.forEach(d => {
      const ref = db.collection('roles').doc(d.docId);
      batch.set(ref, d.data, { merge: true });
    });

    permDocs.forEach(d => {
      const ref = db.collection('permissions').doc(d.docId);
      batch.set(ref, d.data, { merge: true });
    });

    rpDocs.forEach(d => {
      const ref = db.collection('role_permissions').doc(d.docId);
      batch.set(ref, d.data, { merge: true });
    });

    await batch.commit();

    console.log('\n✔ COMMIT SUCCESS: 18 Firestore RBAC documents written cleanly.\n');

  } catch (err) {
    console.error('❌ Migration Error:', err.message);
    process.exitCode = 1;
  } finally {
    if (connection) connection.release();
    await pool.end();
  }
}

migrateRbac();
