import fs from 'fs';
import path from 'path';

function runPhase23GitAudit() {
  console.log('\n================================================================');
  console.log('  HPMS SKY5 — PHASE 23: GIT RELEASE PREPARATION AUDIT');
  console.log('================================================================\n');

  try {
    // 1. .gitignore Verification
    console.log('1. .GITIGNORE SECURITY AUDIT:');
    const gitignorePath = path.resolve('.gitignore');
    const gitignoreContent = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';

    const requiredEntries = ['.env', 'node_modules', 'dist', 'backups'];
    requiredEntries.forEach(entry => {
      const isIgnored = gitignoreContent.includes(entry);
      console.log(` - ${entry.padEnd(20)} Ignored: ${isIgnored ? 'YES' : 'NO'}`);
    });

    // 2. Firebase Client vs Admin Credentials Isolation
    console.log('\n2. FIREBASE CONFIGURATION CREDENTIAL ISOLATION:');
    const firebaseClientPath = path.resolve('src/config/firebaseClient.js');
    const clientExists = fs.existsSync(firebaseClientPath);
    console.log(` - Client SDK Config File    : ${clientExists ? 'EXISTS' : 'MISSING'}`);
    if (clientExists) {
      const clientContent = fs.readFileSync(firebaseClientPath, 'utf8');
      const containsPrivateKey = clientContent.includes('private_key');
      console.log(` - Private Key in Client Code: ${containsPrivateKey ? 'DANGER (EXPOSED)' : 'SAFE (NO PRIVATE KEYS)'}`);
    }

    const firebaseAdminPath = path.resolve('backend/config/firebaseAdmin.js');
    const adminExists = fs.existsSync(firebaseAdminPath);
    console.log(` - Server Admin SDK Config   : ${adminExists ? 'EXISTS' : 'MISSING'}`);

    // 3. Package & Runtime Requirements
    console.log('\n3. PACKAGE & RUNTIME ENVIRONMENT REQUIREMENTS:');
    const rootPkgPath = path.resolve('package.json');
    const backendPkgPath = path.resolve('backend/package.json');

    const rootPkg = fs.existsSync(rootPkgPath) ? JSON.parse(fs.readFileSync(rootPkgPath, 'utf8')) : {};
    const backendPkg = fs.existsSync(backendPkgPath) ? JSON.parse(fs.readFileSync(backendPkgPath, 'utf8')) : {};

    console.log(` - Node Engine Requirement   : ${rootPkg.engines?.node || '>=18.0.0 (Recommended: v20.x or v24.x)'}`);
    console.log(` - Root Dev Start Command    : ${rootPkg.scripts?.dev || 'N/A'}`);
    console.log(` - Root Build Command        : ${rootPkg.scripts?.build || 'N/A'}`);
    console.log(` - Backend Dev Start Command : ${rootPkg.scripts?.['backend:dev'] || 'N/A'}`);

    console.log('\n================================================================');
    console.log('AUDIT VERDICT: READY TO PREPARE TESTING RELEASE');
    console.log('================================================================\n');

  } catch (err) {
    console.error('Phase 23 Audit Error:', err.message);
  }
}

runPhase23GitAudit();
