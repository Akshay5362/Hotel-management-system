import { db } from '../../config/firebaseAdmin.js';

export async function getAllAuditLogsFirestore() {
  const snap = await db.collection('audit_logs').get();
  const auditLogs = [];
  snap.forEach(doc => {
    const d = doc.data();
    auditLogs.push({
      id: d.mysql_audit_id || Number(doc.id.replace('audit_', '')),
      user_id: d.mysql_user_id,
      action: d.action,
      details: d.details,
      business_date: d.business_date,
      username: d.username,
      role: d.role,
      created_at: d.created_at
    });
  });
  return auditLogs.sort((a, b) => a.id - b.id);
}
