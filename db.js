const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5433', 10),
  user: process.env.DB_USER || 'govflow_user',
  password: process.env.DB_PASSWORD || 'govflow_password',
  database: process.env.DB_DATABASE || 'govflow_db',
});

// Test connection
pool.on('connect', () => {
  console.log('PostgreSQL database pool connected.');
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle database client', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
