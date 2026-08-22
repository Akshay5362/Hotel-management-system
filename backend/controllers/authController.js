import pool from '../db.js';
import { BusinessDateService } from '../services/businessDateService.js';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { db, auth, isFirebaseConfigured } from '../config/firebaseAdmin.js';
import {
  isFirebaseOnlyStaffResolutionEnabled,
  isFirebaseStaffLoginEnabled,
  isFirebaseGuestLoginEnabled,
  isFirebaseOnlyGuestResolutionEnabled,
  isFirebaseOnlyRbacEnabled
} from '../config/featureFlags.js';
import {
  getGuestByIdFirestore,
  createGuestFirestore,
  updateGuestFirestore
} from '../repositories/firestore/guestsRepository.js';
import { getStaffByUsernameFirestore, getStaffByIdFirestore } from '../repositories/firestore/staffRepository.js';
import { hasFirestorePermission } from '../repositories/firestore/rbacRepository.js';

const JWT_SECRET = process.env.JWT_SECRET || 'hotel-pms-super-secret-key-12345!';

function hashPassword(pass) {
  return crypto.createHash('sha256').update(pass).digest('hex');
}

export function generateToken(user) {
  const payload = JSON.stringify({ id: user.id, role: user.role });
  const base64Payload = Buffer.from(payload).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(base64Payload).digest('base64url');
  return `${base64Payload}.${signature}`;
}

export function verifyToken(token) {
  try {
    const [base64Payload, signature] = token.split('.');
    if (!base64Payload || !signature) return null;
    const expectedSignature = crypto.createHmac('sha256', JWT_SECRET).update(base64Payload).digest('base64url');
    if (signature !== expectedSignature) return null;
    const payloadJson = Buffer.from(base64Payload, 'base64url').toString('utf8');
    return JSON.parse(payloadJson);
  } catch (e) {
    return null;
  }
}

export const signUp = async (req, res) => {
  const { username, password, fullName, phone, mobile } = req.body;

  if (!username || typeof username !== 'string' || username.trim() === '') {
    return res.status(400).json({ error: 'Username is required' });
  }
  if (!password || typeof password !== 'string' || password.trim() === '') {
    return res.status(400).json({ error: 'Password is required' });
  }
  if (password.length < 8 || !/[A-Z]/.test(password) || !/[a-z]/.test(password)) {
    return res.status(400).json({ error: 'Password must be at least 8 characters long and contain both uppercase and lowercase letters.' });
  }
  if (!fullName || typeof fullName !== 'string' || fullName.trim() === '') {
    return res.status(400).json({ error: 'Full name is required' });
  }

  const baseUsername  = username.trim().toLowerCase();
  const cleanFullName = fullName.trim();
  const cleanPhone    = (phone || mobile || '').trim();
  const userRole      = 'guest';

  // ── Firestore / Firebase Auth Primary Path ──────────────────────────────
  if (isFirebaseGuestLoginEnabled() && isFirebaseConfigured && auth) {
    try {
      const email = baseUsername.includes('@')
        ? baseUsername
        : `${baseUsername}@hpms-sky5.internal`;

      // Check if phone or email already registered in Firestore or Firebase Auth
      let existingByPhone = null;
      if (cleanPhone) {
        existingByPhone = await getGuestByPhoneFirestore(cleanPhone);
      }
      if (existingByPhone) {
        return res.status(400).json({
          error: 'An account with this phone number already exists. Try signing in instead.'
        });
      }

      let authUser = null;
      try {
        authUser = await auth.getUserByEmail(email);
      } catch (e) {
        if (e.code !== 'auth/user-not-found') throw e;
      }

      if (authUser) {
        return res.status(400).json({
          error: 'An account with this username already exists. Try signing in instead.'
        });
      }

      // Generate safe UID
      const uidKey = cleanPhone ? cleanPhone.replace(/\D/g, '') : Date.now();
      const uid = `guest_${uidKey}`;

      authUser = await auth.createUser({
        uid,
        email,
        displayName: cleanFullName,
        password,
        emailVerified: false
      });

      const customClaims = {
        role: 'guest',
        user_type: 'guest',
        mysql_id: null,
        mysql_guest_id: null,
        guest_id: uid,
        full_name: cleanFullName,
        phone: cleanPhone,
        loyalty_tier: 'Bronze',
        loyalty_points: 0
      };
      await auth.setCustomUserClaims(authUser.uid, customClaims);

      await createGuestFirestore({
        guest_id: uid,
        user_uid: authUser.uid,
        full_name: cleanFullName,
        email: authUser.email || email,
        phone: cleanPhone || null,
        loyalty_tier: 'Bronze',
        loyalty_points: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });

      try {
        const { createAuditLogFirestore } = await import('../repositories/firestore/auditLogsRepository.js');
        await createAuditLogFirestore({
          user_id: authUser.uid,
          action: 'SIGNUP',
          details: `Guest account registered: ${baseUsername} (${cleanFullName})`,
          business_date: await BusinessDateService.getBusinessDate()
        });
      } catch (_) {}

      const user = {
        id: uid,
        username: baseUsername,
        fullName: cleanFullName,
        phone: cleanPhone,
        role: userRole,
        loyalty_tier: 'Bronze',
        loyalty_points: 0
      };

      const token = generateToken(user);
      return res.status(201).json({
        message: 'Account registered successfully',
        user,
        token
      });

    } catch (fbErr) {
      if (fbErr.code === 'auth/email-already-exists') {
        return res.status(400).json({
          error: 'An account with this username already exists. Try signing in instead.'
        });
      }
      if (fbErr.code === 'auth/phone-number-already-exists') {
        return res.status(400).json({
          error: 'An account with this phone number already exists. Try signing in instead.'
        });
      }
      console.warn('[signUp] Firebase primary signup failed, attempting fallback if permitted:', fbErr.message);
    }
  }

  // ── Legacy MySQL Fallback Path ──────────────────────────────────────────
  let connection;
  try {
    const passwordHash = hashPassword(password);
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [roles] = await connection.query("SELECT id FROM roles WHERE name = 'guest'");
    const roleId = roles[0]?.id || null;

    let cleanUsername = baseUsername;
    let userId = null;

    for (let attempt = 0; attempt <= 10; attempt++) {
      const tryName = attempt === 0 ? baseUsername : `${baseUsername}${attempt + 1}`;
      try {
        const [result] = await connection.query(
          `INSERT INTO users (username, password, fullName, phone, role_id) VALUES (?, ?, ?, ?, ?)`,
          [tryName, passwordHash, cleanFullName, cleanPhone, roleId]
        );
        cleanUsername = tryName;
        userId = result.insertId;
        break;
      } catch (dupErr) {
        if (dupErr.code === 'ER_DUP_ENTRY' && attempt < 10) continue;
        throw dupErr;
      }
    }

    const [guestInsertRes] = await connection.query(
      `INSERT INTO guests (full_name, phone, user_id) VALUES (?, ?, ?)`,
      [cleanFullName, cleanPhone, userId]
    );
    const guestId = guestInsertRes.insertId;

    const businessDate = await BusinessDateService.getBusinessDate(connection);
    await connection.query(
      `INSERT INTO audit_logs (user_id, action, details, business_date) VALUES (?, 'SIGNUP', ?, ?)`,
      [userId, `Guest account registered: ${cleanUsername} (${cleanFullName})`, businessDate]
    );

    if (isFirestoreDualWriteEnabled()) {
      await enqueue(connection, {
        event_type: 'GUEST_CREATED',
        aggregate_type: 'GUEST',
        aggregate_id: cleanPhone,
        payload: {
          full_name: cleanFullName,
          phone: cleanPhone,
          email: null,
          loyalty_tier: 'Bronze',
          loyalty_points: 0,
          mysql_user_id: userId,
          updated_at: new Date().toISOString()
        }
      });
    }

    await connection.commit();

    const user = {
      id: userId,
      username: cleanUsername,
      fullName: cleanFullName,
      phone: cleanPhone,
      role: userRole,
      loyalty_tier: 'Bronze',
      loyalty_points: 0
    };

    if (isFirebaseGuestLoginEnabled() && isFirebaseConfigured && auth) {
      try {
        await provisionGuestFirebaseAtSignup({
          userId,
          guestId,
          username: cleanUsername,
          fullName: cleanFullName,
          phone: cleanPhone,
          cleartextPassword: password
        });
      } catch (fbErr) {
        console.error('[signUp] Firebase provisioning warning (non-fatal):', fbErr.message);
      }
    }

    const token = generateToken(user);
    res.status(201).json({
      message: 'Account registered successfully',
      user,
      token
    });

  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (e) {}
    }

    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({
        error: 'An account with this phone number already exists. Try signing in instead.'
      });
    }

    console.error('Error during signUp:', error);
    res.status(500).json({ error: 'Internal Server Error' });

  } finally {
    if (connection) connection.release();
  }
};

