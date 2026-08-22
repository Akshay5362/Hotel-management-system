import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import apiRouter from './routes/api.js';

const app = express();
const server = createServer(app);

const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:5000',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5000',
  'https://hotel-management-system-lac-xi.vercel.app'
];

function isOriginAllowed(origin) {
  if (!origin) return true;
  if (allowedOrigins.includes(origin)) return true;
  if (/\.vercel\.app$/.test(origin)) return true;
  if (/\.ngrok-free\.dev$/.test(origin) || /\.ngrok\.io$/.test(origin)) return true;
  return false;
}

// Global header middleware for ngrok bypass
app.use((req, res, next) => {
  res.setHeader('ngrok-skip-browser-warning', 'true');
  next();
});

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || isOriginAllowed(origin)) {
      callback(null, origin || true);
    } else {
      callback(null, false);
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning', 'X-Requested-With', 'Accept'],
  optionsSuccessStatus: 204
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin || isOriginAllowed(origin)) callback(null, origin || true);
      else callback(null, false);
    },
    credentials: true
  }
});
app.set('io', io);

const PORT = process.env.PORT || 5000;


app.use(express.json());


// Mount the API Router
app.use('/api', apiRouter);

// Serve uploaded documents statically (Admin verification UI needs this)
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use('/guest-documents', express.static(path.join(__dirname, 'guest-documents')));
app.use('/inventory-photos', express.static(path.join(__dirname, 'inventory-photos')));

// Basic root checker
app.get('/', (req, res) => {
  res.send('Webline PMS Plus Backend API is running!');
});

import { isFirestoreServicesEnabled, isFirestoreReadsEnabled } from './config/featureFlags.js';
import { getServiceReadMetrics } from './services/serviceStrategy.js';
import { readBudgetMonitor } from './utils/firestoreReadBudget.js';

// Health check endpoint — used by wait-on in electron:dev workflow & Docker healthcheck
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'hotel-pms-backend',
    port: PORT,
    feature_flags: {
      outbox_worker: false,
      dual_write: false,
      firestore_reads: isFirestoreReadsEnabled(),
      use_firestore_services: isFirestoreServicesEnabled()
    },
    outbox_worker: {
      enabled: false,
      running: false,
      decommissioned: true
    },
    telemetry: getServiceReadMetrics(),
    read_budget: {
      estimated_reads_today: readBudgetMonitor.estimatedReadsToday,
      safety_budget: readBudgetMonitor.SAFETY_BUDGET,
      status: readBudgetMonitor.getDiagnostics().status
    }
  });
});

// Dedicated Firestore Read Budget & Rate-Limit Diagnostics (in-memory, 0 Firestore reads)
app.get('/api/diagnostics/read-budget', (req, res) => {
  res.json({
    status: 'ok',
    diagnostics: readBudgetMonitor.getDiagnostics()
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Global Error Handler:', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend server is running on http://0.0.0.0:${PORT}`);
});

// ── Graceful Shutdown Handlers (SIGTERM / SIGINT) ───────────────────────────
// Ensures clean HTTP connection draining in Docker/K8s environments.
const gracefulShutdown = (signal) => {
  console.log(`[Server] ${signal} signal received. Initiating graceful shutdown...`);
  server.close(() => {
    console.log('[Server] HTTP server closed.');
    process.exit(0);
  });

  // Force exit if server hasn't closed in 10s
  setTimeout(() => {
    console.error('[Server] Forced shutdown after 10s timeout.');
    process.exit(1);
  }, 10000).unref();
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
