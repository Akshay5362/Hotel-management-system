import { db } from '../../config/firebaseAdmin.js';

export async function getAllStaffFirestore() {
  const snap = await db.collection('staff').get();
  const staffList = [];
  snap.forEach(doc => {
    const d = doc.data();
    staffList.push({
      id: d.mysql_staff_id || Number(doc.id.replace('staff_', '')),
      username: d.username,
      full_name: d.full_name,
      email: d.email,
      phone: d.phone,
      role: d.role,
      department: d.department,
      shift: d.shift,
      status: d.status,
      user_uid: d.user_uid || null
    });
  });
  return staffList.sort((a, b) => a.id - b.id);
}
