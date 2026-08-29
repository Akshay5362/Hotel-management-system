import pool from '../db.js';
import https from 'https';
import { BusinessDateService } from '../services/businessDateService.js';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { db, auth, isFirebaseConfigured } from '../config/firebaseAdmin.js';
import {
  isFirebaseOnlyStaffResolutionEnabled,
  isFirebaseStaffLoginEnabled,
  isFirebaseGuestLoginEnabled,
  isFirebaseOnlyGuestResolutionEnabled,
  isFirebaseOnlyRbacEnabled,
  isMysqlCutoverFallbacksDisabled
} from '../config/featureFlags.js';
import {
  getGuestByIdFirestore,
  createGuestFirestore,
  updateGuestFirestore
} from '../repositories/firestore/guestsRepository.js';
import { getStaffByUsernameFirestore, getStaffByIdFirestore, getAllStaffFirestore } from '../repositories/firestore/staffRepository.js';
import { getUserByUsernameFirestore, getUserByIdFirestore } from '../repositories/firestore/usersRepository.js';
import { createAuditLogFirestore } from '../repositories/firestore/auditLogsRepository.js';
import { hasFirestorePermission } from '../repositories/firestore/rbacRepository.js';

function hashPassword(pass) {
  return crypto.createHash('sha256').update(pass).digest('hex');
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

      let idToken = null;
      try {
        const authResult = await verifyFirebasePassword(email, password);
        if (authResult.status === 200 && authResult.data?.idToken) {
          idToken = authResult.data.idToken;
        }
      } catch (_) {}

      return res.status(201).json({
        message: 'Account registered successfully',
        user,
        token: idToken,
        idToken
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

    res.status(201).json({
      message: 'Account registered successfully',
      user,
      token: null,
      idToken: null
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

const USERNAME_EMAIL_MAP = {
  'admin': 'admin@hpms-sky5.internal',
  'superadmin': 'admin@hpms-sky5.internal',
  'keval': 'keval@hpms-sky5.internal',
  'reception_morning': 'reception.morning@hotelsky5.com',
  'reception_evening': 'reception.evening@hotelsky5.com',
  'reception_night': 'reception.night@hotelsky5.com',
  'chef': 'chef@hotelsky5.com',
  'helper': 'helper@hotelsky5.com',
  'pantry1': 'pantry1@hotelsky5.com',
  'pantry2': 'pantry2@hotelsky5.com',
  'cleaner1': 'cleaner1@hotelsky5.com',
  'cleaner2': 'cleaner2@hotelsky5.com',
  'reception2': 'reception2@hotelsky5.com',
  'akshay': 'akshay@hpms-sky5.internal'
};

function resolveAuthEmail(username) {
  if (!username || typeof username !== 'string') return '';
  const clean = username.trim().toLowerCase();
  if (clean.includes('@')) return clean;
  return USERNAME_EMAIL_MAP[clean] || `${clean}@hotelsky5.com`;
}

function verifyFirebasePassword(email, password) {
  const apiKey = process.env.FIREBASE_WEB_API_KEY || process.env.VITE_FIREBASE_API_KEY || 'AIzaSyBWVlM8MgdWogVnvse7zmCITnIsp7_KXBs';
  const postData = JSON.stringify({ email, password, returnSecureToken: true });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'identitytoolkit.googleapis.com',
      port: 443,
      path: `/v1/accounts:signInWithPassword?key=${apiKey}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', err => resolve({ status: 500, error: err.message }));
    req.write(postData);
    req.end();
  });
}

export const signIn = async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const cleanUsername = username.trim().toLowerCase();

  // ── Pure Firestore / Firebase Authentication Path ─────────────────────────
  if (isFirebaseStaffLoginEnabled() || isMysqlCutoverFallbacksDisabled() || (isFirebaseConfigured && auth)) {
    try {
      const primaryEmail = resolveAuthEmail(cleanUsername);
      let authResult = await verifyFirebasePassword(primaryEmail, password);

      // If username 'admin' or 'superadmin' failed on internal domain, try staff admin email
      if (authResult.status !== 200 && (cleanUsername === 'admin' || cleanUsername === 'superadmin')) {
        const fallbackResult = await verifyFirebasePassword('admin@hotelsky5.com', password);
        if (fallbackResult.status === 200) {
          authResult = fallbackResult;
        }
      }

      if (authResult.status === 200 && authResult.data?.idToken) {
        const decoded = await auth.verifyIdToken(authResult.data.idToken);
        let user = null;
        try {
          user = await resolveCanonicalFirebaseUser(decoded);
        } catch (resolveErr) {
          if (resolveErr.code === 'ACCOUNT_INACTIVE' || resolveErr.status === 403) {
            return res.status(403).json({ error: resolveErr.message, code: 'ACCOUNT_INACTIVE' });
          }
          throw resolveErr;
        }

        if (user.status === 'Inactive') {
          return res.status(403).json({ error: 'Your account is inactive. Please contact an administrator.', code: 'ACCOUNT_INACTIVE' });
        }

        const idToken = authResult.data.idToken;

        try {
          const businessDate = await BusinessDateService.getBusinessDate();
          await createAuditLogFirestore({
            user_id: user.id || user.uid || cleanUsername,
            action: 'LOGIN',
            details: `User logged in: ${user.username || cleanUsername} (${user.role})`,
            business_date: businessDate
          });
        } catch (auditErr) {
          console.warn('[signIn] Non-fatal audit log warning:', auditErr.message);
        }

        return res.json({ message: 'Logged in successfully', user, token: idToken, idToken });
      }

      // If Firebase Auth returns error
      if (authResult.status === 400) {
        const errMsg = authResult.data?.error?.message;
        if (errMsg === 'EMAIL_NOT_FOUND' || errMsg === 'INVALID_PASSWORD' || errMsg === 'INVALID_LOGIN_CREDENTIALS') {
          return res.status(400).json({ error: 'Invalid username or password' });
        }
        if (errMsg === 'USER_DISABLED') {
          return res.status(403).json({ error: 'Your account is inactive. Please contact an administrator.', code: 'ACCOUNT_INACTIVE' });
        }
        return res.status(400).json({ error: 'Invalid username or password' });
      }

      // When MySQL cutover fallbacks are disabled, fail closed without attempting MySQL
      if (isMysqlCutoverFallbacksDisabled()) {
        return res.status(401).json({ error: 'Authentication failed. Please check your credentials.' });
      }
    } catch (fsAuthErr) {
      if (fsAuthErr.code === 'ACCOUNT_INACTIVE' || fsAuthErr.status === 403) {
        return res.status(403).json({ error: fsAuthErr.message, code: 'ACCOUNT_INACTIVE' });
      }
      console.error('[signIn] Firebase auth error:', fsAuthErr.message);
      if (isMysqlCutoverFallbacksDisabled()) {
        return res.status(401).json({ error: 'Authentication service temporarily unavailable. Please try again.' });
      }
    }
  }

  // ── Legacy Development MySQL Fallback Path (only when MySQL fallbacks enabled) ──
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
      if (isFirebaseStaffLoginEnabled()) {
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
        const safeStaff = {
          id: staff.id, username: staff.username, full_name: staff.full_name,
          role: staff.role, department: staff.department, shift: staff.shift, loginType: 'staff'
        };
        return res.json({ message: 'Logged in successfully', user: safeStaff, token: null, idToken: null });
      }

      return res.status(400).json({ error: 'Invalid username or password' });
    }

    const user = users[0];
    const { password: storedHash, ...safeUser } = user;
    const isGuestRole = (safeUser.role === 'guest' || !safeUser.role);

    if (isGuestRole && isFirebaseGuestLoginEnabled()) {
      return res.status(401).json({
        error: 'Guest login via username/password is disabled. Please use Firebase Authentication.',
        code:  'FIREBASE_LOGIN_REQUIRED'
      });
    }

    let passwordValid = false;
    if (storedHash && storedHash.startsWith('$2')) {
      passwordValid = await bcrypt.compare(password, storedHash);
    } else {
      passwordValid = storedHash === hashPassword(password);
    }

    if (!passwordValid) {
      return res.status(400).json({ error: 'Invalid username or password' });
    }

    if (isGuestRole && process.env.ENABLE_FIREBASE_AUTH === 'true') {
      await ensureGuestLazyAuthMigration(safeUser, password);
    }

    return res.json({ message: 'Logged in successfully', user: safeUser, token: null, idToken: null });
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
  if (isStaffToken && ((mysqlId || staffClaimId) || isFirebaseOnlyStaffResolutionEnabled() || isMysqlCutoverFallbacksDisabled())) {

    // ── Phase 3 Step 3B: Firebase-Only Staff Resolution Path ───────────────────
    if (isFirebaseOnlyStaffResolutionEnabled() || isMysqlCutoverFallbacksDisabled()) {

      // Validate required claims are present
      const staffUsername = decodedFirebase.staff_username || null;
      if (!mysqlId && !staffUsername && !decodedFirebase.email) {
        const err = new Error('Firebase staff token is missing claims. Re-provision this account via Phase 3 Step 3A.');
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

      // Attempt Firestore staff document lookup
      let firestoreProfile = null;
      try {
        if (staffUsername) {
          firestoreProfile = await getStaffByUsernameFn(staffUsername);
        }
        if (!firestoreProfile && mysqlId) {
          firestoreProfile = await getStaffByIdFn(mysqlId);
        }
        if (!firestoreProfile && decodedFirebase.email) {
          const staffList = await getAllStaffFirestore({ filters: [{ field: 'email', op: '==', value: decodedFirebase.email }] });
          if (staffList && staffList.length > 0) {
            firestoreProfile = staffList[0];
          }
        }
      } catch (fsErr) {
        if (fsErr.code === 8 || fsErr.message?.includes('Quota') || fsErr.message?.includes('RESOURCE_EXHAUSTED')) {
          console.warn('[resolveCanonicalFirebaseUser] Firestore quota exceeded — using claims-only for staff profile supplementation');
        } else {
          console.warn('[resolveCanonicalFirebaseUser] Firestore staff lookup warning:', fsErr.message);
        }
      }

      const resolvedStaffUsername = staffUsername || firestoreProfile?.username || decodedFirebase.email?.split('@')[0] || `staff_${mysqlId || 'user'}`;
      const resolvedRole = decodedFirebase.role || firestoreProfile?.role || 'staff';

      // Build canonical user object from claims + optional Firestore supplement
      resolvedUser = {
        uid:          decodedFirebase.uid,
        id:           mysqlId || firestoreProfile?.mysql_staff_id || firestoreProfile?.id || 1,
        mysql_id:     mysqlId || firestoreProfile?.mysql_staff_id || firestoreProfile?.id || 1,
        staff_id:     resolvedStaffUsername,
        username:     resolvedStaffUsername,
        full_name:    firestoreProfile?.full_name || decodedFirebase.name || decodedFirebase.displayName || resolvedStaffUsername,
        role:         resolvedRole,
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
    if (isFirebaseOnlyRbacEnabled() || isMysqlCutoverFallbacksDisabled()) {
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
      id:           mysqlId || 1,
      mysql_id:     mysqlId || 1,
      staff_id:     staffClaimId || displayName,
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

  if (!isFirebaseConfigured || !auth) {
    return res.status(503).json({ error: 'Authentication service unavailable' });
  }

  try {
    const decodedFirebase = await auth.verifyIdToken(token);
    if (!decodedFirebase) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    req.firebaseUser = decodedFirebase;
    req.user = await resolveCanonicalFirebaseUser(decodedFirebase);
    return next();
  } catch (err) {
    if (err.code === 'ACCOUNT_INACTIVE' || err.status === 403) {
      return res.status(403).json({ error: err.message, code: 'ACCOUNT_INACTIVE' });
    }
    if (err.code === 'ROLE_INDETERMINATE' || err.status === 422) {
      return res.status(422).json({ error: err.message, code: 'ROLE_INDETERMINATE' });
    }
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

/** Admin or Staff — general hotel operations. */
export const requireAdmin = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Authorization token required' });
  if (req.user.role === 'admin' || req.user.type === 'staff') return next();
  return res.status(403).json({ error: 'Forbidden: Admin access required' });
};

/** Super Admin only — destructive operations (e.g. factory reset). */
export const requireSuperAdmin = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Authorization token required' });
  const isSuperAdmin = req.user.isRootAdmin === true || req.user.role === 'super_admin' || req.user.id === 1;
  if (isSuperAdmin) return next();
  return res.status(403).json({ error: 'Forbidden: Super Admin access required' });
};

/** Guest only. */
export const requireGuest = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Authorization token required' });
  if (req.user.role === 'guest' || req.user.user_type === 'guest') return next();
  return res.status(403).json({ error: 'Forbidden: Guest access required' });
};

export const hasPermission = async (req, permissionName, {
  // Injectable for unit-testing: hasFirestorePermissionFn defaults to hasFirestorePermission from rbacRepository
  hasFirestorePermissionFn = hasFirestorePermission
} = {}) => {
  if (!req.user) return false;
  if (req.user.isRootAdmin || req.user.id === 1) return true;

  const roleName = String(req.user.role || '').toLowerCase();

  // ── Phase 3 Step 4: Firebase-Only RBAC (ZERO MySQL queries) ──────────────
  if (isFirebaseOnlyRbacEnabled() || isMysqlCutoverFallbacksDisabled()) {
    try {
      const firestoreAllowed = await hasFirestorePermissionFn(roleName, permissionName);
      return Boolean(firestoreAllowed);
    } catch (err) {
      if (err.code === 8 || err.message?.includes('Quota') || err.message?.includes('RESOURCE_EXHAUSTED')) {
        console.warn(`[hasPermission] Firestore quota exceeded for role='${roleName}' perm='${permissionName}'`);
      } else {
        console.error(`[hasPermission] Firestore RBAC lookup error for role='${roleName}' perm='${permissionName}':`, err.message);
      }
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
 */
export function normalizeUserRole(user) {
  if (!user) return null;
  const isStaff = user.type === 'staff' || user.user_type === 'staff';
  const rawRole = String(user.role || '').toUpperCase().trim();

  // Root Super Admin check
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
 */
export const requireRole = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authorization token required' });
    }

    const isStrictEnabled = process.env.ENABLE_STRICT_RBAC === 'true';

    if (!isStrictEnabled) {
      if (req.user.role === 'admin' || req.user.type === 'staff') {
        return next();
      }
      return res.status(403).json({ error: 'Forbidden: Admin or Staff access required' });
    }

    // Strict RBAC behavior
    const normalizedRole = normalizeUserRole(req.user);

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

  if (!isFirebaseConfigured || !auth) {
    return res.status(503).json({ error: 'Authentication service unavailable' });
  }

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
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

