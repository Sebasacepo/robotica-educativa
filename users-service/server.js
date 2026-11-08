'use strict';
// Servicio de usuarios: registro, inicio de sesión, perfil y cierre de sesión.
const express = require('express');
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const PORT = Number(process.env.PORT || 8080);
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const DB = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  // MySQL flexible de Azure exige TLS: define DB_SSL=true para activarlo.
  ...(process.env.DB_SSL === 'true' ? { ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: false } } : {}),
};
const DB_NAME = process.env.DB_NAME || 'users_db';
// Administrador de demostración. Cambia estos valores con variables de entorno.
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@robotica.local').toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin1234!';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
let pool;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connectWithRetry() {
  for (let i = 1; i <= 30; i += 1) {
    try {
      const c = await mysql.createConnection(DB);
      await c.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4`);
      await c.end();
      return mysql.createPool({ ...DB, database: DB_NAME, waitForConnections: true, connectionLimit: 10 });
    } catch (e) {
      console.log(`Esperando la base de datos (${i}/30): ${e.code || e.message}`);
      await sleep(2000);
    }
  }
  throw new Error('No se pudo conectar a la base de datos');
}

async function init() {
  pool = await connectWithRetry();
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(150) NOT NULL UNIQUE,
    password_hash VARCHAR(100) NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'customer',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  ) CHARACTER SET utf8mb4`);
  const [rows] = await pool.query('SELECT id FROM users WHERE email = ?', [ADMIN_EMAIL]);
  if (!rows.length) {
    const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    await pool.query('INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,?)', ['Administrador', ADMIN_EMAIL, hash, 'admin']);
    console.log(`Administrador de demostración creado: ${ADMIN_EMAIL}`);
  }
}

const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role });
const sign = (u) => jwt.sign({ sub: u.id, role: u.role, name: u.name }, JWT_SECRET, { expiresIn: '8h' });

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Debes iniciar sesión' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch (_) {
    return res.status(401).json({ error: 'Sesión inválida o vencida' });
  }
}

const app = express();
app.use(express.json());

app.get('/api/users/health', (_req, res) => res.json({ status: 'ok', service: 'users' }));

app.post('/api/users/register', async (req, res, next) => {
  try {
    const name = String((req.body || {}).name || '').trim();
    const email = String((req.body || {}).email || '').trim().toLowerCase();
    const password = String((req.body || {}).password || '');
    if (!name || name.length > 100) return res.status(400).json({ error: 'El nombre es obligatorio' });
    if (!EMAIL_RE.test(email) || email.length > 150) return res.status(400).json({ error: 'Correo inválido' });
    if (password.length < 8 || password.length > 72) return res.status(400).json({ error: 'La contraseña debe tener entre 8 y 72 caracteres' });
    const hash = await bcrypt.hash(password, 10);
    try {
      const [r] = await pool.query('INSERT INTO users (name, email, password_hash) VALUES (?,?,?)', [name, email, hash]);
      const user = { id: r.insertId, name, email, role: 'customer' };
      return res.status(201).json({ token: sign(user), user: publicUser(user) });
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Ese correo ya está registrado' });
      throw e;
    }
  } catch (e) { return next(e); }
});

app.post('/api/users/login', async (req, res, next) => {
  try {
    const email = String((req.body || {}).email || '').trim().toLowerCase();
    const password = String((req.body || {}).password || '');
    const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
    const u = rows[0];
    const ok = u && (await bcrypt.compare(password, u.password_hash));
    if (!ok) return res.status(401).json({ error: 'Correo o contraseña incorrectos' });
    return res.json({ token: sign(u), user: publicUser(u) });
  } catch (e) { return next(e); }
});

// El token es sin estado: cerrar sesión consiste en descartarlo en el cliente.
app.post('/api/users/logout', auth, (_req, res) => res.status(204).end());

app.get('/api/users/me', auth, async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [req.user.sub]);
    if (!rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    return res.json(publicUser(rows[0]));
  } catch (e) { return next(e); }
});

app.put('/api/users/me', auth, async (req, res, next) => {
  try {
    const name = String((req.body || {}).name || '').trim();
    const password = (req.body || {}).password;
    if (!name || name.length > 100) return res.status(400).json({ error: 'El nombre es obligatorio' });
    if (password !== undefined && password !== '') {
      if (String(password).length < 8 || String(password).length > 72) return res.status(400).json({ error: 'La contraseña debe tener entre 8 y 72 caracteres' });
      const hash = await bcrypt.hash(String(password), 10);
      await pool.query('UPDATE users SET name = ?, password_hash = ? WHERE id = ?', [name, hash, req.user.sub]);
    } else {
      await pool.query('UPDATE users SET name = ? WHERE id = ?', [name, req.user.sub]);
    }
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [req.user.sub]);
    return res.json({ token: sign(rows[0]), user: publicUser(rows[0]) });
  } catch (e) { return next(e); }
});

app.use((_req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

init()
  .then(() => app.listen(PORT, () => console.log(`users-service escuchando en el puerto ${PORT}`)))
  .catch((e) => { console.error(e); process.exit(1); });
