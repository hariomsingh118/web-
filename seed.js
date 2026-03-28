require('dotenv').config();
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const pool = require('../config/db');

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── Users ──────────────────────────────────────────────
    const hash = await bcrypt.hash('password123', 10);

    const providerIds = [uuid(), uuid(), uuid()];
    const clientIds   = [uuid(), uuid()];

    const users = [
      // Providers
      [providerIds[0], 'Ravi Sharma',  'ravi@booksync.dev',  hash, 'provider'],
      [providerIds[1], 'Nisha Patel',  'nisha@booksync.dev', hash, 'provider'],
      [providerIds[2], 'Amir Khan',    'amir@booksync.dev',  hash, 'provider'],
      // Clients
      [clientIds[0],  'Meera Singh',  'meera@booksync.dev', hash, 'client'],
      [clientIds[1],  'Arjun Kumar',  'arjun@booksync.dev', hash, 'client'],
    ];

    for (const [id, name, email, pw, role] of users) {
      await client.query(
        `INSERT INTO users (id, name, email, password_hash, role)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (email) DO NOTHING`,
        [id, name, email, pw, role]
      );
    }

    // ── Provider Profiles ──────────────────────────────────
    const profiles = [
      [providerIds[0], 'Haircare',    'Jaipur, Rajasthan', 8, 4.90, 128],
      [providerIds[1], 'Skincare',    'Jaipur, Rajasthan', 5, 4.80, 94],
      [providerIds[2], 'Physiotherapy','Jaipur, Rajasthan', 10, 4.70, 67],
    ];
    for (const [uid, cat, loc, exp, rat, rev] of profiles) {
      await client.query(
        `INSERT INTO provider_profiles
           (user_id, category, location, experience_yrs, rating, review_count)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [uid, cat, loc, exp, rat, rev]
      );
    }

    // ── Services ───────────────────────────────────────────
    const svcIds = [uuid(), uuid(), uuid(), uuid()];
    const services = [
      [svcIds[0], providerIds[0], 'Standard Haircut',       500,  30],
      [svcIds[1], providerIds[0], 'Beard Trim & Shape',     300,  20],
      [svcIds[2], providerIds[1], 'Classic Facial',        1200,  60],
      [svcIds[3], providerIds[2], 'Physiotherapy Session',  800,  45],
    ];
    for (const [id, pid, name, price, dur] of services) {
      await client.query(
        `INSERT INTO services (id, provider_id, name, price, duration_min)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [id, pid, name, price, dur]
      );
    }

    // ── Time Slots (next 7 days) ────────────────────────────
    const slotTimes = ['09:00','10:00','11:00','14:00','15:00','16:00'];
    const today = new Date();

    for (let day = 0; day < 7; day++) {
      const d = new Date(today);
      d.setDate(today.getDate() + day);
      const dateStr = d.toISOString().split('T')[0];

      for (const pid of providerIds) {
        for (const t of slotTimes) {
          const [h, m] = t.split(':').map(Number);
          const endH = h + 1;
          await client.query(
            `INSERT INTO time_slots (id, provider_id, slot_date, start_time, end_time)
             VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
            [uuid(), pid, dateStr, t + ':00', `${endH}:${m === 0 ? '00' : m}:00`]
          );
        }
      }
    }

    // ── Sample Booking + Messages ───────────────────────────
    const slotRow = await client.query(
      `SELECT id FROM time_slots WHERE provider_id=$1 AND status='available' LIMIT 1`,
      [providerIds[0]]
    );
    if (slotRow.rows.length) {
      const slotId    = slotRow.rows[0].id;
      const bookingId = uuid();
      await client.query(
        `INSERT INTO bookings
           (id, client_id, provider_id, service_id, slot_id, status, total_price)
         VALUES ($1,$2,$3,$4,$5,'confirmed',$6)`,
        [bookingId, clientIds[0], providerIds[0], svcIds[0], slotId, 500]
      );
      await client.query(
        `UPDATE time_slots SET status='booked' WHERE id=$1`, [slotId]
      );
      const msgs = [
        [clientIds[0],  'Hi! I need a haircut and beard trim.'],
        [providerIds[0],'Of course! Slot is confirmed for you.'],
        [clientIds[0],  'Thank you! See you then.'],
      ];
      for (const [sid, body] of msgs) {
        await client.query(
          `INSERT INTO messages (id, booking_id, sender_id, body) VALUES ($1,$2,$3,$4)`,
          [uuid(), bookingId, sid, body]
        );
      }
    }

    await client.query('COMMIT');
    console.log('✅  Seed complete — demo accounts created');
    console.log('   Provider: ravi@booksync.dev  / password123');
    console.log('   Client:   meera@booksync.dev / password123');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌  Seed failed:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
