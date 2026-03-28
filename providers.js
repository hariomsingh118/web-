const router = require('express').Router();
const pool   = require('../config/db');
const { authenticate, requireRole } = require('../middleware/auth');

// GET /api/providers — list all with optional ?category= filter
router.get('/', async (req, res) => {
  const { category, search } = req.query;
  try {
    let q = `
      SELECT u.id, u.name, u.email, u.avatar_url,
             pp.category, pp.location, pp.rating, pp.review_count,
             pp.experience_yrs, pp.is_available
      FROM users u
      JOIN provider_profiles pp ON pp.user_id = u.id
      WHERE u.role = 'provider'`;
    const params = [];
    if (category) { params.push(category); q += ` AND pp.category = $${params.length}`; }
    if (search)   { params.push(`%${search}%`); q += ` AND (u.name ILIKE $${params.length} OR pp.category ILIKE $${params.length})`; }
    q += ' ORDER BY pp.rating DESC';
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/providers/:id — single provider with services
router.get('/:id', async (req, res) => {
  try {
    const { rows: [provider] } = await pool.query(
      `SELECT u.id, u.name, u.bio, u.avatar_url,
              pp.category, pp.location, pp.rating, pp.review_count, pp.experience_yrs
       FROM users u JOIN provider_profiles pp ON pp.user_id = u.id
       WHERE u.id = $1 AND u.role = 'provider'`,
      [req.params.id]
    );
    if (!provider) return res.status(404).json({ error: 'Provider not found' });

    const { rows: services } = await pool.query(
      'SELECT * FROM services WHERE provider_id=$1 AND is_active=true ORDER BY price',
      [req.params.id]
    );

    const { rows: reviews } = await pool.query(
      `SELECT r.rating, r.comment, r.created_at, u.name AS client_name
       FROM reviews r JOIN users u ON u.id = r.client_id
       WHERE r.provider_id=$1 ORDER BY r.created_at DESC LIMIT 5`,
      [req.params.id]
    );

    res.json({ ...provider, services, reviews });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/providers/:id/slots?date=YYYY-MM-DD
router.get('/:id/slots', async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date query param required' });
  try {
    const { rows } = await pool.query(
      `SELECT id, slot_date, start_time, end_time, status
       FROM time_slots
       WHERE provider_id=$1 AND slot_date=$2
       ORDER BY start_time`,
      [req.params.id, date]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/providers/slots — provider creates/manages their slots
router.post('/slots', authenticate, requireRole('provider'), async (req, res) => {
  const { slot_date, start_time, end_time } = req.body;
  if (!slot_date || !start_time || !end_time)
    return res.status(400).json({ error: 'slot_date, start_time, end_time required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO time_slots (provider_id, slot_date, start_time, end_time)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (provider_id, slot_date, start_time) DO NOTHING
       RETURNING *`,
      [req.user.id, slot_date, start_time, end_time]
    );
    res.status(201).json(rows[0] || { message: 'Slot already exists' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/providers/slots/:slotId — block or re-open a slot
router.patch('/slots/:slotId', authenticate, requireRole('provider'), async (req, res) => {
  const { status } = req.body;
  if (!['available', 'blocked'].includes(status))
    return res.status(400).json({ error: 'status must be available or blocked' });
  try {
    const { rows } = await pool.query(
      `UPDATE time_slots SET status=$1
       WHERE id=$2 AND provider_id=$3 AND status != 'booked'
       RETURNING *`,
      [status, req.params.slotId, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Slot not found or already booked' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/providers/me/services — provider views their own services
router.get('/me/services', authenticate, requireRole('provider'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM services WHERE provider_id=$1 ORDER BY created_at',
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/providers/me/services — add a new service
router.post('/me/services', authenticate, requireRole('provider'), async (req, res) => {
  const { name, description, price, duration_min } = req.body;
  if (!name || !price || !duration_min)
    return res.status(400).json({ error: 'name, price, duration_min required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO services (provider_id, name, description, price, duration_min)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.user.id, name, description, price, duration_min]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/providers/me/services/:id — toggle active or update price
router.patch('/me/services/:id', authenticate, requireRole('provider'), async (req, res) => {
  const { name, price, duration_min, is_active } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE services
       SET name=COALESCE($1,name), price=COALESCE($2,price),
           duration_min=COALESCE($3,duration_min), is_active=COALESCE($4,is_active)
       WHERE id=$5 AND provider_id=$6 RETURNING *`,
      [name, price, duration_min, is_active, req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Service not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