/**
 * Provisions Firebase Auth user and Firestore document at guest signup time.
 * Called only when ENABLE_FIREBASE_GUEST_LOGIN=true.
 *
 * SECURITY CONTRACT:
 *  - cleartextPassword is used ONLY to set the Firebase Auth password.
 *  - It is NEVER logged, stored in new locations, or included in any response.
 *  - The MySQL password column is NOT touched by this function.
 *
 * @param {object} params
 * @param {number} params.userId           — MySQL users.id (login account)
 * @param {number} params.guestId          — MySQL guests.id (guest profile)
 * @param {string} params.username         — Resolved username (already lowercased)
 * @param {string} params.fullName         — Guest full name
 * @param {string} params.phone            — Guest phone
 * @param {string} params.cleartextPassword — The guest's chosen password (in-memory only)
 */
export async function provisionGuestFirebaseAtSignup({
  userId,
  guestId,
  username,
  fullName,
  phone,
  cleartextPassword
}) {
  if (!isFirebaseConfigured || !auth) return;

  const uid = `guest_${userId}`;
  const email = username.includes('@')
    ? username
    : `${username}@hpms-sky5.internal`;

  // Find or create Firebase Auth user
  let authUser = null;
  try {
    authUser = await auth.getUser(uid);
  } catch (e) {
    if (e.code !== 'auth/user-not-found') throw e;
  }

  if (!authUser) {
    // Check email conflict before creating
    let emailToUse = email;
    try {
      const existing = await auth.getUserByEmail(email);
      if (existing && existing.uid !== uid) {
        // Email taken by different UID — use guaranteed-unique synthetic email
        emailToUse = `${username}@hpms-sky5.internal`;
      }
    } catch (e) {
      if (e.code !== 'auth/user-not-found') throw e;
    }

    // SECURITY: cleartextPassword used here only to set Firebase Auth credential.
    // It is the guest's own chosen password — not a hash or derived value.
    authUser = await auth.createUser({
      uid,
      email:         emailToUse,
      displayName:   fullName,
      password:      cleartextPassword,  // guest's chosen password — never logged
      emailVerified: false
    });
  }

  // Set/merge Firebase Custom Claims
  const currentClaims = authUser.customClaims || {};
  const requiredClaims = {
    role:           'guest',
    user_type:      'guest',
    mysql_id:       Number(userId),
    mysql_guest_id: Number(guestId),
    guest_id:       Number(guestId),
    full_name:      String(fullName).trim(),
    phone:          String(phone || '').trim(),
    loyalty_tier:   'Bronze',
    loyalty_points: 0
  };
  const mergedClaims = { ...currentClaims, ...requiredClaims };
  await auth.setCustomUserClaims(authUser.uid, mergedClaims);

  // Upsert Firestore /guests/guest_${guestId}
  try {
    const existing = await getGuestByIdFirestore(guestId);
    const payload = {
      mysql_guest_id:  Number(guestId),
      mysql_user_id:   Number(userId),
      user_uid:        uid,
      full_name:       String(fullName).trim(),
      email:           authUser.email || email,
      phone:           String(phone || '').trim() || null,
      loyalty_tier:    'Bronze',
      loyalty_points:  0,
      updated_at:      new Date().toISOString()
    };
    if (!existing) {
      payload.created_at = new Date().toISOString();
      await createGuestFirestore(payload);
    } else {
      await updateGuestFirestore(guestId, payload);
    }
  } catch (fsErr) {
    // Firestore failure is non-fatal for signup
    console.warn('[provisionGuestFirebaseAtSignup] Firestore upsert warning:', fsErr.message);
  }

  console.log(`[GuestFirebaseSignup] Provisioned Firebase Auth uid='${uid}' for MySQL users.id=${userId}, guests.id=${guestId}`);
}

