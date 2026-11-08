'use strict';
// Tienda "Robótica Educativa": aplicación de una sola página sin dependencias.
// Habla con los microservicios por rutas relativas (/api/catalog, /api/users, /api/orders).

const $app = document.getElementById('app');
const $nav = document.getElementById('nav');
const $toast = document.getElementById('toast');
const STATUSES = ['pagado', 'preparando', 'enviado', 'entregado'];
const money = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
const fmt = (n) => money.format(n);

// ---------- utilidades ----------
function esc(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function toast(msg) {
  $toast.textContent = msg;
  $toast.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => $toast.classList.remove('show'), 2600);
}

const session = {
  get token() { try { return localStorage.getItem('token'); } catch (_) { return null; } },
  get user() { try { return JSON.parse(localStorage.getItem('user') || 'null'); } catch (_) { return null; } },
  set(token, user) {
    try { localStorage.setItem('token', token); localStorage.setItem('user', JSON.stringify(user)); } catch (_) { /* sin almacenamiento */ }
  },
  clear() { try { localStorage.removeItem('token'); localStorage.removeItem('user'); } catch (_) { /* nada */ } },
};

async function api(path, opts = {}) {
  const headers = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (session.token) headers.Authorization = `Bearer ${session.token}`;
  let res;
  try {
    res = await fetch(path, { method: opts.method || 'GET', headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  } catch (_) {
    throw new Error('No hay conexión con el servidor');
  }
  if (res.status === 204) return null;
  let data = null;
  try { data = await res.json(); } catch (_) { data = null; }
  if (!res.ok) {
    if (res.status === 401 && session.token) { session.clear(); renderNav(); }
    const e = new Error((data && data.error) || `Error ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return data;
}

const levelTag = (l) => `<span class="tag ${esc(l)}">${esc(l.charAt(0).toUpperCase() + l.slice(1))}</span>`;

// ---------- navegación ----------
function renderNav() {
  const u = session.user;
  const links = [`<a href="#/catalogo" data-r="catalogo">Catálogo</a>`];
  if (u) {
    links.push(`<a href="#/pedidos" data-r="pedidos">Mis pedidos</a>`);
    if (u.role === 'admin') links.push(`<a href="#/admin" data-r="admin">Administración</a>`);
    links.push(`<a href="#/perfil" data-r="perfil">${esc(u.name.split(' ')[0])}</a>`);
    links.push(`<button id="logout" type="button">Cerrar sesión</button>`);
  } else {
    links.push(`<a href="#/entrar" data-r="entrar">Iniciar sesión</a>`);
    links.push(`<a href="#/registro" data-r="registro">Crear cuenta</a>`);
  }
  links.push(`<a class="cart" href="#/carrito">🛒 Carrito</a>`);
  $nav.innerHTML = links.join('');
  const cur = (location.hash.split('/')[1] || '').split('?')[0];
  $nav.querySelectorAll('a[data-r]').forEach((a) => a.classList.toggle('on', a.dataset.r === cur));
  const lo = document.getElementById('logout');
  if (lo) lo.onclick = async () => {
    try { await api('/api/users/logout', { method: 'POST' }); } catch (_) { /* el token se descarta igual */ }
    session.clear(); renderNav(); toast('Sesión cerrada'); location.hash = '#/';
  };
}

function needLogin() {
  location.hash = '#/entrar?next=' + encodeURIComponent(location.hash.slice(1) || '/');
}

// ---------- vistas ----------
async function viewHome() {
  const levels = await api('/api/catalog/levels');
  const icons = { principiante: '🌱', intermedio: '⚙️', avanzado: '🚀' };
  $app.innerHTML = `
    <section class="hero">
      <h1>Aprende robótica armando tu propio robot</h1>
      <p>Kits para niños y jóvenes de 8 a 16 años, organizados por nivel para que cada quien empiece donde le corresponde.</p>
      <a class="btn coral" href="#/catalogo">Ver todos los kits</a>
    </section>
    <h2>Elige tu nivel</h2>
    <div class="grid">${levels.map((l) => `
      <a class="card level" href="#/catalogo?level=${esc(l.id)}">
        <span class="ico">${icons[l.id] || '🤖'}</span>
        <strong>${esc(l.name)}</strong>
        <span class="muted">${esc(l.description)}</span>
      </a>`).join('')}</div>`;
}

async function viewCatalog(params) {
  const [levels, cats] = await Promise.all([api('/api/catalog/levels'), api('/api/catalog/categories')]);
  const level = params.get('level') || '';
  const category = params.get('category') || '';
  const q = params.get('q') || '';
  $app.innerHTML = `
    <h1>Catálogo</h1>
    <p class="sub">Busca por nombre y filtra por nivel o categoría.</p>
    <form class="filters" id="f">
      <input name="q" type="search" placeholder="Buscar por nombre…" value="${esc(q)}" aria-label="Buscar por nombre">
      <select name="level" aria-label="Nivel"><option value="">Todos los niveles</option>
        ${levels.map((l) => `<option value="${esc(l.id)}" ${l.id === level ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select>
      <select name="category" aria-label="Categoría"><option value="">Todas las categorías</option>
        ${cats.map((c) => `<option ${c === category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
      <button class="btn" type="submit">Buscar</button>
    </form>
    <div id="list"><p class="empty">Cargando…</p></div>`;
  document.getElementById('f').onsubmit = (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const p = new URLSearchParams();
    ['q', 'level', 'category'].forEach((k) => { if (fd.get(k)) p.set(k, fd.get(k)); });
    location.hash = '#/catalogo' + (p.toString() ? `?${p}` : '');
  };
  const qs = new URLSearchParams();
  if (level) qs.set('level', level);
  if (category) qs.set('category', category);
  if (q) qs.set('q', q);
  const list = await api('/api/catalog/products' + (qs.toString() ? `?${qs}` : ''));
  document.getElementById('list').innerHTML = list.length ? `<div class="grid">${list.map((p) => `
    <article class="card">
      <div class="thumb" aria-hidden="true">${esc(p.image)}</div>
      <div class="row between">${levelTag(p.level)}<span class="muted">${esc(p.category)}</span></div>
      <strong>${esc(p.name)}</strong>
      <span class="muted">Edades: ${esc(p.ageRange || '—')}</span>
      <div class="row between"><span class="price">${fmt(p.price)}</span>
        <a class="btn sm alt" href="#/producto/${p.id}">Ver ficha</a></div>
      <button class="btn sm add" data-id="${p.id}" type="button">Agregar al carrito</button>
    </article>`).join('')}</div>` : '<p class="empty">No encontramos kits con esos filtros.</p>';
  document.querySelectorAll('.add').forEach((b) => { b.onclick = () => addToCart(Number(b.dataset.id), b); });
}

async function addToCart(id, btn) {
  if (!session.token) return needLogin();
  if (btn) btn.disabled = true;
  try { await api('/api/orders/cart/items', { method: 'POST', body: { productId: id, quantity: 1 } }); toast('Agregado al carrito'); }
  catch (e) { toast(e.message); }
  finally { if (btn) btn.disabled = false; }
}

async function viewProduct(id) {
  let p;
  try { p = await api(`/api/catalog/products/${id}`); } catch (e) { $app.innerHTML = `<p class="err">${esc(e.message)}</p><a class="btn alt" href="#/catalogo">Volver al catálogo</a>`; return; }
  $app.innerHTML = `
    <p><a href="#/catalogo">← Volver al catálogo</a></p>
    <div class="detail">
      <div class="thumb" aria-hidden="true">${esc(p.image)}</div>
      <div>
        <div class="row">${levelTag(p.level)}<span class="tag">${esc(p.category)}</span><span class="tag">Edades ${esc(p.ageRange || '—')}</span></div>
        <h1 style="margin-top:10px">${esc(p.name)}</h1>
        <p>${esc(p.description)}</p>
        <h2 style="margin-top:18px">Qué incluye</h2>
        <ul class="comp">${p.components.map((c) => `<li>${esc(c)}</li>`).join('') || '<li class="muted">Sin detalle</li>'}</ul>
        <p class="price" style="font-size:1.6rem">${fmt(p.price)}</p>
        <button class="btn" id="add" type="button">Agregar al carrito</button>
      </div>
    </div>`;
  document.getElementById('add').onclick = (e) => addToCart(p.id, e.target);
}

function authForm(kind, params) {
  const reg = kind === 'registro';
  $app.innerHTML = `
    <div class="card pad narrow">
      <h1>${reg ? 'Crear cuenta' : 'Iniciar sesión'}</h1>
      <form id="af" novalidate>
        ${reg ? '<div class="field"><label for="n">Nombre</label><input id="n" name="name" autocomplete="name" required></div>' : ''}
        <div class="field"><label for="e">Correo</label><input id="e" name="email" type="email" autocomplete="email" required></div>
        <div class="field"><label for="p">Contraseña${reg ? ' (mínimo 8 caracteres)' : ''}</label><input id="p" name="password" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" required></div>
        <div id="msg"></div>
        <button class="btn" style="width:100%;margin-top:14px" type="submit">${reg ? 'Registrarme' : 'Entrar'}</button>
      </form>
      <p class="muted">${reg ? '¿Ya tienes cuenta? <a href="#/entrar">Inicia sesión</a>' : '¿Primera vez? <a href="#/registro">Crea tu cuenta</a>'}</p>
    </div>`;
  document.getElementById('af').onsubmit = async (e) => {
    e.preventDefault();
    const b = e.target.querySelector('button');
    const fd = Object.fromEntries(new FormData(e.target));
    b.disabled = true;
    try {
      const r = await api(reg ? '/api/users/register' : '/api/users/login', { method: 'POST', body: fd });
      session.set(r.token, r.user); renderNav(); toast(`Hola, ${r.user.name}`);
      const next = params.get('next');
      location.hash = '#' + (next && next.startsWith('/') ? next : '/catalogo');
    } catch (err) {
      document.getElementById('msg').innerHTML = `<div class="err">${esc(err.message)}</div>`;
    } finally { b.disabled = false; }
  };
}

async function viewProfile() {
  if (!session.token) return needLogin();
  const me = await api('/api/users/me');
  $app.innerHTML = `
    <div class="card pad narrow">
      <h1>Mi perfil</h1>
      <p class="muted">${esc(me.email)} · ${me.role === 'admin' ? 'Administrador' : 'Cliente'}</p>
      <form id="pf" novalidate>
        <div class="field"><label for="n">Nombre</label><input id="n" name="name" value="${esc(me.name)}" required></div>
        <div class="field"><label for="p">Nueva contraseña (opcional)</label><input id="p" name="password" type="password" autocomplete="new-password"></div>
        <div id="msg"></div>
        <button class="btn" style="margin-top:14px" type="submit">Guardar cambios</button>
      </form>
    </div>`;
  document.getElementById('pf').onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    try {
      const r = await api('/api/users/me', { method: 'PUT', body: fd });
      session.set(r.token, r.user); renderNav();
      document.getElementById('msg').innerHTML = '<div class="ok">Perfil actualizado</div>';
    } catch (err) { document.getElementById('msg').innerHTML = `<div class="err">${esc(err.message)}</div>`; }
  };
}

async function viewCart() {
  if (!session.token) return needLogin();
  const render = (c) => {
    if (!c.items.length) { $app.innerHTML = '<h1>Tu carrito</h1><p class="empty">Tu carrito está vacío.</p><p style="text-align:center"><a class="btn" href="#/catalogo">Ver el catálogo</a></p>'; return; }
    $app.innerHTML = `
      <h1>Tu carrito</h1>
      <div class="scroll"><table>
        <thead><tr><th>Producto</th><th class="num">Precio</th><th>Cantidad</th><th class="num">Subtotal</th><th></th></tr></thead>
        <tbody>${c.items.map((i) => `<tr>
          <td>${esc(i.image)} ${esc(i.name)}</td><td class="num">${fmt(i.price)}</td>
          <td><input class="qty" type="number" min="1" max="20" value="${i.quantity}" data-id="${i.productId}" aria-label="Cantidad de ${esc(i.name)}"></td>
          <td class="num">${fmt(i.subtotal)}</td>
          <td><button class="btn sm alt rm" data-id="${i.productId}" type="button">Quitar</button></td></tr>`).join('')}</tbody>
      </table></div>
      <div class="row between" style="margin-top:18px"><span class="total">Total: ${fmt(c.total)}</span>
        <a class="btn coral" href="#/pago">Ir a pagar</a></div>`;
    $app.querySelectorAll('.qty').forEach((inp) => {
      inp.onchange = async () => {
        try { render(await api(`/api/orders/cart/items/${inp.dataset.id}`, { method: 'PUT', body: { quantity: Number(inp.value) } })); }
        catch (e) { toast(e.message); }
      };
    });
    $app.querySelectorAll('.rm').forEach((b) => {
      b.onclick = async () => { try { render(await api(`/api/orders/cart/items/${b.dataset.id}`, { method: 'DELETE' })); } catch (e) { toast(e.message); } };
    });
  };
  render(await api('/api/orders/cart'));
}

async function viewCheckout() {
  if (!session.token) return needLogin();
  const c = await api('/api/orders/cart');
  if (!c.items.length) { location.hash = '#/carrito'; return; }
  $app.innerHTML = `
    <h1>Pago</h1>
    <p class="sub">Esto es una simulación: no se cobra nada y el número de tarjeta no se guarda (solo los últimos 4 dígitos).</p>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr))">
      <div class="card pad"><h2 style="margin-top:0">Resumen</h2>
        ${c.items.map((i) => `<div class="row between"><span>${esc(i.name)} × ${i.quantity}</span><span>${fmt(i.subtotal)}</span></div>`).join('')}
        <hr style="border:0;border-top:1px solid var(--line);width:100%"><div class="row between"><strong>Total</strong><span class="total">${fmt(c.total)}</span></div></div>
      <form class="card pad" id="cf" novalidate>
        <div class="field"><label for="a">Dirección de envío</label><input id="a" name="address" autocomplete="street-address" required></div>
        <div class="field"><label for="cn">Número de tarjeta</label><input id="cn" name="cardNumber" inputmode="numeric" autocomplete="off" placeholder="4242 4242 4242 4242" required></div>
        <div class="row"><div class="field" style="flex:1"><label for="ex">Vence (MM/AA)</label><input id="ex" name="expiry" placeholder="12/29" required></div>
          <div class="field" style="flex:1"><label for="cv">CVV</label><input id="cv" name="cvv" inputmode="numeric" autocomplete="off" required></div></div>
        <p class="muted" style="font-size:.85rem">Para probar un rechazo usa 4000 0000 0000 0002.</p>
        <div id="msg"></div>
        <button class="btn coral" style="width:100%;margin-top:10px" type="submit">Pagar ${fmt(c.total)}</button>
      </form>
    </div>`;
  document.getElementById('cf').onsubmit = async (e) => {
    e.preventDefault();
    const b = e.target.querySelector('button');
    b.disabled = true;
    try {
      const r = await api('/api/orders/checkout', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      toast('¡Pago aprobado!'); location.hash = `#/pedido/${r.id}`;
    } catch (err) { document.getElementById('msg').innerHTML = `<div class="err">${esc(err.message)}</div>`; b.disabled = false; }
  };
}

const statusTag = (s) => `<span class="status ${esc(s)}">${esc(s)}</span>`;

async function viewOrders() {
  if (!session.token) return needLogin();
  const list = await api('/api/orders/orders');
  $app.innerHTML = `<h1>Mis pedidos</h1>` + (list.length ? `<div class="scroll"><table>
    <thead><tr><th>Pedido</th><th>Fecha</th><th>Estado</th><th class="num">Total</th><th></th></tr></thead>
    <tbody>${list.map((o) => `<tr><td>#${o.id}</td><td>${esc(new Date(o.createdAt).toLocaleDateString('es-CO'))}</td>
      <td>${statusTag(o.status)}</td><td class="num">${fmt(o.total)}</td><td><a class="btn sm alt" href="#/pedido/${o.id}">Ver</a></td></tr>`).join('')}</tbody></table></div>`
    : '<p class="empty">Aún no has hecho pedidos.</p>');
}

async function viewOrder(id) {
  if (!session.token) return needLogin();
  let o;
  try { o = await api(`/api/orders/orders/${id}`); } catch (e) { $app.innerHTML = `<p class="err">${esc(e.message)}</p><a class="btn alt" href="#/pedidos">Mis pedidos</a>`; return; }
  const idx = STATUSES.indexOf(o.status);
  $app.innerHTML = `
    <p><a href="#/pedidos">← Mis pedidos</a></p>
    <h1>Pedido #${o.id} ${statusTag(o.status)}</h1>
    <div class="steps" aria-label="Estado del pedido">${STATUSES.map((s, i) => `<div class="${i <= idx ? 'done' : ''}">${esc(s)}</div>`).join('')}</div>
    <p class="muted">Pagado con tarjeta terminada en ${esc(o.cardLast4)} · Envío a: ${esc(o.address)}</p>
    <div class="scroll"><table><thead><tr><th>Producto</th><th class="num">Precio</th><th class="num">Cant.</th></tr></thead>
      <tbody>${o.items.map((i) => `<tr><td>${esc(i.image)} ${esc(i.name)}</td><td class="num">${fmt(i.price)}</td><td class="num">${i.quantity}</td></tr>`).join('')}</tbody></table></div>
    <p class="total" style="text-align:right">Total: ${fmt(o.total)}</p>`;
}

async function viewAdmin() {
  const u = session.user;
  if (!session.token) return needLogin();
  if (!u || u.role !== 'admin') { $app.innerHTML = '<p class="err">Solo administradores.</p>'; return; }
  const [products, orders, levels] = await Promise.all([api('/api/catalog/products'), api('/api/orders/admin/orders'), api('/api/catalog/levels')]);
  $app.innerHTML = `
    <h1>Administración</h1>
    <h2>Productos</h2>
    <div class="scroll"><table><thead><tr><th>Producto</th><th>Nivel</th><th class="num">Precio</th><th></th></tr></thead>
      <tbody>${products.map((p) => `<tr><td>${esc(p.image)} ${esc(p.name)}</td><td>${levelTag(p.level)}</td><td class="num">${fmt(p.price)}</td>
        <td class="row"><button class="btn sm alt ed" data-id="${p.id}" type="button">Editar</button><button class="btn sm coral del" data-id="${p.id}" type="button">Eliminar</button></td></tr>`).join('')}</tbody></table></div>
    <h2 id="ftitle">Nuevo producto</h2>
    <form class="card pad" id="pf" novalidate>
      <input type="hidden" name="id">
      <div class="field"><label for="pn">Nombre</label><input id="pn" name="name" required></div>
      <div class="field"><label for="pd">Descripción</label><textarea id="pd" name="description" rows="2"></textarea></div>
      <div class="row">
        <div class="field" style="flex:1"><label for="pl">Nivel</label><select id="pl" name="level">${levels.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('')}</select></div>
        <div class="field" style="flex:1"><label for="pc">Categoría</label><input id="pc" name="category" value="General"></div>
        <div class="field" style="flex:1"><label for="pp">Precio (COP)</label><input id="pp" name="price" type="number" min="1" step="1" required></div>
      </div>
      <div class="row">
        <div class="field" style="flex:1"><label for="pa">Edades (ej. 8-10)</label><input id="pa" name="ageRange"></div>
        <div class="field" style="flex:1"><label for="pi">Emoji / imagen</label><input id="pi" name="image" value="🤖" maxlength="8"></div>
      </div>
      <div class="field"><label for="pk">Componentes (separados por coma)</label><input id="pk" name="components"></div>
      <div id="msg"></div>
      <div class="row" style="margin-top:12px"><button class="btn" type="submit">Guardar</button><button class="btn alt" id="reset" type="button">Limpiar</button></div>
    </form>
    <h2>Pedidos de clientes</h2>
    ${orders.length ? `<div class="scroll"><table><thead><tr><th>Pedido</th><th>Cliente</th><th class="num">Total</th><th>Estado</th></tr></thead>
      <tbody>${orders.map((o) => `<tr><td>#${o.id}</td><td>Usuario ${o.userId}</td><td class="num">${fmt(o.total)}</td>
        <td><select class="st" data-id="${o.id}" aria-label="Estado del pedido ${o.id}">${STATUSES.map((s) => `<option ${s === o.status ? 'selected' : ''}>${s}</option>`).join('')}</select></td></tr>`).join('')}</tbody></table></div>`
      : '<p class="empty">Aún no hay pedidos.</p>'}`;
  const form = document.getElementById('pf');
  const msg = document.getElementById('msg');
  const reset = () => { form.reset(); form.elements.id.value = ''; document.getElementById('ftitle').textContent = 'Nuevo producto'; msg.innerHTML = ''; };
  document.getElementById('reset').onclick = reset;
  $app.querySelectorAll('.ed').forEach((b) => {
    b.onclick = () => {
      const p = products.find((x) => x.id === Number(b.dataset.id));
      form.elements.id.value = p.id; form.elements.name.value = p.name; form.elements.description.value = p.description || '';
      form.elements.level.value = p.level; form.elements.category.value = p.category; form.elements.price.value = p.price;
      form.elements.ageRange.value = p.ageRange; form.elements.image.value = p.image; form.elements.components.value = p.components.join(', ');
      document.getElementById('ftitle').textContent = `Editar: ${p.name}`;
      form.scrollIntoView({ behavior: 'smooth' });
    };
  });
  $app.querySelectorAll('.del').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('¿Eliminar este producto?')) return;
      try { await api(`/api/catalog/admin/products/${b.dataset.id}`, { method: 'DELETE' }); toast('Producto eliminado'); viewAdmin(); } catch (e) { toast(e.message); }
    };
  });
  $app.querySelectorAll('.st').forEach((s) => {
    s.onchange = async () => {
      try { await api(`/api/orders/admin/orders/${s.dataset.id}/status`, { method: 'PUT', body: { status: s.value } }); toast('Estado actualizado'); } catch (e) { toast(e.message); }
    };
  });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = form;
    const body = {
      name: f.elements.name.value, description: f.elements.description.value, level: f.elements.level.value, category: f.elements.category.value,
      price: Number(f.elements.price.value), ageRange: f.elements.ageRange.value, image: f.elements.image.value,
      components: f.elements.components.value.split(',').map((c) => c.trim()).filter(Boolean),
    };
    try {
      if (f.elements.id.value) await api(`/api/catalog/admin/products/${f.elements.id.value}`, { method: 'PUT', body });
      else await api('/api/catalog/admin/products', { method: 'POST', body });
      toast('Producto guardado'); viewAdmin();
    } catch (err) { msg.innerHTML = `<div class="err">${esc(err.message)}</div>`; }
  };
}

