import { isFirebaseConfigured, db } from '../config/firebaseAdmin.js';

async function runTest() {
  console.log('\n=== Firebase Connectivity Test ===');

  if (!isFirebaseConfigured || !db) {
    console.log('STATUS: UNCONFIGURED');
    console.log('Reason: Firebase environment variables (FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY) are not populated in backend/.env');
    console.log('Info: Firebase features remain in optional standby mode. HPMS is operating normally on MySQL.');
    console.log('=================================\n');
    process.exit(0);
  }

  console.log(`Configured Project ID: ${process.env.FIREBASE_PROJECT_ID}`);
  console.log('Attempting read-only connection check to Firestore...');

  try {
    // Read-only listCollections call to test connection without writing data
    const collections = await db.listCollections();
    console.log('STATUS: SUCCESS');
    console.log(`Firestore connection verified successfully. Root collections count: ${collections.length}`);
    if (collections.length > 0) {
      console.log('Existing Collections:', collections.map(c => c.id).join(', '));
    }
    console.log('=================================\n');
    process.exit(0);
  } catch (error) {
    console.error('STATUS: FAILED');
    console.error('Connection Error:', error.message);
    console.log('=================================\n');
    process.exit(1);
  }
}

runTest();
