const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const pool    = require('../config/db');
const { authenticate } = require('../middleware/auth');

// Helper — sign a JWT
function signToken(userId) {
  return jwt.sign(
    { userId },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

// POST /api/auth/register
router.post('/register', [
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }).withMessage('Min 6 characters'),
  body('role').isIn(['provider', 'client']).withMessage('Role must be provider or client'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { name, email, password, role } = req.body;
  try {
    const exists = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
    if (exists.rows.length) return res.status(409).json({ error: 'Email already registered' });

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ($1,$2,$3,$4) RETURNING id, name, email, role`,
      [name, email, hash, role]
    );

    // Create empty provider profile if registering as provider
    if (role === 'provider') {
      await pool.query(
        'INSERT INTO provider_profiles (user_id) VALUES ($1)',
        [rows[0].id]
      );
    }

    const token = signToken(rows[0].id);
    res.status(201).json({ token, user: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/login
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { email, password } = req.body;
  try {
    const { rows } = await pool.query(
      'SELECT id, name, email, role, password_hash FROM users WHERE email=$1',
      [email]
    );
    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const { password_hash, ...user } = rows[0];
    const token = signToken(user.id);
    res.json({ token, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/me — returns current user
router.get('/me', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.email, u.role, u.avatar_url, u.bio,
              pp.category, pp.location, pp.rating, pp.review_count, pp.is_available
       FROM users u
       LEFT JOIN provider_profiles pp ON pp.user_id = u.id
       WHERE u.id = $1`,
      [req.user.id]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/auth/profile — update name, bio, location
router.patch('/profile', authenticate, async (req, res) => {
  const { name, bio, category, location } = req.body;
  try {
    if (name || bio) {
      await pool.query(
        'UPDATE users SET name=COALESCE($1,name), bio=COALESCE($2,bio) WHERE id=$3',
        [name, bio, req.user.id]
      );
    }
    if ((category || location) && req.user.role === 'provider') {
      await pool.query(
        `UPDATE provider_profiles
         SET category=COALESCE($1,category), location=COALESCE($2,location)
         WHERE user_id=$3`,
        [category, location, req.user.id]
      );
    }
    res.json({ message: 'Profile updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
