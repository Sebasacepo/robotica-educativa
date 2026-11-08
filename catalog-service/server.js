'use strict';
// Servicio de catálogo: productos, niveles, búsqueda, filtros y gestión (admin).
const express = require('express');
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');

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
const DB_NAME = process.env.DB_NAME || 'catalog_db';

const LEVELS = [
  { id: 'principiante', name: 'Principiante', description: 'Primeros pasos: armar y entender circuitos básicos.' },
  { id: 'intermedio', name: 'Intermedio', description: 'Sensores, motores y programación inicial.' },
  { id: 'avanzado', name: 'Avanzado', description: 'Proyectos complejos con visión, IoT y control avanzado.' },
];
const LEVEL_IDS = LEVELS.map((l) => l.id);

// Datos de demostración: reemplázalos por los productos reales del negocio.
const SEED = [
  ['Robot Armable Solar', 'Arma un robot que se mueve con energía solar y descubre cómo funcionan los motores.', 'principiante', 'Mecánica', 75000, '8-10', ['Motor solar', 'Chasis plástico', 'Engranajes', 'Manual ilustrado'], '🤖'],
  ['Circuitos Divertidos', 'Enciende luces y activa sonidos construyendo tus primeros circuitos.', 'principiante', 'Electrónica', 95000, '8-10', ['Protoboard', 'LEDs', 'Resistencias', 'Pulsadores', 'Portapilas', 'Guía de 10 retos'], '🔌'],
  ['Robot Seguidor de Luz', 'Un robot que persigue la luz de una linterna usando sensores.', 'principiante', 'Electrónica', 120000, '9-12', ['Sensores de luz', 'Motores DC', 'Chasis', 'Portapilas', 'Guía de montaje'], '💡'],
  ['Robot Esquiva Obstáculos', 'Programa un robot que detecta paredes y cambia de rumbo por sí solo.', 'intermedio', 'Programación', 210000, '11-14', ['Placa compatible con Arduino', 'Sensor ultrasónico', '2 motores DC', 'Driver de motores', 'Cable USB'], '🚗'],
  ['Brazo Robótico Educativo', 'Controla un brazo de cuatro articulaciones y aprende de servomotores.', 'intermedio', 'Mecánica', 260000, '11-14', ['4 servomotores', 'Estructura acrílica', 'Placa controladora', 'Guía de programación'], '🦾'],
  ['Estación Meteorológica', 'Mide temperatura y humedad y muéstralas en una pantalla.', 'intermedio', 'Electrónica', 185000, '12-15', ['Sensor de temperatura y humedad', 'Pantalla LCD', 'Placa compatible con Arduino', 'Cables'], '🌦️'],
  ['Robot Móvil con Visión', 'Un robot con cámara que reconoce colores y objetos.', 'avanzado', 'Programación', 480000, '14-16', ['Mini computador', 'Cámara', 'Motores con encoder', 'Batería recargable'], '👁️'],
  ['Robot Hexápodo', 'Un robot de seis patas que camina con 18 servomotores.', 'avanzado', 'Mecánica', 520000, '14-16', ['18 servomotores', 'Controlador de servos', 'Estructura', 'Batería recargable'], '🕷️'],
  ['Kit IoT Casa Inteligente', 'Controla luces y sensores de una maqueta de casa desde el celular.', 'avanzado', 'Programación', 390000, '13-16', ['Placa con Wi-Fi', 'Sensores', 'Relés', 'Guía de proyectos'], '🏠'],
];

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
  await pool.query(`CREATE TABLE IF NOT EXISTS products (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    description TEXT,
    level VARCHAR(20) NOT NULL,
    category VARCHAR(50) NOT NULL DEFAULT 'General',
    price DECIMAL(10,2) NOT NULL,
    age_range VARCHAR(20) DEFAULT '',
    components TEXT,
    image VARCHAR(16) DEFAULT '🤖',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  ) CHARACTER SET utf8mb4`);
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM products');
  if (n === 0) {
    for (const [name, description, level, category, price, age, comps, image] of SEED) {
      await pool.query(
        'INSERT INTO products (name, description, level, category, price, age_range, components, image) VALUES (?,?,?,?,?,?,?,?)',
        [name, description, level, category, price, age, JSON.stringify(comps), image],
      );
    }
    console.log('Productos de demostración cargados');
  }
}

function toProduct(r) {
  let components = [];
  try { components = JSON.parse(r.components || '[]'); } catch (_) { components = []; }
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    level: r.level,
    category: r.category,
    price: Number(r.price),
    ageRange: r.age_range,
    components,
    image: r.image,
  };
}

