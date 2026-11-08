'use strict';
// Servicio de pedidos: carrito, pago simulado, historial y estado del pedido.
const express = require('express');
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');

const PORT = Number(process.env.PORT || 8080);
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const CATALOG_URL = (process.env.CATALOG_URL || 'http://localhost:8081').replace(/\/$/, '');
const DB = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  // MySQL flexible de Azure exige TLS: define DB_SSL=true para activarlo.
  ...(process.env.DB_SSL === 'true' ? { ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: false } } : {}),
};
const DB_NAME = process.env.DB_NAME || 'orders_db';

const STATUSES = ['pagado', 'preparando', 'enviado', 'entregado'];
const MAX_QTY = 20;
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
  await pool.query(`CREATE TABLE IF NOT EXISTS cart_items (
    user_id INT NOT NULL,
    product_id INT NOT NULL,
    quantity INT NOT NULL,
    PRIMARY KEY (user_id, product_id)
  ) CHARACTER SET utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS orders (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    total DECIMAL(12,2) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pagado',
    card_last4 CHAR(4) NOT NULL,
    shipping_address VARCHAR(250) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_orders_user (user_id)
  ) CHARACTER SET utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS order_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    order_id INT NOT NULL,
    product_id INT NOT NULL,
    name VARCHAR(120) NOT NULL,
    image VARCHAR(16) DEFAULT '',
    unit_price DECIMAL(10,2) NOT NULL,
    quantity INT NOT NULL,
    INDEX idx_items_order (order_id)
  ) CHARACTER SET utf8mb4`);
}

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

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo administradores' });
  return next();
}

