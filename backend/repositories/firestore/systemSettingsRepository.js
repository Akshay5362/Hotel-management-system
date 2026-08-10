import { db } from '../../config/firebaseAdmin.js';

export async function getAllSystemSettingsFirestore() {
  const snap = await db.collection('system_settings').get();
  const settings = {};
  snap.forEach(doc => {
    const d = doc.data();
    settings[d.key_name] = d.value_val;
  });
  return settings;
}

export async function getSystemSettingByKeyFirestore(keyName) {
  const docSnap = await db.collection('system_settings').doc(`setting_${keyName}`).get();
  if (!docSnap.exists) return null;
  return docSnap.data().value_val;
}
