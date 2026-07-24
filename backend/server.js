import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import apiRouter from './routes/api.js';

const app = express();
const server = createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.set('io', io);

const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Mount the API Router
app.use('/api', apiRouter);

// Serve uploaded documents statically (Admin verification UI needs this)
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use('/guest-documents', express.static(path.join(__dirname, 'guest-documents')));

// Basic root checker
app.get('/', (req, res) => {
  res.send('Webline PMS Plus Backend API is running!');
});

// Health check endpoint — used by wait-on in electron:dev workflow
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'hotel-pms-backend', port: PORT });
});


// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Global Error Handler:', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

server.listen(PORT, () => {
  console.log(`Backend server is running on http://localhost:${PORT}`);
});
