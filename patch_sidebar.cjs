const fs = require('fs');
let content = fs.readFileSync('src/config/sidebarConfig.js', 'utf8');

const roles = ['ADMIN', 'RECEPTIONIST', 'CHEF', 'PANTRY_BOY', 'CLEANER'];
for (const role of roles) {
  const target = '],\\n  ' + (role === 'ADMIN' ? 'RECEPTIONIST' : role === 'CLEANER' ? '};' : roles[roles.indexOf(role) + 1]);
  // Actually, let's just do a string replace for each array end
  const regex = new RegExp('  ' + role + ': \\[[\\s\\S]*?\\],', 'g');
  content = content.replace(regex, (match) => {
    return match.replace('],', '  { label: \\'Settings\\', icon: \\'??\\', action: \\'settings\\' },\n  ],');
  });
}

fs.writeFileSync('src/config/sidebarConfig.js', content);
console.log('Sidebar config updated');
