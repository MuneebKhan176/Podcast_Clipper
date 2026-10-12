'use strict';

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const config = require('./config/env');
const authRoutes = require('./routes/authRoutes');
const { requestGuard } = require('./middleware/requestGuard');
const { notFound, errorHandler } = require('./middleware/errorHandler');

const app = express();

app.disable('x-powered-by');
if (config.trustProxy > 0) app.set('trust proxy', config.trustProxy);

// Exact frontend origin only (never "*", which browsers refuse together with credentials).
app.use(
  cors({
    origin: config.frontendOrigin,
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);
app.use(requestGuard);
app.use(express.json({ limit: '10kb' }));
app.use(cookieParser());

app.get('/api/health', (req, res) => res.json({ success: true, message: 'OK', data: null }));
app.use('/api/auth', authRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
