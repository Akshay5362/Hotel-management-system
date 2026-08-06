import pool from '../db.js';
import { BusinessDateService } from '../services/businessDateService.js';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';

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
    res.status(201).json({ message: 'Account registered successfully', user, token });
  } catch (error) {
    if (connection) { try { await connection.rollback(); } catch (e) { } }
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'An account with this phone number already exists. Try signing in instead.' });
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

// ── Middleware ─────────────────────────────────────────────────────────────

export const authenticate = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ error: 'Authorization header is missing' });

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.status(401).json({ error: 'Invalid Authorization header format' });
  }

  const token = parts[1];
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
