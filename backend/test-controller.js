import { listGuests } from './controllers/auditController.js';

const req = {
  query: { page: '1', limit: '25', filter: 'all' }
};

const res = {
  json: (data) => console.log('JSON Output:', JSON.stringify(data).slice(0, 500)),
  status: (code) => {
    console.log('Status code:', code);
    return { json: (err) => console.log('Error JSON:', err) };
  }
};

async function run() {
  console.log('Running listGuests...');
  await listGuests(req, res);
  console.log('Done.');
  process.exit(0);
}
run();
