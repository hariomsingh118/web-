const router = require('express').Router();
const pool   = require('../config/db');
const { authenticate, requireRole } = require('../middleware/auth');

// Helper — emit a Socket.io notification to a user room
function notify(io, userId, type, title, body) {
  io.to(`user:${userId}`).emit('notification', { type, title, body, createdAt: new Date() });
}

// POST /api/bookings — client creates a booking
router.post('/', authenticate, requireRole('client'), async (req, res) => {
  const io = req.app.get('io');
  const { provider_id, service_id, slot_id, notes } = req.body;
  if (!provider_id || !service_id || !slot_id)
    return res.status(400).json({ error: 'provider_id, service_id, slot_id required' });

  const db = await pool.connect();
  try {
    await db.query('BEGIN');

    // Lock the slot row to prevent double-booking
    const { rows: [slot] } = await db.query(
      'SELECT * FROM time_slots WHERE id=$1 FOR UPDATE',
      [slot_id]
    );
    if (!slot) { await db.query('ROLLBACK'); return res.status(404).json({ error: 'Slot not found' }); }
    if (slot.status !== 'available') { await db.query('ROLLBACK'); return res.status(409).json({ error: 'Slot is no longer available' }); }

    const { rows: [svc] } = await db.query(
      'SELECT price FROM services WHERE id=$1', [service_id]
    );

    const { rows: [booking] } = await db.query(
      `INSERT INTO bookings (client_id, provider_id, service_id, slot_id, notes, total_price)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.user.id, provider_id, service_id, slot_id, notes, svc?.price]
    );

    await db.query('UPDATE time_slots SET status=$1 WHERE id=$2', ['booked', slot_id]);
    await db.query('COMMIT');

    // Real-time: notify the provider
    notify(io, provider_id, 'new_booking',
      'New booking request',
      `${req.user.name} booked a session on ${slot.slot_date}`
    );

    // Also store in DB
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, body)
       VALUES ($1,'new_booking',$2,$3)`,
      [provider_id, 'New booking request', `${req.user.name} booked a session`]
    );

    res.status(201).json(booking);
  } catch (err) {
    await db.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    db.release();
  }
});

// GET /api/bookings — list bookings for the logged-in user (client or provider)
router.get('/', authenticate, async (req, res) => {
  const { status } = req.query;
  const field = req.user.role === 'client' ? 'b.client_id' : 'b.provider_id';
  try {
    let q = `
      SELECT b.id, b.status, b.notes, b.total_price, b.booked_at,
             ts.slot_date, ts.start_time, ts.end_time,
             s.name  AS service_name,
             c.name  AS client_name,  c.email AS client_email,
             p.name  AS provider_name, p.email AS provider_email
      FROM bookings b
      JOIN time_slots ts ON ts.id = b.slot_id
      JOIN services   s  ON s.id  = b.service_id
      JOIN users      c  ON c.id  = b.client_id
      JOIN users      p  ON p.id  = b.provider_id
      WHERE ${field} = $1`;
    const params = [req.user.id];
    if (status) { params.push(status); q += ` AND b.status = $${params.length}`; }
    q += ' ORDER BY ts.slot_date DESC, ts.start_time DESC';
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/bookings/:id
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { rows: [booking] } = await pool.query(
      `SELECT b.*, ts.slot_date, ts.start_time, ts.end_time,
              s.name AS service_name, s.duration_min,
              c.name AS client_name,  c.email AS client_email,
              p.name AS provider_name, p.email AS provider_email
       FROM bookings b
       JOIN time_slots ts ON ts.id = b.slot_id
       JOIN services   s  ON s.id  = b.service_id
       JOIN users      c  ON c.id  = b.client_id
       JOIN users      p  ON p.id  = b.provider_id
       WHERE b.id=$1 AND (b.client_id=$2 OR b.provider_id=$2)`,
      [req.params.id, req.user.id]
    );
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    res.json(booking);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/bookings/:id/confirm — provider confirms a pending booking
router.patch('/:id/confirm', authenticate, requireRole('provider'), async (req, res) => {
  const io = req.app.get('io');
  try {
    const { rows: [booking] } = await pool.query(
      `UPDATE bookings SET status='confirmed'
       WHERE id=$1 AND provider_id=$2 AND status='pending'
       RETURNING *`,
      [req.params.id, req.user.id]
    );
    if (!booking) return res.status(404).json({ error: 'Booking not found or already confirmed' });

    notify(io, booking.client_id, 'booking_confirmed',
      'Booking confirmed!',
      `${req.user.name} confirmed your booking`
    );
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, body)
       VALUES ($1,'booking_confirmed','Booking confirmed!',$2)`,
      [booking.client_id, `${req.user.name} confirmed your booking`]
    );
    res.json(booking);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/bookings/:id/cancel — either party can cancel
router.patch('/:id/cancel', authenticate, async (req, res) => {
  const io = req.app.get('io');
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const { rows: [booking] } = await db.query(
      `UPDATE bookings SET status='cancelled'
       WHERE id=$1 AND (client_id=$2 OR provider_id=$2) AND status IN ('pending','confirmed')
       RETURNING *`,
      [req.params.id, req.user.id]
    );
    if (!booking) { await db.query('ROLLBACK'); return res.status(404).json({ error: 'Booking not found or cannot be cancelled' }); }

    // Free the slot back
    await db.query('UPDATE time_slots SET status=$1 WHERE id=$2', ['available', booking.slot_id]);
    await db.query('COMMIT');

    const notifyId = req.user.id === booking.client_id ? booking.provider_id : booking.client_id;
    notify(io, notifyId, 'booking_cancelled', 'Booking cancelled', `${req.user.name} cancelled the booking`);
    res.json(booking);
  } catch (err) {
    await db.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    db.release();
  }
});

// PATCH /api/bookings/:id/complete — provider marks session done
router.patch('/:id/complete', authenticate, requireRole('provider'), async (req, res) => {
  try {
    const { rows: [booking] } = await pool.query(
      `UPDATE bookings SET status='completed'
       WHERE id=$1 AND provider_id=$2 AND status='confirmed'
       RETURNING *`,
      [req.params.id, req.user.id]
    );
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    res.json(booking);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/bookings/:id/review — client leaves a review after completion
router.post('/:id/review', authenticate, requireRole('client'), async (req, res) => {
  const { rating, comment } = req.body;
  if (!rating || rating < 1 || rating > 5)
    return res.status(400).json({ error: 'rating must be 1–5' });
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const { rows: [booking] } = await db.query(
      `SELECT * FROM bookings WHERE id=$1 AND client_id=$2 AND status='completed'`,
      [req.params.id, req.user.id]
    );
    if (!booking) { await db.query('ROLLBACK'); return res.status(404).json({ error: 'Completed booking not found' }); }

    const { rows: [review] } = await db.query(
      `INSERT INTO reviews (booking_id, client_id, provider_id, rating, comment)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [booking.id, req.user.id, booking.provider_id, rating, comment]
    );

    // Recompute provider rating
    await db.query(
      `UPDATE provider_profiles
       SET rating = (SELECT ROUND(AVG(rating)::numeric, 2) FROM reviews WHERE provider_id=$1),
           review_count = (SELECT COUNT(*) FROM reviews WHERE provider_id=$1)
       WHERE user_id=$1`,
      [booking.provider_id]
    );

    await db.query('COMMIT');
    res.status(201).json(review);
  } catch (err) {
    await db.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    db.release();
  }
});

module.exports = router;