export const signIn = async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const cleanUsername = username.trim().toLowerCase();

  try {
    const [users] = await pool.query(
      `SELECT u.id, u.username, u.fullName, u.phone, u.password,
              r.name as role, g.loyalty_tier, g.loyalty_points
       FROM users u
       LEFT JOIN roles r ON u.role_id = r.id
       LEFT JOIN guests g ON g.user_id = u.id
       WHERE (u.username = ? OR u.phone = ? OR g.email = ?)`,
      [cleanUsername, cleanUsername, cleanUsername]
    );

    if (users.length === 0) {
      // ── Phase 3 Step 3C: Firebase-Only Staff Login Guard ───────────────────────
      // When ENABLE_FIREBASE_STAFF_LOGIN=true, reject any attempt to validate staff
      // credentials via MySQL password check. Staff must use Firebase Authentication.
      if (isFirebaseStaffLoginEnabled()) {
        // Still do a quick staff lookup to return a user-facing error if not found,
        // but do NOT compare password hashes.
        const [staffCheck] = await pool.query(
          `SELECT id, username, status FROM staff WHERE (username = ? OR email = ? OR phone = ?) AND deleted = 0 LIMIT 1`,
          [cleanUsername, cleanUsername, cleanUsername]
        );
        if (staffCheck.length > 0 && staffCheck[0].status === 'Inactive') {
          return res.status(403).json({ error: 'Your account is inactive. Please contact an administrator.', code: 'ACCOUNT_INACTIVE' });
        }
        // Redirect to Firebase login — do NOT leak whether the account exists
        return res.status(401).json({
          error: 'Staff login via username/password is disabled. Please use Firebase Authentication.',
          code: 'FIREBASE_LOGIN_REQUIRED',
          hint: 'Use your email with Firebase signInWithEmailAndPassword then call /api/auth/me.'
        });
      }

      const [staffs] = await pool.query(
        `SELECT * FROM staff WHERE (username = ? OR email = ? OR phone = ?) AND deleted = 0 LIMIT 1`,
        [cleanUsername, cleanUsername, cleanUsername]
      );

      if (staffs.length > 0) {
        const staff = staffs[0];
        if (staff.status === 'Inactive') {
          return res.status(403).json({ error: 'Your account is inactive. Please contact an administrator.' });
        }
        const passwordMatch = await bcrypt.compare(password, staff.password_hash);
        if (!passwordMatch) {
          return res.status(400).json({ error: 'Invalid username or password' });
        }
        pool.query('UPDATE staff SET last_login = NOW() WHERE id = ?', [staff.id]).catch(() => {});
        const safeStaff = {
          id: staff.id, username: staff.username, full_name: staff.full_name,
          role: staff.role, department: staff.department, shift: staff.shift, loginType: 'staff'
        };
        const tokenPayload = { id: staff.id, role: staff.role, type: 'staff' };
        const token = generateToken(tokenPayload);
        return res.json({ message: 'Logged in successfully', user: safeStaff, token });
      }

      return res.status(400).json({ error: 'Invalid username or password' });
    }

    const user = users[0];

    // ── Phase 3 Step 3D-2: Guest Firebase Login Guard ────────────────────────────────
    // When ENABLE_FIREBASE_GUEST_LOGIN=true:
    //   The backend does NOT verify the MySQL password for guest accounts.
    //   MySQL password column must NOT be read for comparison in this path.
    //   The guest must authenticate via Firebase signInWithEmailAndPassword
    //   (implemented in Step 3D-3) and exchange for /api/auth/me.
    //
    // SECURITY: The password hash is destructured out but NEVER compared or returned.
    //   Returning FIREBASE_LOGIN_REQUIRED does NOT leak whether the account exists.
    const { password: storedHash, ...safeUser } = user;
    const isGuestRole = (safeUser.role === 'guest' || !safeUser.role);

    if (isGuestRole && isFirebaseGuestLoginEnabled()) {
      // Do NOT perform password verification — return deterministic redirect error.
      // SECURITY: storedHash is NOT used. It is destructured out and immediately discarded.
      return res.status(401).json({
        error: 'Guest login via username/password is disabled. Please use Firebase Authentication.',
        code:  'FIREBASE_LOGIN_REQUIRED'
      });
    }

    // ── Standard MySQL Password Verification (flag OFF or non-guest) ───────────────
    let passwordValid = false;
    if (storedHash && storedHash.startsWith('$2')) {
      passwordValid = await bcrypt.compare(password, storedHash);
    } else {
      passwordValid = storedHash === hashPassword(password);
    }

    if (!passwordValid) {
      return res.status(400).json({ error: 'Invalid username or password' });
    }

    // Phase 1: Guest Lazy Auth Migration Trigger (runs when Firebase auth enabled but login flag OFF)
    if (isGuestRole && process.env.ENABLE_FIREBASE_AUTH === 'true') {
      await ensureGuestLazyAuthMigration(safeUser, password);
    }

    const token = generateToken(safeUser);

    const businessDate = await BusinessDateService.getBusinessDate(pool);
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, details, business_date) VALUES (?, 'LOGIN', ?, ?)`,
      [safeUser.id, `User logged in: ${safeUser.username} (${safeUser.role})`, businessDate]
    );

    res.json({ message: 'Logged in successfully', user: safeUser, token });
  } catch (error) {
    console.error('Error during signIn:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * Idempotent Guest Lazy Auth Migration Helper
 * Dynamically creates/links MySQL guests profile, provisions Firebase Auth user,
 * assigns custom claims { role: "guest", user_type: "guest", mysql_id },
 * and writes/syncs Firestore /guests/guest_${mysql_guest_id} document.
 */
export async function ensureGuestLazyAuthMigration(user, cleartextPassword) {
  if (!user || !user.id) return;
  const isEnabled = process.env.ENABLE_FIREBASE_AUTH === 'true';
  if (!isEnabled || !isFirebaseConfigured || !auth || !db) return;

  try {
    // Step 1: Ensure dedicated MySQL guests table record exists for user.id
    const [existingGuests] = await pool.query(
      `SELECT id, full_name, email, phone, loyalty_tier, loyalty_points, created_at FROM guests WHERE user_id = ?`,
      [user.id]
    );

    let mysqlGuestId = null;
    let guestProfile = null;

    if (existingGuests.length > 0) {
      mysqlGuestId = existingGuests[0].id;
      guestProfile = existingGuests[0];
    } else {
      // Create new dedicated guest profile for this customer
      const [insertRes] = await pool.query(
        `INSERT INTO guests (full_name, phone, user_id) VALUES (?, ?, ?)`,
        [user.fullName || user.username, user.phone || null, user.id]
      );
      mysqlGuestId = insertRes.insertId;
      guestProfile = {
        id: mysqlGuestId,
        full_name: user.fullName || user.username,
        phone: user.phone || null,
        email: null,
        loyalty_tier: 'Bronze',
        loyalty_points: 0,
        created_at: new Date()
      };
    }

    // Step 2: Ensure Firebase Auth user exists
    const expectedUid = `guest_${user.id}`;
    const emailToUse = (user.username && user.username.includes('@'))
      ? user.username.toLowerCase()
      : `${user.username || 'guest_' + user.id}@hpms-sky5.internal`;

    let authUser = null;
    try {
      authUser = await auth.getUser(expectedUid);
    } catch (e) {
      try {
        authUser = await auth.getUserByEmail(emailToUse);
      } catch (e2) {}
    }

    if (!authUser) {
      authUser = await auth.createUser({
        uid: expectedUid,
        email: emailToUse,
        emailVerified: true,
        password: cleartextPassword || 'GuestPassword123!',
        displayName: user.fullName || user.username
      });
    }

    const actualUid = authUser.uid;

    // Step 3: Ensure Custom Claims are set (enriched with all Step 3D-2 required fields)
    const currentClaims = authUser.customClaims || {};
    const requiredClaims = {
      role:           'guest',
      user_type:      'guest',
      mysql_id:       Number(user.id),
      mysql_guest_id: Number(mysqlGuestId),
      guest_id:       Number(mysqlGuestId),
      full_name:      String(guestProfile.full_name || user.fullName || user.username || '').trim(),
      phone:          String(guestProfile.phone || user.phone || '').trim(),
      loyalty_tier:   String(guestProfile.loyalty_tier || 'Bronze').trim(),
      loyalty_points: Number(guestProfile.loyalty_points || 0)
    };
    // Check if any required claim needs updating (compare as strings for type safety)
    const needsClaimsUpdate = Object.entries(requiredClaims).some(
      ([k, v]) => String(currentClaims[k]) !== String(v)
    );
    if (needsClaimsUpdate) {
      // Merge: preserve unrelated existing claims
      await auth.setCustomUserClaims(actualUid, { ...currentClaims, ...requiredClaims });
    }

    // Step 4: Ensure Firestore document /guests/guest_${mysqlGuestId} is created/synced
    const docRef = db.collection('guests').doc(`guest_${mysqlGuestId}`);
    const docSnap = await docRef.get();

    const firestoreData = {
      mysql_guest_id: mysqlGuestId,
      mysql_user_id: user.id,
      user_uid: actualUid,
      full_name: guestProfile.full_name || user.fullName || user.username,
      email: guestProfile.email || emailToUse,
      phone: guestProfile.phone || user.phone || null,
      loyalty_tier: guestProfile.loyalty_tier || 'Bronze',
      loyalty_points: guestProfile.loyalty_points || 0,
      updated_at: new Date().toISOString()
    };

    if (!docSnap.exists) {
      firestoreData.created_at = (guestProfile.created_at instanceof Date)
        ? guestProfile.created_at.toISOString()
        : new Date().toISOString();
      await docRef.set(firestoreData);
    } else {
      await docRef.update({
        user_uid: actualUid,
        updated_at: firestoreData.updated_at
      });
    }

    console.log(`[GuestLazyAuth] Idempotent migration success for User ID ${user.id} -> Guest ID ${mysqlGuestId} -> UID '${actualUid}'`);
  } catch (err) {
    console.error(`[GuestLazyAuth Error] Failed lazy migration for User ID ${user?.id}:`, err);
  }
}

// ── Middleware ─────────────────────────────────────────────────────────────

// ── Canonical Firebase User Resolution Helper ─────────────────────────────
/**
 * Resolves a Firebase-authenticated user to their canonical identity.
 * Shared between `authenticate` middleware and `getMe` endpoint.
 *
 * Staff resolution path (ENABLE_FIREBASE_ONLY_STAFF_RESOLUTION=true):
 *   1. Uses verified Firebase Custom Claims for role/status/identity
 *   2. Falls back to Firestore staff document for supplementary profile fields
 *   3. NEVER queries MySQL on this path
 *   4. Throws ACCOUNT_INACTIVE if claims.status === 'Inactive' or claims.deleted is truthy
 *
 * Staff resolution path (ENABLE_FIREBASE_ONLY_STAFF_RESOLUTION=false, default):
 *   - Same MySQL lookup as before (unchanged)
 *
 * Guest path: Always resolved from claims only (unchanged).
 * Root Admin path: Always uses MySQL users table (unchanged).
 */
export async function resolveCanonicalFirebaseUser(decodedFirebase, {
  // Injectable for unit-testing — defaults match the real implementations
  getStaffByUsernameFn = getStaffByUsernameFirestore,
  getStaffByIdFn = getStaffByIdFirestore,
} = {}) {
  const claimedRole  = decodedFirebase.role  || null;
  const claimedType  = decodedFirebase.type  || decodedFirebase.user_type || null;
  const mysqlId      = decodedFirebase.mysql_id || decodedFirebase.mysql_staff_id
    || (decodedFirebase.uid?.startsWith('staff_') ? parseInt(decodedFirebase.uid.replace('staff_', ''), 10) : null)
    || (decodedFirebase.uid?.startsWith('user_')  ? parseInt(decodedFirebase.uid.replace('user_', ''),  10) : null);
  const staffClaimId = decodedFirebase.staff_id || null;
  const displayName  = decodedFirebase.name || decodedFirebase.displayName || decodedFirebase.email?.split('@')[0] || decodedFirebase.uid;

  // 1. Guest Check
  const isGuest = claimedRole === 'guest' || claimedType === 'guest' || decodedFirebase.uid?.startsWith('guest_');
  if (isGuest) {
    // ── Phase 3 Step 3D-2: Enriched Guest Resolution (claims-only, ZERO MySQL) ────────
    // When ENABLE_FIREBASE_ONLY_GUEST_RESOLUTION=true: validate that booking-critical
    // claims are present. This prevents silent failures in guest API endpoints that
    // rely on req.user.mysql_guest_id and req.user.guest_id for booking ownership.
    const explicitGuestId = decodedFirebase.mysql_guest_id || decodedFirebase.guest_id;
    const mysqlGuestId = explicitGuestId
      ? Number(explicitGuestId)
      : mysqlId; // fallback for pre-3D-1 tokens (flag-OFF path only)

    if (isFirebaseOnlyGuestResolutionEnabled()) {
      // Validate both IDs are present — required for booking ownership without MySQL
      if (!mysqlId) {
        const err = new Error('Firebase guest token is missing mysql_id claim. Re-provision via Step 3D-1.');
        err.code   = 'MISSING_CLAIM';
        err.status = 401;
        throw err;
      }
      if (!explicitGuestId) {
        // mysql_guest_id / guest_id not explicitly set — old pre-3D-1 token
        const err = new Error('Firebase guest token is missing mysql_guest_id/guest_id claim. Re-provision via Step 3D-1.');
        err.code   = 'MISSING_CLAIM';
        err.status = 401;
        throw err;
      }
    }

    return {
      uid:            decodedFirebase.uid,
      id:             mysqlId,
      mysql_id:       mysqlId,
      mysql_guest_id: mysqlGuestId,
      guest_id:       mysqlGuestId,
      username:       decodedFirebase.phone || displayName,
      full_name:      decodedFirebase.full_name || displayName,
      phone:          decodedFirebase.phone || null,
      loyalty_tier:   decodedFirebase.loyalty_tier || 'Bronze',
      loyalty_points: Number(decodedFirebase.loyalty_points || 0),
      role:           'guest',
      user_type:      'guest',
      type:           'guest',
      loginType:      'guest',
      isRootAdmin:    false,
      authProvider:   'firebase'
    };
  }

  // 2. Staff check vs Root Admin check
  const isStaffToken = claimedType === 'staff' || decodedFirebase.uid?.startsWith('staff_');
  const isRootAdmin  = !isStaffToken && (claimedRole === 'admin' || claimedRole === 'super_admin' || decodedFirebase.uid === 'user_1' || mysqlId === 1);

  let resolvedUser = null;

  // ── STAFF RESOLUTION ──────────────────────────────────────────
  // Enter the staff block when: isStaffToken=true AND (there is some mysql identifier OR flag is ON)
  // When the flag is ON, we always enter to properly validate/reject missing claims.
  if (isStaffToken && ((mysqlId || staffClaimId) || isFirebaseOnlyStaffResolutionEnabled())) {

    // ── Phase 3 Step 3B: Firebase-Only Staff Resolution Path ───────────────────
    if (isFirebaseOnlyStaffResolutionEnabled()) {

      // Validate required claims are present — never silently allow unclaimed tokens
      const staffUsername = decodedFirebase.staff_username || null;
      if (!mysqlId) {
        const err = new Error('Firebase staff token is missing mysql_id claim. Re-provision this account via Phase 3 Step 3A.');
        err.code = 'MISSING_CLAIM';
        err.status = 401;
        throw err;
      }
      if (!staffUsername) {
        const err = new Error('Firebase staff token is missing staff_username claim. Re-provision this account via Phase 3 Step 3A.');
        err.code = 'MISSING_CLAIM';
        err.status = 401;
        throw err;
      }

      // Check status/deleted from claims before any I/O
      const claimStatus  = decodedFirebase.status;
      const claimDeleted = decodedFirebase.deleted;
      if (claimStatus === 'Inactive' || claimDeleted === 1 || claimDeleted === true || claimDeleted === '1') {
        const err = new Error('Your account is inactive. Please contact an administrator.');
        err.code = 'ACCOUNT_INACTIVE';
        err.status = 403;
        throw err;
      }

      // Attempt Firestore staff document lookup for supplementary fields (full_name, department, shift)
      // This is a best-effort read; if Firestore is unavailable we fall back to claims-only.
      let firestoreProfile = null;
      try {
        // getStaffByUsernameFirestore internally prepends 'staff_' via formatStaffId
        firestoreProfile = await getStaffByUsernameFn(staffUsername);
        // Also try by mysql_id-based doc if username lookup returns nothing
        if (!firestoreProfile) {
          firestoreProfile = await getStaffByIdFn(mysqlId);
        }
      } catch (fsErr) {
        if (fsErr.code === 8 || fsErr.message?.includes('Quota') || fsErr.message?.includes('RESOURCE_EXHAUSTED')) {
          console.warn('[resolveCanonicalFirebaseUser] Firestore quota exceeded — using claims-only for staff profile supplementation');
        } else {
          // Any other Firestore error is a hard failure when flag is ON — do not fall through to MySQL
          const err = new Error(`Firestore lookup error for '${staffUsername}'. Re-run Phase 3 Step 3A provisioning script.`);
          err.code = 'FIRESTORE_PROFILE_MISSING';
          err.status = 401;
          throw err;
        }
      }

      // When both username and id Firestore lookups return null, this is a missing-profile hard failure.
      // Do NOT fall through to MySQL silently.
      if (!firestoreProfile) {
        const err = new Error(`Firestore staff profile not found for '${staffUsername}'. Re-run Phase 3 Step 3A provisioning script.`);
        err.code = 'FIRESTORE_PROFILE_MISSING';
        err.status = 401;
        throw err;
      }

      // Build canonical user object from claims + optional Firestore supplement
      resolvedUser = {
        uid:          decodedFirebase.uid,
        id:           mysqlId,
        mysql_id:     mysqlId,
        staff_id:     staffUsername,
        username:     staffUsername,
        full_name:    firestoreProfile?.full_name || decodedFirebase.name || decodedFirebase.displayName || staffUsername,
        role:         decodedFirebase.role,  // raw MySQL enum value from claims e.g. 'RECEPTIONIST'
        department:   firestoreProfile?.department || null,
        shift:        firestoreProfile?.shift || null,
        loginType:    'staff',
        user_type:    'staff',
        type:         'staff',
        isRootAdmin:  false,
        authProvider: 'firebase'
      };

    } else {
      // ── ORIGINAL MySQL Staff Resolution Path (flag OFF) ──────────────────────
      try {
        const [staffRows] = await pool.query(
          `SELECT id, username, full_name, role, department, shift, status, deleted
           FROM staff WHERE (id = ? OR username = ?) AND deleted = 0 LIMIT 1`,
          [mysqlId || 0, staffClaimId || '']
        );

        if (staffRows.length > 0) {
          const staff = staffRows[0];
          if (staff.status === 'Inactive' || staff.deleted === 1) {
            const err = new Error('Your account is inactive. Please contact an administrator.');
            err.code = 'ACCOUNT_INACTIVE';
            err.status = 403;
            throw err;
          }

          resolvedUser = {
            uid:          decodedFirebase.uid,
            id:           staff.id,
            mysql_id:     staff.id,
            staff_id:     staff.username,
            username:     staff.username,
            full_name:    staff.full_name,
            role:         staff.role,
            department:   staff.department,
            shift:        staff.shift,
            loginType:    'staff',
            user_type:    'staff',
            type:         'staff',
            isRootAdmin:  false,
            authProvider: 'firebase'
          };
        }
      } catch (dbErr) {
        if (dbErr.code === 'ACCOUNT_INACTIVE') throw dbErr;
        console.error('[resolveCanonicalFirebaseUser] MySQL staff lookup error:', dbErr.message);
      }
    }

  } else if (isRootAdmin) {
    // ── Phase 3 Step 4: Firebase-Only Root Admin Resolution ───────────────
    if (isFirebaseOnlyRbacEnabled()) {
      resolvedUser = {
        uid:          decodedFirebase.uid,
        id:           1,
        mysql_id:     1,
        username:     'admin',
        full_name:    decodedFirebase.name || decodedFirebase.displayName || 'ADMINISTRATOR',
        role:         'admin',
        loginType:    'admin',
        user_type:    'admin',
        type:         'admin',
        isRootAdmin:  true,
        authProvider: 'firebase'
      };
    } else {
      // ── Root Admin Resolution (MySQL, unchanged when flag=false) ──────────
      try {
        const lookupId = mysqlId || 1;
        const [userRows] = await pool.query(
          `SELECT u.id, u.username, u.fullName, r.name as role
           FROM users u
           LEFT JOIN roles r ON u.role_id = r.id
           WHERE u.id = ? OR u.username = 'admin' LIMIT 1`,
          [lookupId]
        );

        if (userRows.length > 0) {
          const user = userRows[0];
          resolvedUser = {
            uid:          decodedFirebase.uid,
            id:           user.id,
            mysql_id:     user.id,
            username:     user.username,
            full_name:    user.fullName,
            role:         user.role || 'admin',
            loginType:    'admin',
            user_type:    'admin',
            type:         'admin',
            isRootAdmin:  user.id === 1,
            authProvider: 'firebase'
          };
        }
      } catch (dbErr) {
        console.error('[resolveCanonicalFirebaseUser] MySQL user lookup error:', dbErr.message);
      }
    }
  }

  // 3. Fallback: build from claims if DB lookup didn't find record
  if (!resolvedUser) {
    if (!claimedRole) {
      const err = new Error('Role could not be determined from token claims. Re-provision this account.');
      err.code = 'ROLE_INDETERMINATE';
      err.status = 422;
      throw err;
    }

    const fallbackType = isStaffToken ? 'staff' : (claimedRole === 'admin' ? 'admin' : (claimedType || 'staff'));
    resolvedUser = {
      uid:          decodedFirebase.uid,
      id:           mysqlId,
      mysql_id:     mysqlId,
      staff_id:     staffClaimId,
      username:     displayName || decodedFirebase.email?.split('@')[0] || decodedFirebase.uid,
      full_name:    displayName,
      role:         claimedRole,
      loginType:    fallbackType,
      user_type:    fallbackType,
      type:         fallbackType,
      isRootAdmin:  !isStaffToken && (mysqlId === 1 || claimedRole === 'admin'),
      authProvider: 'firebase'
    };
  }

  return resolvedUser;
}

// ── Middleware ─────────────────────────────────────────────────────────────

export const authenticate = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ error: 'Authorization header is missing' });

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.status(401).json({ error: 'Invalid Authorization header format' });
  }

  const token = parts[1];

  // Dual Auth Resolution: Attempt Firebase ID token verification if feature flag is enabled
  const isFirebaseAuthEnabled = process.env.ENABLE_FIREBASE_AUTH === 'true';

  if (isFirebaseAuthEnabled && isFirebaseConfigured && auth) {
    try {
      const decodedFirebase = await auth.verifyIdToken(token);
      if (decodedFirebase) {
        req.firebaseUser = decodedFirebase;
        try {
          req.user = await resolveCanonicalFirebaseUser(decodedFirebase);
          return next();
        } catch (resolveErr) {
          if (resolveErr.code === 'ACCOUNT_INACTIVE' || resolveErr.status === 403) {
            return res.status(403).json({ error: resolveErr.message, code: 'ACCOUNT_INACTIVE' });
          }
          if (resolveErr.code === 'ROLE_INDETERMINATE' || resolveErr.status === 422) {
            return res.status(422).json({ error: resolveErr.message, code: 'ROLE_INDETERMINATE' });
          }
          console.error('[authenticate] resolveCanonicalFirebaseUser error:', resolveErr.message);
        }
      }
    } catch (fbError) {
      // Fallback to legacy JWT verification below if Firebase token verification fails
    }
  }

  // Legacy HMAC-SHA256 JWT verification fallback
  const decoded = verifyToken(token);
  if (!decoded) return res.status(401).json({ error: 'Invalid or expired token' });

  const isGuest = decoded.role === 'guest' || decoded.type === 'guest';
  const userType = isGuest ? 'guest' : (decoded.type || decoded.user_type || (decoded.role === 'admin' ? 'admin' : 'staff'));
  const isStaff  = userType === 'staff';
  const isRootAdmin = !isStaff && (decoded.role === 'admin' && (decoded.id === 1 || !decoded.id));

  req.user = {
    ...decoded,
    id: decoded.id || decoded.mysql_id || null,
    mysql_id: decoded.id || decoded.mysql_id || null,
    user_type: userType,
    type: userType,
    loginType: userType,
    isRootAdmin,
    authProvider: 'legacy'
  };

  // Staff Account Status Check for Legacy Token
  if (isStaff) {
    const staffDbId = req.user.id || req.user.mysql_id || req.user.staff_id;
    if (staffDbId) {
      try {
        const [staffRows] = await pool.query(
          'SELECT status, deleted FROM staff WHERE (id = ? OR username = ?) AND deleted = 0 LIMIT 1',
          [staffDbId, staffDbId]
        );
        if (staffRows.length > 0 && staffRows[0].status === 'Inactive') {
          return res.status(403).json({ error: 'Your account is inactive. Please contact an administrator.', code: 'ACCOUNT_INACTIVE' });
        }
      } catch (err) {}
    }
  }

  next();
};

/** Admin or Staff — general hotel operations. */
export const requireAdmin = (req, res, next) => {
  if (!req.user) return res.status(403).json({ error: 'Forbidden: Admin access required' });
  const roleUpper = String(req.user.role || '').toUpperCase().trim();
  const isStaff = req.user.type === 'staff' || req.user.user_type === 'staff';
  if (roleUpper === 'ADMIN' || isStaff) {
    return next();
  }
  return res.status(403).json({ error: 'Forbidden: Admin or Staff access required' });
};

/**
 * Super Admin only — primary root admin account (MySQL users.id = 1, role='admin', not staff).
 * Used for irreversible / destructive operations such as Factory Reset and Undo Day End.
 */
export const requireSuperAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authorization token required' });
  }

  const roleUpper = String(req.user.role || '').toUpperCase().trim();
  const isStaff = req.user.type === 'staff' || req.user.user_type === 'staff';
  const isRootAccount = req.user.isRootAdmin === true || req.user.id === 1 || req.user.mysql_id === 1;

  if ((roleUpper === 'ADMIN' || roleUpper === 'SUPER_ADMIN') && !isStaff && isRootAccount) {
    return next();
  }

  return res.status(403).json({
    error: 'Forbidden: This action requires Super Administrator privileges.',
    code: 'SUPER_ADMIN_REQUIRED',
  });
};

/** Guest-only routes. */
export const requireGuest = (req, res, next) => {
  if (!req.user || req.user.role !== 'guest') {
    return res.status(403).json({ error: 'Forbidden: Guest access required' });
  }
  next();
};

export const hasPermission = async (req, permissionName, {
  hasFirestorePermissionFn = hasFirestorePermission
} = {}) => {
  if (!req.user) return false;
  let roleName = req.user.role?.toLowerCase() || '';
  if (roleName === 'super_admin') {
    roleName = 'admin';
  }

  // ── Phase 3 Step 4: Firebase-Only RBAC Path ───────────────────────────────
  if (isFirebaseOnlyRbacEnabled()) {
    try {
      const firestoreAllowed = await hasFirestorePermissionFn(roleName, permissionName);
      return Boolean(firestoreAllowed);
    } catch (err) {
      if (err.code === 8 || err.message?.includes('Quota') || err.message?.includes('RESOURCE_EXHAUSTED')) {
        console.warn(`[hasPermission] Firestore quota exceeded for role='${roleName}' perm='${permissionName}'`);
      } else {
        console.error(`[hasPermission] Firestore RBAC lookup error for role='${roleName}' perm='${permissionName}':`, err.message);
      }
      // Hard failure on error when flag is ON — no silent fallback to MySQL
      return false;
    }
  }

  // ── Legacy / Authoritative MySQL RBAC Path (Flag OFF) ─────────────────────
  const [rows] = await pool.query(`
    SELECT p.id
    FROM permissions p
    JOIN role_permissions rp ON p.id = rp.permission_id
    JOIN roles r ON rp.role_id = r.id
    WHERE LOWER(r.name) = ? AND p.name = ?
  `, [roleName, permissionName]);

  return rows.length > 0;
};

/**
 * Role Normalization Helper
 * Maps legacy database/staff roles to normalized canonical role names:
 * - Root user admin (users.id = 1, role = 'admin', type !== 'staff') -> 'super_admin'
 * - Staff ADMIN (type === 'staff', role === 'ADMIN' | 'admin') -> 'admin'
 * - Staff RECEPTIONIST -> 'receptionist'
 * - Staff CLEANER -> 'housekeeper'
 * - Staff CHEF / KITCHEN_HELPER / PANTRY_BOY -> 'kitchen'
 * - Guest -> 'guest'
 */
export function normalizeUserRole(user) {
  if (!user) return null;
  const isStaff = user.type === 'staff' || user.user_type === 'staff';
  const rawRole = String(user.role || '').toUpperCase().trim();

  // Root Super Admin check: user in users table with role 'admin' and not staff
  if (!isStaff && rawRole === 'ADMIN') {
    return 'super_admin';
  }

  // Staff role mapping
  if (isStaff) {
    if (rawRole === 'ADMIN') return 'admin';
    if (rawRole === 'RECEPTIONIST') return 'receptionist';
    if (rawRole === 'CLEANER') return 'housekeeper';
    if (['CHEF', 'KITCHEN_HELPER', 'PANTRY_BOY'].includes(rawRole)) return 'kitchen';
    return rawRole.toLowerCase();
  }

  return rawRole.toLowerCase();
}

/**
 * Flexible multi-role authorization middleware supporting feature flag ENABLE_STRICT_RBAC.
 *
 * When process.env.ENABLE_STRICT_RBAC === 'true':
 *   - Enforces strict canonical role matching.
 * When process.env.ENABLE_STRICT_RBAC !== 'true' (default/absent):
 *   - Preserves legacy requireAdmin authorization behavior for backwards compatibility.
 */
export const requireRole = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authorization token required' });
    }

    const isStrictEnabled = process.env.ENABLE_STRICT_RBAC === 'true';

    if (!isStrictEnabled) {
      // Legacy backwards-compatible behavior: allow if admin or staff
      if (req.user.role === 'admin' || req.user.type === 'staff') {
        return next();
      }
      return res.status(403).json({ error: 'Forbidden: Admin or Staff access required' });
    }

    // Strict RBAC behavior
    const normalizedRole = normalizeUserRole(req.user);

    // super_admin inherits admin privileges
    const effectiveRoles = [normalizedRole];
    if (normalizedRole === 'super_admin') {
      effectiveRoles.push('admin');
    }

    const isAllowed = allowedRoles.some(role => effectiveRoles.includes(role.toLowerCase()));

    if (isAllowed) {
      return next();
    }

    return res.status(403).json({
      error: `Forbidden: Access restricted. Requires one of: [${allowedRoles.join(', ')}]`,
      code: 'INSUFFICIENT_ROLE_PRIVILEGES'
    });
  };
};

/**
 * GET /api/auth/me
 * ─────────────────────────────────────────────────────────────────────────────
 * Secure identity endpoint for Firebase-authenticated staff and root admin.
 * Uses canonical resolveCanonicalFirebaseUser helper to guarantee 100% identity parity
 * with `authenticate` middleware.
 */
export const getMe = async (req, res) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return res.status(401).json({ error: 'Authorization header is missing' });
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.status(401).json({ error: 'Invalid Authorization header format' });
  }

  const token = parts[1];
  const isFirebaseAuthEnabled = process.env.ENABLE_FIREBASE_AUTH === 'true';

  // ── Firebase path ────────────────────────────────────────────────────────
  if (isFirebaseAuthEnabled && isFirebaseConfigured && auth) {
    try {
      const decoded = await auth.verifyIdToken(token);
      try {
        const user = await resolveCanonicalFirebaseUser(decoded);
        return res.json({ user });
      } catch (err) {
        if (err.code === 'ACCOUNT_INACTIVE' || err.status === 403) {
          return res.status(403).json({
            error: err.message,
            code: 'ACCOUNT_INACTIVE'
          });
        }
        if (err.code === 'ROLE_INDETERMINATE' || err.status === 422) {
          return res.status(422).json({
            error: err.message,
            code: 'ROLE_INDETERMINATE'
          });
        }
        throw err;
      }
    } catch (fbError) {
      if (fbError.code === 'ACCOUNT_INACTIVE' || fbError.status === 403) {
        return res.status(403).json({ error: fbError.message, code: 'ACCOUNT_INACTIVE' });
      }
      console.warn('[getMe] Firebase token verification failed, trying legacy JWT:', fbError.message);
    }
  }

  // ── Legacy JWT fallback ──────────────────────────────────────────────────
  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const isGuest = decoded.role === 'guest' || decoded.type === 'guest';
  const userType = isGuest ? 'guest' : (decoded.type || decoded.user_type || (decoded.role === 'admin' ? 'admin' : 'staff'));
  const isStaff  = userType === 'staff';
  const isRootAdmin = !isStaff && (decoded.role === 'admin' && (decoded.id === 1 || !decoded.id));

  // For staff legacy tokens, resolve the MySQL record for canonical role
  if (isStaff && (decoded.id || decoded.mysql_id)) {
    const dbId = decoded.id || decoded.mysql_id;
    try {
      const [staffRows] = await pool.query(
        `SELECT id, username, full_name, role, department, shift, status, deleted
         FROM staff WHERE (id = ? OR username = ?) AND deleted = 0 LIMIT 1`,
        [dbId, dbId]
      );

      if (staffRows.length > 0) {
        const staff = staffRows[0];
        if (staff.status === 'Inactive' || staff.deleted === 1) {
          return res.status(403).json({
            error: 'Your account is inactive. Please contact an administrator.',
            code: 'ACCOUNT_INACTIVE'
          });
        }
        return res.json({
          user: {
            id:           staff.id,
            username:     staff.username,
            full_name:    staff.full_name,
            role:         staff.role,
            department:   staff.department,
            shift:        staff.shift,
            loginType:    'staff',
            user_type:    'staff',
            type:         'staff',
            isRootAdmin:  false,
            authProvider: 'legacy'
          }
        });
      }
    } catch (dbErr) {
      console.error('[getMe] Legacy JWT MySQL staff lookup error:', dbErr.message);
    }
  }

  // Non-staff / root admin legacy token — return decoded claims directly
  return res.json({
    user: {
      id:           decoded.id || 1,
      username:     decoded.username || 'admin',
      full_name:    decoded.fullName || decoded.full_name || 'ADMINISTRATOR',
      role:         decoded.role || 'admin',
      loginType:    userType,
      user_type:    userType,
      type:         userType,
      isRootAdmin,
      authProvider: 'legacy'
    }
  });
};

