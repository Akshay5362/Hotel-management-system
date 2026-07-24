const fs = require('fs');

let code = fs.readFileSync('c:/Users/akshu/OneDrive/Desktop/hotel/src/components/Toolbar.jsx', 'utf8');

if (!code.includes('activeModal')) {
  code = code.replace('requestCount\n', 'requestCount,\n  activeModal\n');
}

// Replace all occurrences of data-tooltip="something"
// with {...(activeModal ? {} : { 'data-tooltip': "something" })}
code = code.replace(/data-tooltip="([^"]+)"/g, (match, p1) => {
  return `{...(activeModal ? {} : { 'data-tooltip': "${p1}" })}`;
});

fs.writeFileSync('c:/Users/akshu/OneDrive/Desktop/hotel/src/components/Toolbar.jsx', code, 'utf8');
