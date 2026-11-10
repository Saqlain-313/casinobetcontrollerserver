import bodyParser from 'body-parser';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import http from 'http';
import morgan from 'morgan';
import path from 'path';
import { fileURLToPath } from 'url';
import dns from 'dns';

import connectDB from './config/db.js';

import { cronJobGame1p } from './controllers/cronJobs.js';

import casinobetRoutes from './routes/casinobetRoutes.js';

import { setupWebSocket } from './socket/bettingSocket.js';
import { connectRedis } from './config/redis.js';

// Environment
dotenv.config();

// DNS
dns.setServers(['1.1.1.1', '8.8.8.8']);

const app = express();
const server = http.createServer(app);

const APP_TYPE = process.env.APP_TYPE || 'dashboard';

// Middleware
app.use(
  cors({
    origin: [
      'http://localhost:5173',
      'http://localhost:5174',
      'http://localhost:5175',
      'http://localhost:5176',
      'https://reddy-777.site',
      'https://www.reddy-777.site',
      'https://dashboard.reddy-777.site',
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

app.use(express.json());
app.use(bodyParser.json());
app.use(cookieParser());

app.set('trust proxy', true);

app.use(
  morgan('dev', {
    skip: (req, res) =>
      req.method === 'GET' &&
      req.path === '/api/casino-data' &&
      res.statusCode < 400,
  })
);

// Casino Bet Routes ONLY
app.use('/api', casinobetRoutes);

// Static files
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (APP_TYPE === 'dashboard') {
  app.use(express.static(path.join(__dirname, '../dashboard/dist')));

  app.get('*', (req, res) => {
    res.sendFile(
      path.join(__dirname, '../dashboard/dist/index.html')
    );
  });
} else {
  app.use(express.static(path.join(__dirname, '../client/dist')));

  app.get('*', (req, res) => {
    res.sendFile(
      path.join(__dirname, '../client/dist/index.html')
    );
  });
}

// Port configuration
const isLocal = process.env.NODE_ENV !== 'production';

const PORT = isLocal
  ? process.env.PORT || (APP_TYPE === 'dashboard' ? 8101 : 8100)
  : APP_TYPE === 'dashboard'
    ? process.env.DASHBOARD_PORT
    : process.env.CLIENT_PORT;

// Start server
const startServer = async () => {
  try {
    // 1. MongoDB
    console.log('[DB] Connecting MongoDB...');
    await connectDB();
    console.log('[DB] MongoDB connected');

    // 2. Redis
    console.log('[REDIS] Connecting Redis...');
    await connectRedis();
    console.log('[REDIS] Redis connected successfully');

    // 3. WebSocket
    setupWebSocket(server);

    // 4. Cron jobs
    if (APP_TYPE !== 'dashboard') {
      cronJobGame1p();
      console.log('[CRON] Settlement crons started (client process)');
    } else {
      console.log('[CRON] Settlement crons SKIPPED (dashboard process)');
    }

    // 5. HTTP Server
    server.listen(PORT, () => {
      console.log(
        `${APP_TYPE} server running on port ${PORT} (${isLocal ? 'local' : 'prod'})`
      );
    });

  } catch (error) {
    console.error('[SERVER STARTUP ERROR]', error);
    process.exit(1);
  }
};

startServer();