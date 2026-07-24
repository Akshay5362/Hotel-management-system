import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pool from '../../db.js';
import { runDayEnd } from '../../controllers/auditController.js';

describe('Functional Test - Day End Audit Rollover', () => {
  let connection;
  let originalDate;

  // Establish db session context
  beforeAll(async () => {
    connection = await pool.getConnection();
  });

  // Rollback all actions on completion
  afterAll(async () => {
    if (connection) {
      if (originalDate) {
        // Restore system date to keep DB clean
        await connection.query(
          "UPDATE system_settings SET value_val = ? WHERE key_name = 'system_date'",
          [originalDate]
        );
      }
      connection.release();
    }
  });

  it('should run day-end rollover logic successfully', async () => {
    // 1. Fetch current business date from DB
    const [settingsRows] = await connection.query(
      `SELECT value_val FROM system_settings WHERE key_name = 'system_date'`
    );
    const currentDate = settingsRows[0]?.value_val;
    expect(currentDate).toBeDefined();
    originalDate = currentDate;

    // Derive next business date dynamically (e.g. 24-Jul-2026 -> 25-Jul-2026)
    const parts = currentDate.split('-');
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const monthIdx = months.indexOf(parts[1]);
    const dateObj = new Date(parseInt(parts[2], 10), monthIdx, parseInt(parts[0], 10));
    dateObj.setDate(dateObj.getDate() + 1);
    const nextDay = String(dateObj.getDate()).padStart(2, '0');
    const nextMonth = months[dateObj.getMonth()];
    const nextYear = dateObj.getFullYear();
    const nextDateStr = `${nextDay}-${nextMonth}-${nextYear}`;

    // 2. Prepare Mock Express request and response objects
    const req = {
      body: { nextDate: nextDateStr },
      user: { id: 1, type: 'admin', fullName: 'Test Administrator' }
    };
    
    let statusCode = 200;
    let jsonResponse = null;

    const res = {
      status: (code) => {
        statusCode = code;
        return res;
      },
      json: (data) => {
        jsonResponse = data;
        return res;
      }
    };

    // 3. Invoke the dayEnd controller directly (functional unit integration test)
    await runDayEnd(req, res);

    // 4. Assert response was 200 OK and reported success
    expect(statusCode).toBe(200);
    expect(jsonResponse).toBeDefined();
    expect(jsonResponse.message).toContain('Night audit complete');

    // 5. Fetch updated business date and verify it has changed
    const [newSettingsRows] = await connection.query(
      `SELECT value_val FROM system_settings WHERE key_name = 'system_date'`
    );
    const newDate = newSettingsRows[0]?.value_val;
    expect(newDate).not.toBe(currentDate);
    console.log(`[Functional Test] Rolled over date from ${currentDate} to ${newDate}`);
  });
});
