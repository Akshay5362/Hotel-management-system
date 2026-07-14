import pool from '../db.js';
import crypto from 'crypto';

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

  // Validation
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

  const cleanUsername = username.trim().toLowerCase();
  const cleanFullName = fullName.trim();
  const cleanPhone = (phone || mobile || '').trim();
  const userRole = 'guest'; // Guests cannot create admin accounts under any circumstance. Always force 'guest' role on signup.

  let connection;
  try {
    const passwordHash = hashPassword(password);
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [roles] = await connection.query("SELECT id FROM roles WHERE name = 'guest'");
    const roleId = roles[0]?.id || null;

    const [result] = await connection.query(
      `INSERT INTO users (username, password, fullName, phone, role_id) VALUES (?, ?, ?, ?, ?)`,
      [cleanUsername, passwordHash, cleanFullName, cleanPhone, roleId]
    );
    const userId = result.insertId;

    await connection.query(
      `INSERT INTO guests (full_name, phone, user_id) VALUES (?, ?, ?)`,
      [cleanFullName, cleanPhone, userId]
    );

    // Insert Audit Log entry
    await connection.query(
      `INSERT INTO audit_logs (user_id, action, details, business_date)
       VALUES (?, 'SIGNUP', ?, '11-Jul-2026')`,
      [userId, `Guest account registered: ${cleanUsername} (${cleanFullName})`]
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

    res.status(201).json({
      message: 'Account registered successfully',
      user,
      token
    });
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error('Rollback failed:', rollbackError);
      }
    }
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'Username is already taken' });
    }
    console.error('Error during signUp:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    if (connection) {
      connection.release();
    }
  }
};

export const signIn = async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const cleanUsername = username.trim().toLowerCase();

  try {
    const passwordHash = hashPassword(password);

    const [users] = await pool.query(
      `SELECT u.id, u.username, u.fullName, u.phone, r.name as role, g.loyalty_tier, g.loyalty_points 
       FROM users u
       LEFT JOIN roles r ON u.role_id = r.id 
       LEFT JOIN guests g ON g.user_id = u.id
       WHERE u.username = ? AND u.password = ?`,
      [cleanUsername, passwordHash]
    );

    if (users.length === 0) {
      return res.status(400).json({ error: 'Invalid username or password' });
    }

    const user = users[0];
    const token = generateToken(user);

    // Fetch system date for audit log
    const [settings] = await pool.query('SELECT value_val FROM system_settings WHERE key_name = ?', ['system_date']);
    const businessDate = settings[0]?.value_val || '11-Jul-2026';

    // Insert Audit Log entry
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, details, business_date)
       VALUES (?, 'LOGIN', ?, ?)`,
      [user.id, `User logged in: ${user.username} (${user.role})`, businessDate]
    );

    res.json({
      message: 'Logged in successfully',
      user,
      token
    });
  } catch (error) {
    console.error('Error during signIn:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

// Middlewares
export const authenticate = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return res.status(401).json({ error: 'Authorization header is missing' });
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.status(401).json({ error: 'Invalid Authorization header format' });
  }

  const token = parts[1];
  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  req.user = decoded;
  next();
};

export const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden: Admin access required' });
  }
  next();
};
