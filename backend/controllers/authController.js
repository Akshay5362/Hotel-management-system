import pool from '../db.js';
import { BusinessDateService } from '../services/businessDateService.js';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { db, auth, isFirebaseConfigured } from '../config/firebaseAdmin.js';
import { enqueue } from '../services/outboxService.js';
import { isFirestoreDualWriteEnabled } from '../config/featureFlags.js';

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

    await connection.query(
      `INSERT INTO guests (full_name, phone, user_id) VALUES (?, ?, ?)`,
      [cleanFullName, cleanPhone, userId]
    );

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
    const storedHash = user.password;
    let passwordValid = false;

    if (storedHash && storedHash.startsWith('$2')) {
      passwordValid = await bcrypt.compare(password, storedHash);
    } else {
      passwordValid = storedHash === hashPassword(password);
    }

    if (!passwordValid) {
      return res.status(400).json({ error: 'Invalid username or password' });
    }

    const { password: _omit, ...safeUser } = user;

    // Phase 1: Guest Lazy Auth Migration Trigger
    if ((safeUser.role === 'guest' || !safeUser.role) && process.env.ENABLE_FIREBASE_AUTH === 'true') {
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

    // Step 3: Ensure Custom Claims are set
    const currentClaims = authUser.customClaims || {};
    if (currentClaims.role !== 'guest' || currentClaims.user_type !== 'guest' || Number(currentClaims.mysql_id) !== user.id) {
      await auth.setCustomUserClaims(actualUid, {
        role: 'guest',
        user_type: 'guest',
        mysql_id: user.id
      });
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
        req.user = {
          uid: decodedFirebase.uid,
          email: decodedFirebase.email || null,
          role: decodedFirebase.role || 'guest',
          type: decodedFirebase.user_type || (decodedFirebase.role === 'guest' ? 'guest' : 'staff'),
          id: decodedFirebase.mysql_id || null,
          mysql_id: decodedFirebase.mysql_id || null,
          authProvider: 'firebase'
        };
        return next();
      }
    } catch (fbError) {
      // Fallback to legacy JWT verification below if Firebase token verification fails
    }
  }

  // Legacy HMAC-SHA256 JWT verification fallback
  const decoded = verifyToken(token);
  if (!decoded) return res.status(401).json({ error: 'Invalid or expired token' });

  req.user = decoded;
  next();
};

/** Admin or Staff — general hotel operations. */
export const requireAdmin = (req, res, next) => {
  if (!req.user) return res.status(403).json({ error: 'Forbidden: Admin access required' });
  if (req.user.role !== 'admin' && req.user.type !== 'staff') {
    return res.status(403).json({ error: 'Forbidden: Admin or Staff access required' });
  }
  next();
};

/**
 * Super Admin only — primary admin account (role='admin', not staff).
 * Used for irreversible / destructive operations such as Undo Day End.
 */
export const requireSuperAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin' || req.user.type === 'staff') {
    return res.status(403).json({
      error: 'Forbidden: This action requires Super Administrator privileges.',
      code: 'SUPER_ADMIN_REQUIRED',
    });
  }
  next();
};

/** Guest-only routes. */
export const requireGuest = (req, res, next) => {
  if (!req.user || req.user.role !== 'guest') {
    return res.status(403).json({ error: 'Forbidden: Guest access required' });
  }
  next();
};

export const hasPermission = async (req, permissionName) => {
  if (!req.user) return false;
  const roleName = req.user.role?.toLowerCase() || '';
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
  const isStaff = user.type === 'staff';
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
