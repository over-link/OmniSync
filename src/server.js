/**
 * server.js
 * Main Express entry point. Sessions are now stored in Postgres
 * (connect-pg-simple) instead of the default in-memory store, so login
 * state survives restarts and works across multiple server instances.
 */
require('dotenv').config();
require('./services/httpRetry').install();
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const cookieParser = require('cookie-parser');
const path = require('path');

const pool = require('./db/pool');
const authRoutes = require('./routes/auth').router;
const mainRoutes = require('./routes/index');
const teamRoutes = require('./routes/team');
const { startPolling } = require('./services/pollService');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1); // needed for secure cookies behind Render/Railway's proxy

app.use(cookieParser());
app.use(
  session({
    store: new pgSession({ pool, tableName: 'session', createTableIfMissing: true }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    },
  })
);

app.use((req, res, next) => {
  if (req.path === '/webhook/acc' || req.path === '/webhook/acc-v2') return next(); // needs raw handling in its own route
  express.json()(req, res, next);
});
app.use((req, res, next) => {
  if (req.path === '/webhook/acc' || req.path === '/webhook/acc-v2') return next();
  express.urlencoded({ extended: true })(req, res, next);
});

app.use(express.static(path.join(__dirname, '../public')));

app.use('/', authRoutes);
app.use('/', mainRoutes);
app.use('/', teamRoutes);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, _next) => {
  console.error('[server] Unhandled error:', err);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`\n🔄 Revizto ↔ ACC Sync running on port ${PORT}`);
  startPolling();
});

module.exports = app;