// ---------- enrutador ----------
async function route() {
  const raw = location.hash.slice(1) || '/';
  const [path, qs] = raw.split('?');
  const params = new URLSearchParams(qs || '');
  const seg = path.split('/').filter(Boolean);
  renderNav();
  window.scrollTo(0, 0);
  try {
    if (!seg.length) await viewHome();
    else if (seg[0] === 'catalogo') await viewCatalog(params);
    else if (seg[0] === 'producto') await viewProduct(Number(seg[1]));
    else if (seg[0] === 'entrar') authForm('entrar', params);
    else if (seg[0] === 'registro') authForm('registro', params);
    else if (seg[0] === 'perfil') await viewProfile();
    else if (seg[0] === 'carrito') await viewCart();
    else if (seg[0] === 'pago') await viewCheckout();
    else if (seg[0] === 'pedidos') await viewOrders();
    else if (seg[0] === 'pedido') await viewOrder(Number(seg[1]));
    else if (seg[0] === 'admin') await viewAdmin();
    else $app.innerHTML = '<p class="empty">Página no encontrada. <a href="#/">Ir al inicio</a></p>';
  } catch (e) {
    $app.innerHTML = `<div class="err">${esc(e.message)}</div>`;
  }
}

window.addEventListener('hashchange', route);
route();