// Consulta un producto al servicio de catálogo (precio siempre desde el servidor).
async function fetchProduct(id) {
  const r = await fetch(`${CATALOG_URL}/api/catalog/products/${id}`, { signal: AbortSignal.timeout(5000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Catálogo respondió ${r.status}`);
  return r.json();
}

async function cartDetail(userId) {
  const [rows] = await pool.query('SELECT product_id, quantity FROM cart_items WHERE user_id = ? ORDER BY product_id', [userId]);
  const items = [];
  let total = 0;
  for (const row of rows) {
    const p = await fetchProduct(row.product_id);
    if (!p) continue; // el producto fue eliminado del catálogo
    const subtotal = p.price * row.quantity;
    total += subtotal;
    items.push({ productId: p.id, name: p.name, image: p.image, price: p.price, quantity: row.quantity, subtotal });
  }
  return { items, total };
}

const app = express();
app.use(express.json());

app.get('/api/orders/health', (_req, res) => res.json({ status: 'ok', service: 'orders' }));

// ----- Carrito -----
app.get('/api/orders/cart', auth, async (req, res, next) => {
  try { res.json(await cartDetail(req.user.sub)); } catch (e) { next(e); }
});

app.post('/api/orders/cart/items', auth, async (req, res, next) => {
  try {
    const productId = Number((req.body || {}).productId);
    const quantity = Number((req.body || {}).quantity || 1);
    if (!Number.isInteger(productId) || productId < 1) return res.status(400).json({ error: 'Producto inválido' });
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY) return res.status(400).json({ error: `La cantidad debe estar entre 1 y ${MAX_QTY}` });
    const p = await fetchProduct(productId);
    if (!p) return res.status(404).json({ error: 'Producto no encontrado' });
    await pool.query(
      `INSERT INTO cart_items (user_id, product_id, quantity) VALUES (?,?,?)
       ON DUPLICATE KEY UPDATE quantity = LEAST(quantity + VALUES(quantity), ${MAX_QTY})`,
      [req.user.sub, productId, quantity],
    );
    return res.status(201).json(await cartDetail(req.user.sub));
  } catch (e) { return next(e); }
});

app.put('/api/orders/cart/items/:productId', auth, async (req, res, next) => {
  try {
    const productId = Number(req.params.productId);
    const quantity = Number((req.body || {}).quantity);
    if (!Number.isInteger(productId)) return res.status(400).json({ error: 'Producto inválido' });
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY) return res.status(400).json({ error: `La cantidad debe estar entre 1 y ${MAX_QTY}` });
    await pool.query('UPDATE cart_items SET quantity = ? WHERE user_id = ? AND product_id = ?', [quantity, req.user.sub, productId]);
    return res.json(await cartDetail(req.user.sub));
  } catch (e) { return next(e); }
});

app.delete('/api/orders/cart/items/:productId', auth, async (req, res, next) => {
  try {
    const productId = Number(req.params.productId);
    if (!Number.isInteger(productId)) return res.status(400).json({ error: 'Producto inválido' });
    await pool.query('DELETE FROM cart_items WHERE user_id = ? AND product_id = ?', [req.user.sub, productId]);
    return res.json(await cartDetail(req.user.sub));
  } catch (e) { return next(e); }
});

// ----- Pago simulado -----
// Nunca se guarda el número de la tarjeta: solo los últimos 4 dígitos.
app.post('/api/orders/checkout', auth, async (req, res, next) => {
  const conn = await pool.getConnection().catch(() => null);
  if (!conn) return next(new Error('Sin conexión a la base de datos'));
  try {
    const b = req.body || {};
    const address = String(b.address || '').trim();
    const cardNumber = String(b.cardNumber || '').replace(/[\s-]/g, '');
    const expiry = String(b.expiry || '').trim();
    const cvv = String(b.cvv || '').trim();
    if (address.length < 5 || address.length > 250) return res.status(400).json({ error: 'Escribe la dirección de envío' });
    if (!/^\d{13,19}$/.test(cardNumber)) return res.status(400).json({ error: 'Número de tarjeta inválido' });
    if (!/^(0[1-9]|1[0-2])\/\d{2}$/.test(expiry)) return res.status(400).json({ error: 'Vencimiento inválido (use MM/AA)' });
    if (!/^\d{3,4}$/.test(cvv)) return res.status(400).json({ error: 'CVV inválido' });
    // Tarjeta de prueba que simula un rechazo.
    if (cardNumber === '4000000000000002') return res.status(402).json({ error: 'Pago rechazado por el banco (simulado)' });

    const cart = await cartDetail(req.user.sub);
    if (!cart.items.length) return res.status(400).json({ error: 'El carrito está vacío' });

    await conn.beginTransaction();
    const [o] = await conn.query(
      'INSERT INTO orders (user_id, total, status, card_last4, shipping_address) VALUES (?,?,?,?,?)',
      [req.user.sub, cart.total, 'pagado', cardNumber.slice(-4), address],
    );
    for (const it of cart.items) {
      await conn.query(
        'INSERT INTO order_items (order_id, product_id, name, image, unit_price, quantity) VALUES (?,?,?,?,?,?)',
        [o.insertId, it.productId, it.name, it.image, it.price, it.quantity],
      );
    }
    await conn.query('DELETE FROM cart_items WHERE user_id = ?', [req.user.sub]);
    await conn.commit();
    return res.status(201).json({ id: o.insertId, total: cart.total, status: 'pagado', message: 'Pago aprobado (simulado)' });
  } catch (e) {
    await conn.rollback().catch(() => {});
    return next(e);
  } finally {
    conn.release();
  }
});

// ----- Pedidos -----
async function loadOrder(id) {
  const [orders] = await pool.query('SELECT * FROM orders WHERE id = ?', [id]);
  if (!orders.length) return null;
  const [items] = await pool.query('SELECT product_id, name, image, unit_price, quantity FROM order_items WHERE order_id = ?', [id]);
  const o = orders[0];
  return {
    id: o.id,
    userId: o.user_id,
    total: Number(o.total),
    status: o.status,
    cardLast4: o.card_last4,
    address: o.shipping_address,
    createdAt: o.created_at,
    items: items.map((i) => ({ productId: i.product_id, name: i.name, image: i.image, price: Number(i.unit_price), quantity: i.quantity })),
  };
}

app.get('/api/orders/orders', auth, async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT id FROM orders WHERE user_id = ? ORDER BY id DESC', [req.user.sub]);
    const out = [];
    for (const r of rows) out.push(await loadOrder(r.id));
    res.json(out);
  } catch (e) { next(e); }
});

app.get('/api/orders/orders/:id', auth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Id inválido' });
    const o = await loadOrder(id);
    if (!o || (o.userId !== req.user.sub && req.user.role !== 'admin')) return res.status(404).json({ error: 'Pedido no encontrado' });
    return res.json(o);
  } catch (e) { return next(e); }
});

// Administración: ver todos los pedidos y cambiar su estado.
app.get('/api/orders/admin/orders', auth, requireAdmin, async (_req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT id FROM orders ORDER BY id DESC LIMIT 200');
    const out = [];
    for (const r of rows) out.push(await loadOrder(r.id));
    res.json(out);
  } catch (e) { next(e); }
});

app.put('/api/orders/admin/orders/:id/status', auth, requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const status = String((req.body || {}).status || '');
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Id inválido' });
    if (!STATUSES.includes(status)) return res.status(400).json({ error: `Estado inválido. Use: ${STATUSES.join(', ')}` });
    const [r] = await pool.query('UPDATE orders SET status = ? WHERE id = ?', [status, id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'Pedido no encontrado' });
    return res.json(await loadOrder(id));
  } catch (e) { return next(e); }
});

app.use((_req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

init()
  .then(() => app.listen(PORT, () => console.log(`orders-service escuchando en el puerto ${PORT}`)))
  .catch((e) => { console.error(e); process.exit(1); });
