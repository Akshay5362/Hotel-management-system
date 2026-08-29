// Use project's existing Firebase Admin init (env-based, no SA file needed)
import '../../backend/config/firebaseAdmin.js';
import { getFirestore } from 'firebase-admin/firestore';

const db = getFirestore();


const snap = await db.collection('rooms').get();
console.log(`Total docs in /rooms: ${snap.size}`);
const all = [];
snap.forEach(doc => {
  const d = doc.data();
  all.push({
    docId: doc.id,
    number: d.number,
    mysql_room_id: d.mysql_room_id,
    status: d.status,
    is_active: d.is_active,
    type: d.type,
    created_at: d.created_at,
    updated_at: d.updated_at
  });
});

all.sort((a,b) => {
  const na = parseInt(String(a.number||'').replace(/\D/g,''),10);
  const nb = parseInt(String(b.number||'').replace(/\D/g,''),10);
  return isNaN(na)||isNaN(nb) ? String(a.number||'').localeCompare(String(b.number||'')) : na - nb;
});

console.log('\n--- ALL ROOM DOCUMENTS (sorted by visible number) ---');
for (const r of all) {
  console.log(`  docId=${r.docId.padEnd(12)} | number=${String(r.number??'?').padEnd(5)} | mysql_room_id=${String(r.mysql_room_id??'null').padEnd(5)} | status=${String(r.status||'?').padEnd(10)} | is_active=${r.is_active}`);
}

// Find duplicates by visible number
const byNum = {};
for (const r of all) {
  const n = String(r.number??'');
  if (!byNum[n]) byNum[n] = [];
  byNum[n].push(r);
}
const dups = Object.entries(byNum).filter(([,v]) => v.length > 1);
if (dups.length === 0) {
  console.log('\n✅ NO DUPLICATE visible room numbers found in Firestore /rooms collection.');
} else {
  console.log('\n❌ DUPLICATE visible room numbers detected:');
  for (const [num, docs] of dups) {
    console.log(`  number="${num}" → ${docs.length} documents:`);
    docs.forEach(d => console.log(`    docId=${d.docId}, mysql_room_id=${d.mysql_room_id}, status=${d.status}, is_active=${d.is_active}, type=${d.type}`));
  }
}

// Also show doc_id vs number mapping for rooms 10-20 (the suspect range)
console.log('\n--- ROOMS 10-20 DETAIL ---');
const suspectRange = all.filter(r => { const n = parseInt(r.number,10); return n >= 10 && n <= 20; });
for (const r of suspectRange) {
  console.log(JSON.stringify(r, null, 2));
}

process.exit(0);
