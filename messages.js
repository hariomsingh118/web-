const router = require('express').Router();
const pool   = require('../config/db');
const { authenticate } = require('../middleware/auth');

// GET /api/messages/:bookingId — fetch all messages for a booking
router.get('/:bookingId', authenticate, async (req, res) => {
  try {
    // Verify user is part of this booking
    const { rows: [booking] } = await pool.query(
      'SELECT id FROM bookings WHERE id=$1 AND (client_id=$2 OR provider_id=$2)',
      [req.params.bookingId, req.user.id]
    );
    if (!booking) return res.status(403).json({ error: 'Access denied' });

    const { rows } = await pool.query(
      `SELECT m.id, m.body, m.sent_at, m.is_read,
              u.id AS sender_id, u.name AS sender_name, u.role AS sender_role
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       WHERE m.booking_id=$1
       ORDER BY m.sent_at ASC`,
      [req.params.bookingId]
    );

    // Mark messages as read for this user
    await pool.query(
      `UPDATE messages SET is_read=true
       WHERE booking_id=$1 AND sender_id != $2 AND is_read=false`,
      [req.params.bookingId, req.user.id]
    );

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/messages/:bookingId — send a message (REST fallback; prefer Socket.io)
router.post('/:bookingId', authenticate, async (req, res) => {
  const io = req.app.get('io');
  const { body } = req.body;
  if (!body?.trim()) return res.status(400).json({ error: 'Message body required' });

  try {
    const { rows: [booking] } = await pool.query(
      'SELECT * FROM bookings WHERE id=$1 AND (client_id=$2 OR provider_id=$2)',
      [req.params.bookingId, req.user.id]
    );
    if (!booking) return res.status(403).json({ error: 'Access denied' });

    const { rows: [msg] } = await pool.query(
      `INSERT INTO messages (booking_id, sender_id, body)
       VALUES ($1,$2,$3) RETURNING *`,
      [req.params.bookingId, req.user.id, body.trim()]
    );

    // Real-time delivery to the booking room
    const msgPayload = { ...msg, sender_name: req.user.name, sender_role: req.user.role };
    io.to(`booking:${req.params.bookingId}`).emit('new_message', msgPayload);

    // Notify the other party
    const recipientId = req.user.id === booking.client_id ? booking.provider_id : booking.client_id;
    io.to(`user:${recipientId}`).emit('notification', {
      type: 'new_message',
      title: `New message from ${req.user.name}`,
      body: body.trim().slice(0, 80),
      bookingId: booking.id,
      createdAt: new Date(),
    });

    res.status(201).json(msgPayload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/messages/conversations/list — all conversations for logged-in user
router.get('/conversations/list', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (b.id)
         b.id AS booking_id, b.status,
         m.body AS last_message, m.sent_at,
         CASE WHEN b.client_id=$1 THEN p.name ELSE c.name END AS other_party,
         CASE WHEN b.client_id=$1 THEN p.id   ELSE c.id   END AS other_party_id,
         (SELECT COUNT(*) FROM messages mm
          WHERE mm.booking_id=b.id AND mm.sender_id!=$1 AND mm.is_read=false) AS unread_count
       FROM bookings b
       JOIN users c ON c.id = b.client_id
       JOIN users p ON p.id = b.provider_id
       LEFT JOIN messages m ON m.booking_id = b.id
       WHERE (b.client_id=$1 OR b.provider_id=$1) AND b.status != 'cancelled'
       ORDER BY b.id, m.sent_at DESC NULLS LAST`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
