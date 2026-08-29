import pool from '../backend/db.js';

async function inspectOutboxRows() {
  console.log('\n================================================================');
  console.log('  HPMS SKY5 — READ-ONLY INSPECTION OF DUAL_WRITE_OUTBOX ROWS');
  console.log('================================================================\n');

  try {
    const [rows] = await pool.query(
      `SELECT id, event_id, event_type, aggregate_type, aggregate_id, status, attempts, available_at, processed_at, last_error, created_at, payload 
       FROM dual_write_outbox 
       ORDER BY id ASC`
    );

    console.log(`Total Rows Found: ${rows.length}\n`);

    rows.forEach((row, idx) => {
      let payloadValid = false;
      let payloadKeys = [];
      try {
        const parsed = JSON.parse(row.payload);
        payloadValid = true;
        payloadKeys = Object.keys(parsed);
      } catch (err) {
        payloadValid = false;
      }

      console.log(`--- Row ${idx + 1} (ID: ${row.id}) ---`);
      console.log(` - Event ID      : ${row.event_id}`);
      console.log(` - Event Type    : ${row.event_type}`);
      console.log(` - Aggregate Type: ${row.aggregate_type}`);
      console.log(` - Aggregate ID  : ${row.aggregate_id}`);
      console.log(` - Status        : ${row.status}`);
      console.log(` - Attempts      : ${row.attempts}`);
      console.log(` - Available At  : ${row.available_at}`);
      console.log(` - Processed At  : ${row.processed_at || 'NULL'}`);
      console.log(` - Last Error    : ${row.last_error || 'NONE'}`);
      console.log(` - Created At    : ${row.created_at}`);
      console.log(` - Payload Valid : ${payloadValid ? 'YES' : 'NO'}`);
      console.log(` - Payload Keys  : [${payloadKeys.join(', ')}]\n`);
    });

    // Aggregations
    const [statusGroup] = await pool.query(`SELECT status, COUNT(*) as count FROM dual_write_outbox GROUP BY status`);
    const [eventTypeGroup] = await pool.query(`SELECT event_type, COUNT(*) as count FROM dual_write_outbox GROUP BY event_type`);
    const [aggregateGroup] = await pool.query(`SELECT aggregate_type, COUNT(*) as count FROM dual_write_outbox GROUP BY aggregate_type`);

    console.log('================================================================');
    console.log('AGGREGATION BREAKDOWN');
    console.log('================================================================');
    console.log('\nStatus Breakdown:');
    statusGroup.forEach(g => console.log(` - ${g.status.padEnd(15)}: ${g.count}`));

    console.log('\nEvent Type Breakdown:');
    eventTypeGroup.forEach(g => console.log(` - ${g.event_type.padEnd(30)}: ${g.count}`));

    console.log('\nAggregate Type Breakdown:');
    aggregateGroup.forEach(g => console.log(` - ${g.aggregate_type.padEnd(25)}: ${g.count}`));

    process.exit(0);

  } catch (err) {
    console.error('Outbox Inspection Error:', err.message);
    process.exit(1);
  }
}

inspectOutboxRows();