function requireAdmin(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Debes iniciar sesión' });
  try {
    const p = jwt.verify(token, JWT_SECRET);
    if (p.role !== 'admin') return res.status(403).json({ error: 'Solo administradores' });
    req.user = p;
    return next();
  } catch (_) {
    return res.status(401).json({ error: 'Sesión inválida o vencida' });
  }
}

function validateProduct(b) {
  const name = String(b.name || '').trim();
  const level = String(b.level || '');
  const price = Number(b.price);
  if (!name || name.length > 120) return { error: 'El nombre es obligatorio (máximo 120 caracteres)' };
  if (!LEVEL_IDS.includes(level)) return { error: 'Nivel inválido' };
  if (!Number.isFinite(price) || price <= 0) return { error: 'El precio debe ser mayor a 0' };
  const components = Array.isArray(b.components)
    ? b.components.map((c) => String(c).trim()).filter(Boolean).slice(0, 30)
    : [];
  return {
    value: {
      name,
      description: String(b.description || '').slice(0, 2000),
      level,
      category: String(b.category || 'General').slice(0, 50),
      price,
      ageRange: String(b.ageRange || '').slice(0, 20),
      components,
      image: String(b.image || '🤖').slice(0, 8),
    },
  };
}

const app = express();
app.use(express.json());

app.get('/api/catalog/health', (_req, res) => res.json({ status: 'ok', service: 'catalog' }));
app.get('/api/catalog/levels', (_req, res) => res.json(LEVELS));

app.get('/api/catalog/categories', async (_req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT DISTINCT category FROM products ORDER BY category');
    res.json(rows.map((r) => r.category));
  } catch (e) { next(e); }
});

app.get('/api/catalog/products', async (req, res, next) => {
  try {
    const where = [];
    const params = [];
    if (req.query.level) {
      if (!LEVEL_IDS.includes(req.query.level)) return res.status(400).json({ error: 'Nivel inválido' });
      where.push('level = ?');
      params.push(req.query.level);
    }
    if (req.query.category) { where.push('category = ?'); params.push(String(req.query.category)); }
    if (req.query.q) {
      where.push('(name LIKE ? OR description LIKE ?)');
      const like = `%${String(req.query.q).slice(0, 80)}%`;
      params.push(like, like);
    }
    const sql = `SELECT * FROM products ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY FIELD(level,'principiante','intermedio','avanzado'), price`;
    const [rows] = await pool.query(sql, params);
    res.json(rows.map(toProduct));
  } catch (e) { next(e); }
});

app.get('/api/catalog/products/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Id inválido' });
    const [rows] = await pool.query('SELECT * FROM products WHERE id = ?', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Producto no encontrado' });
    return res.json(toProduct(rows[0]));
  } catch (e) { return next(e); }
});

app.post('/api/catalog/admin/products', requireAdmin, async (req, res, next) => {
  try {
    const v = validateProduct(req.body || {});
    if (v.error) return res.status(400).json({ error: v.error });
    const p = v.value;
    const [r] = await pool.query(
      'INSERT INTO products (name, description, level, category, price, age_range, components, image) VALUES (?,?,?,?,?,?,?,?)',
      [p.name, p.description, p.level, p.category, p.price, p.ageRange, JSON.stringify(p.components), p.image],
    );
    const [rows] = await pool.query('SELECT * FROM products WHERE id = ?', [r.insertId]);
    return res.status(201).json(toProduct(rows[0]));
  } catch (e) { return next(e); }
});

app.put('/api/catalog/admin/products/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Id inválido' });
    const v = validateProduct(req.body || {});
    if (v.error) return res.status(400).json({ error: v.error });
    const p = v.value;
    const [r] = await pool.query(
      'UPDATE products SET name=?, description=?, level=?, category=?, price=?, age_range=?, components=?, image=? WHERE id=?',
      [p.name, p.description, p.level, p.category, p.price, p.ageRange, JSON.stringify(p.components), p.image, id],
    );
    if (!r.affectedRows) return res.status(404).json({ error: 'Producto no encontrado' });
    const [rows] = await pool.query('SELECT * FROM products WHERE id = ?', [id]);
    return res.json(toProduct(rows[0]));
  } catch (e) { return next(e); }
});

app.delete('/api/catalog/admin/products/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Id inválido' });
    const [r] = await pool.query('DELETE FROM products WHERE id = ?', [id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'Producto no encontrado' });
    return res.status(204).end();
  } catch (e) { return next(e); }
});

app.use((_req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

init()
  .then(() => app.listen(PORT, () => console.log(`catalog-service escuchando en el puerto ${PORT}`)))
  .catch((e) => { console.error(e); process.exit(1); });
