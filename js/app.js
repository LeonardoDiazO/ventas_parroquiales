// ══════════════════════════════════════
// ⚙️  CONFIG — edita con tus datos de Supabase
// ══════════════════════════════════════
const SUPABASE_URL      = 'https://kbotyjlwekuxbnuxxmoh.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtib3R5amx3ZWt1eGJudXh4bW9oIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAyNTk2MTksImV4cCI6MjEwNTgzNTYxOX0.95UvpSmHcXzyJB08kVRZhp8NqJzwmnOA0wQI0Y_u97Q';
const BUCKET            = 'receipts';
// ══════════════════════════════════════

const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// STATE
let user = null, profile = null, isAdmin = false, isSuperAdmin = false;
let selectedNewRole = 'seller'; // para el modal de crear usuario
let event = null, products = [], orders = [], items = [], payments = [];
let filter = 'all', selMethod = null, selSaleTypeVal = 'preventa';
let signedUrls = {};          // path → signed URL (receipts)
let loginCooldown = false;    // rate-limit login

// Evento en gestión dentro del modal admin (puede ser el activo u otro archivado)
let mgmtEventId = null, mgmtProducts = [];
let allEvents = [];           // listado completo para el modal de Eventos

// 🔀 Evento de trabajo por sesión/dispositivo (independiente por persona):
// cada usuario puede estar viendo/vendiendo en un evento distinto al mismo tiempo.
// Se recuerda en localStorage de este navegador, no es un estado compartido.
let workingEventId = null;
function setHdrEvent(name) {
  document.getElementById('hdrEvent').textContent = (name || 'Sin evento activo') + ' ▾';
}

// ── HELPERS ──
const cop = n => '$' + Math.round(n).toLocaleString('es-CO');
const ico = m => ({ nequi:'📱', efectivo:'💵', transferencia:'🏦' }[m] || '💰');
// 🗺️ Abre direcciones en Google Maps desde la ubicación actual del que
// entrega hasta la dirección del pedido (útil para motorizados).
const mapsLink = addr => 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(addr);

// 🔒 XSS — escapa texto antes de insertarlo en innerHTML
function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// 🔒 Storage — normaliza receipt_url a un path relativo dentro del bucket.
// Hoy se guarda ya como path plano (ej: "orderId/123.jpg" — ver savePayment()).
// Si alguna fila vieja tuviera una URL completa en vez de un path, se extrae
// igual la parte relativa después de "/receipts/".
function pathFromUrl(url) {
  if (!url) return null;
  const m = url.match(/\/receipts\/(.+?)(\?.*)?$/);
  return m ? m[1] : url;
}

// 🔒 Storage — devuelve la URL firmada en caché, o vacío si no hay
function receiptUrl(p) {
  const path = pathFromUrl(p.receipt_url);
  return path ? (signedUrls[path] || '') : '';
}

// 🔒 Storage — genera/refresca URLs firmadas (2 h) para todos los comprobantes
async function refreshSignedUrls() {
  const paths = [...new Set(payments.map(p => pathFromUrl(p.receipt_url)).filter(Boolean))];
  for (const path of paths) {
    if (signedUrls[path]) continue; // ya en caché
    const { data } = await db.storage.from(BUCKET).createSignedUrl(path, 7200);
    if (data?.signedUrl) signedUrls[path] = data.signedUrl;
  }
}

// 📎 Firma un comprobante puntual con una vida más larga que la de la app en
// vivo (se usa solo al exportar, para que el link no muera a las 2h).
async function resolveReceiptSignedUrl(path, expiresIn = 604800) { // 7 días
  if (!path) return '';
  const { data, error } = await db.storage.from(BUCKET).createSignedUrl(path, expiresIn);
  if (error) { console.warn('No se pudo firmar el comprobante:', error.message); return ''; }
  return data?.signedUrl || '';
}

// 📎 Descarga una foto de comprobante y la comprime a JPEG para poder
// incrustarla como base64 en el reporte HTML — así el reporte queda
// autocontenido (no necesita internet ni un link que pueda vencerse).
function fetchImageAsCompressedDataUri(url, maxDim = 900, quality = 0.6) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      try {
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      } catch (e) { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

// 🎯 Stock por producto (best-effort, igual de eventual-consistente que el
// cierre por meta global del evento — se corrige solo vía realtime).
const soldOf = productId => items.reduce((s,i) => i.product_id===productId ? s+i.quantity : s, 0);
const remainingOf = p => p.stock_limit == null ? Infinity : Math.max(0, p.stock_limit - soldOf(p.id));

const itemsOf  = o => items.filter(i => i.order_id === o.id);
const totalOf  = o => itemsOf(o).reduce((s,i) => s + i.quantity * i.unit_price, 0);
const paidOf   = o => payments.filter(p => p.order_id === o.id).reduce((s,p) => s + Number(p.amount), 0);
const statusOf = o => { const t=totalOf(o),p=paidOf(o); return p>=t&&t>0?'paid':p>0?'partial':'pending'; };

function itemsSummary(o) {
  return itemsOf(o).map(i => {
    const pr = products.find(p => p.id === i.product_id);
    return `${i.quantity}${pr?.emoji||'🛒'} ${pr?.name||'?'}`;
  }).join(' · ') || '—';
}

// ══════════════════════════════════════
// EMOJI AUTO-DETECT
// ══════════════════════════════════════
const EMOJI_RULES = [
  // Pasteles y masas
  [/pastel|empanada|empanadita|hayaca|hallaca|tamal/i, '🥟'],
  [/pollo|gallina|pechuga/i,                           '🐥'],
  [/cerdo|pork|chicharron|lechona|costilla/i,          '🐷'],
  [/carne|res|lomito|bistec|chuleta/i,                 '🥩'],
  [/arepa/i,                                           '🫓'],
  // Sopas y caldos
  [/sopa|caldo|sancocho|mondongo|ajiaco|hervido/i,     '🍲'],
  // Arroz y platos
  [/arroz/i,                                           '🍚'],
  [/bandeja|plato|almuerzo|combo/i,                    '🍱'],
  [/hamburguesa|burger/i,                              '🍔'],
  [/pizza/i,                                           '🍕'],
  [/perro|hot.?dog/i,                                  '🌭'],
  [/taco|wrap|burrito/i,                               '🌮'],
  [/ensalada|cesar/i,                                  '🥗'],
  // Bebidas
  [/granizado|raspado|raspao|helado.?paleta/i,         '🧊'],
  [/helado/i,                                          '🍦'],
  [/jugo|zumo|limonada|maracuya|lulo/i,                '🧃'],
  [/gaseosa|soda|refresco|colombiana|bretaña/i,        '🥤'],
  [/agua\b/i,                                          '💧'],
  [/caf[eé]|tinto|cappuccino|latte/i,                  '☕'],
  [/chocolate|cocoa/i,                                 '🍫'],
  [/panela|agua.?panela/i,                             '☕'],
  [/cerveza|beer/i,                                    '🍺'],
  // Postres y dulces
  [/torta|ponqu[eé]|cake/i,                            '🎂'],
  [/cupcake|muffin/i,                                  '🧁'],
  [/galleta|cookie/i,                                  '🍪'],
  [/brownie/i,                                         '🍫'],
  [/postre|dulce|candy/i,                              '🍬'],
  [/pan\b|pandebono|pandeyuca|croissant/i,             '🥖'],
  // Frutas
  [/mango/i,  '🥭'], [/fresa/i, '🍓'], [/uva/i, '🍇'],
  [/banano|platano/i, '🍌'], [/naranja/i, '🍊'],
  [/fruta|fruit/i, '🍉'],
  // Snacks
  [/palomita|popcorn/i, '🍿'],
  [/chips|papas.?fritas|patacon/i, '🍟'],
];

function autoEmoji(name) {
  for (const [re, em] of EMOJI_RULES) { if (re.test(name)) return em; }
  return '🛒';
}

const ALL_EMOJIS = [
  '🥟','🐥','🐷','🥩','🍗','🫓','🍔','🌮','🌯','🍕','🌭','🥗',
  '🍲','🍚','🍱','🍜','🥘','🍛','🍽️',
  '🧊','🍦','🧃','🥤','💧','☕','🍫','🍺',
  '🎂','🧁','🍪','🍬','🍩','🥖','🍿','🍟',
  '🥭','🍓','🍇','🍌','🍊','🍉',
  '🛒','🎁','⭐'
];

function renderEmojiPicker(selected) {
  const el = document.getElementById('emojiPicker'); if (!el) return;
  el.innerHTML = ALL_EMOJIS.map(e =>
    `<button type="button" class="epick${e===selected?' sel':''}" onclick="pickEmoji('${e}')">${e}</button>`
  ).join('');
}

function pickEmoji(e) {
  document.getElementById('pEmoji').value = e;
  document.getElementById('pEmojiDisplay').textContent = e;
  document.querySelectorAll('.epick').forEach(b => b.classList.toggle('sel', b.textContent===e));
}

function onProdNameInput(name) {
  const e = autoEmoji(name);
  pickEmoji(e);
}

// ══════════════════════════════════════
// DEMO MODE
// ══════════════════════════════════════
function enterDemo(role = 'admin') {
  const DEMO_EVENT_ID = 'demo-event-1';
  const p1 = 'demo-prod-pollo', p2 = 'demo-prod-cerdo', p3 = 'demo-prod-granizado';
  const o1 = 'demo-order-1', o2 = 'demo-order-2', o3 = 'demo-order-3', o4 = 'demo-order-4';

  const isSuperAdminDemo = role === 'superadmin';
  const isAdminDemo      = role === 'admin' || isSuperAdminDemo;
  user    = { id:'demo-user', email: isSuperAdminDemo ? 'superadmin@parroquia.local' : isAdminDemo ? 'padre@parroquia.local' : 'vendedor@parroquia.local' };
  profile = { id:'demo-user', full_name: isSuperAdminDemo ? 'Superadmin' : isAdminDemo ? 'Padre Daniel' : 'Vendedor Demo', role };
  isAdmin = isAdminDemo;
  isSuperAdmin = isSuperAdminDemo;

  event = { id:DEMO_EVENT_ID, name:'Catedratón – Sep 27', date:'2026-09-27', goal:100, active:true, closed:false };

  products = [
    { id:p1, event_id:DEMO_EVENT_ID, name:'Pastel de pollo', price:12000, emoji:'🐥', display_order:0, active:true },
    { id:p2, event_id:DEMO_EVENT_ID, name:'Pastel de cerdo', price:12000, emoji:'🐷', display_order:1, active:true },
    { id:p3, event_id:DEMO_EVENT_ID, name:'Granizado',       price:5000,  emoji:'🧊', display_order:2, active:true },
  ];

  orders = [
    { id:o1, event_id:DEMO_EVENT_ID, customer_name:'Ana Ficticia',       phone:'300 111 2222', needs_delivery:false, address:'', notes:'', sale_type:'preventa',  created_by:'demo-user', created_at: new Date(Date.now()-7200000).toISOString() },
    { id:o2, event_id:DEMO_EVENT_ID, customer_name:'Carlos Ejemplo',     phone:'301 333 4444', needs_delivery:true,  address:'Cra 5 #12-34, Barrio Demo', notes:'', sale_type:'preventa',  created_by:'demo-user', created_at: new Date(Date.now()-5400000).toISOString() },
    { id:o3, event_id:DEMO_EVENT_ID, customer_name:'Laura Prueba',       phone:'317 555 6666', needs_delivery:true,  address:'Cll 8 #3-10, Barrio Demo', notes:'2 piso', sale_type:'en_evento', created_by:'demo-user', created_at: new Date(Date.now()-3600000).toISOString() },
    { id:o4, event_id:DEMO_EVENT_ID, customer_name:'Pedro de Muestra',   phone:'311 777 8888', needs_delivery:false, address:'', notes:'', sale_type:'en_evento', created_by:'demo-user', created_at: new Date(Date.now()-1800000).toISOString() },
  ];

  items = [
    { id:'i1', order_id:o1, product_id:p1, quantity:2, unit_price:12000 },
    { id:'i2', order_id:o1, product_id:p2, quantity:1, unit_price:12000 },
    { id:'i3', order_id:o1, product_id:p3, quantity:2, unit_price:5000  },
    { id:'i4', order_id:o2, product_id:p1, quantity:1, unit_price:12000 },
    { id:'i5', order_id:o2, product_id:p2, quantity:1, unit_price:12000 },
    { id:'i6', order_id:o3, product_id:p2, quantity:2, unit_price:12000 },
    { id:'i7', order_id:o3, product_id:p1, quantity:1, unit_price:12000 },
    { id:'i8', order_id:o4, product_id:p2, quantity:2, unit_price:12000 },
  ];

  payments = [
    { id:'pay1', order_id:o1, amount:46000, method:'nequi',     receipt_url:null, received_by:null, registered_by_id:'demo-user', registered_by_name:'Vendedor 1', notes:'', created_at: new Date(Date.now()-7000000).toISOString() },
    { id:'pay2', order_id:o2, amount:12000, method:'efectivo',  receipt_url:null, received_by:'Vendedor 1', registered_by_id:'demo-user', registered_by_name:'Vendedor 1', notes:'', created_at: new Date(Date.now()-5000000).toISOString() },
    { id:'pay3', order_id:o3, amount:20000, method:'transferencia', receipt_url:null, received_by:null, registered_by_id:'demo-user', registered_by_name:'Vendedor 2', notes:'', created_at: new Date(Date.now()-3000000).toISOString() },
  ];

  // Patch save functions so demo mode doesn't crash on Supabase calls
  window._demoMode = true;
  const noop = async () => ({ data:null, error:null });
  window._origSaveOrder   = window.saveOrder;
  window._origSavePayment = window.savePayment;
  window._origDeleteOrder = window.deleteOrder;
  window.saveOrder   = () => { toast('🧪 Demo: pedido no se guarda en Supabase'); closeModal('addModal'); };
  window.savePayment = () => { toast('🧪 Demo: pago no se guarda en Supabase'); closeModal('payModal'); };
  window.deleteOrder = () => { toast('🧪 Demo: eliminación no disponible en demo'); };
  window.saveEvent      = () => { toast('🧪 Demo: config no se guarda en Supabase'); };
  window.saveProduct    = () => { toast('🧪 Demo: producto no se guarda en Supabase'); };
  window.deleteProduct  = () => { toast('🧪 Demo: eliminación no disponible en demo'); };
  window.saveEditPrice = () => { toast('🧪 Demo: edición no disponible en demo'); };
  window.activateEvent  = () => { toast('🧪 Demo: solo hay un evento de prueba'); };
  window.switchWorkingEvent = () => { toast('🧪 Demo: solo hay un evento de prueba'); };
  window.toggleEventClosed = () => { toast('🧪 Demo: no se puede cerrar el evento de prueba'); };

  // Boot the UI
  document.getElementById('loginScreen').classList.add('hide');
  document.getElementById('app').classList.remove('hide');
  const demoLabel = isSuperAdminDemo ? '👑 Superadmin (DEMO)' : isAdminDemo ? '👤 Padre Daniel ★ (DEMO)' : '👤 Vendedor Demo (DEMO)';
  document.getElementById('hdrUser').textContent = demoLabel;
  document.getElementById('hdrDate').textContent = new Date().toLocaleDateString('es-CO',{weekday:'short',day:'numeric',month:'short'});
  workingEventId = event.id;
  setHdrEvent(event.name);
  if (isAdminDemo) document.getElementById('adminPanel').classList.remove('hide');
  if (isSuperAdminDemo) {
    document.getElementById('superPanel').classList.remove('hide');
    document.getElementById('btnCreateAdmin').classList.remove('hide');
  }
  applyRoleVisibility();

  renderDashboard(); renderOrders(); renderFinances();
  toast('🧪 Modo demo activo — datos de prueba cargados');
}

// ══════════════════════════════════════
// AUTH
// ══════════════════════════════════════
const DOMAIN = '@parroquia.local';
function toEmail(username) { return username.toLowerCase().replace(/\s+/g,'') + DOMAIN; }

async function doLogin() {
  if (loginCooldown) return;
  const username = document.getElementById('lgUser').value.trim();
  const pass     = document.getElementById('lgPass').value;
  const errEl    = document.getElementById('lgErr');
  errEl.textContent = '';
  if (!username || !pass) { errEl.textContent = 'Ingresa usuario y contraseña.'; return; }
  const btn = document.getElementById('lgBtn');
  btn.innerHTML = '<span class="spin"></span> Entrando...'; btn.disabled = true;
  const { data, error } = await db.auth.signInWithPassword({ email: toEmail(username), password: pass });
  if (error) {
    errEl.textContent = 'Usuario o contraseña incorrectos.';
    // 🔒 Rate limit: bloquea el botón 5 s tras cada fallo
    loginCooldown = true;
    let secs = 5;
    const tick = setInterval(() => {
      btn.innerHTML = `Espera ${secs}s...`;
      if (--secs < 0) {
        clearInterval(tick);
        btn.innerHTML = 'Entrar →'; btn.disabled = false;
        loginCooldown = false;
      }
    }, 1000);
    return;
  }
  await boot(data.user);
}
async function doLogout() { await db.auth.signOut(); location.reload(); }

function selNewRole(r) {
  selectedNewRole = r;
  document.getElementById('role_seller').classList.toggle('sel', r === 'seller');
  document.getElementById('role_admin').classList.toggle('sel', r === 'admin');
}

function openUserModal(forceRole = null) {
  if (window._demoMode) { toast('🧪 Demo: cuentas reales no disponibles'); return; }
  // Si superadmin abre sin rol forzado, mostrar selector; si admin, siempre seller
  const defaultRole = forceRole || (isSuperAdmin ? 'seller' : 'seller');
  selectedNewRole = defaultRole;
  selNewRole(defaultRole);
  const showSelector = isSuperAdmin && !forceRole;
  document.getElementById('roleSelector').classList.toggle('hide', !showSelector);
  const titles = { seller:'🛒 Crear cuenta de vendedor', admin:'⚙️ Crear cuenta de administrador' };
  document.getElementById('userModalTitle').textContent = showSelector ? '👥 Crear cuenta' : (titles[defaultRole] || '👤 Crear cuenta');
  document.getElementById('uName').value='';
  document.getElementById('uUser').value='';
  document.getElementById('uPass').value='';
  document.getElementById('uErr').textContent='';
  openModal('userModal');
}

async function createUser() {
  const fullName = document.getElementById('uName').value.trim();
  const username = document.getElementById('uUser').value.trim();
  const pass     = document.getElementById('uPass').value;
  const errEl    = document.getElementById('uErr');
  errEl.textContent = '';
  if (!fullName) { errEl.textContent = 'Ingresa el nombre completo.'; return; }
  if (!username || username.length < 2) { errEl.textContent = 'El usuario debe tener al menos 2 caracteres.'; return; }
  if (pass.length < 6) { errEl.textContent = 'La contraseña debe tener al menos 6 caracteres.'; return; }

  const roleToCreate = (isSuperAdmin ? selectedNewRole : 'seller');
  const email = toEmail(username);
  const { data, error } = await db.auth.signUp({
    email, password: pass,
    options: { data: { full_name: fullName } }  // 🔒 nunca pasamos role en metadata
  });
  if (error) { errEl.textContent = '❌ ' + (error.message.includes('already') ? 'Ese usuario ya existe.' : error.message); return; }
  if (!data.user) { errEl.textContent = '❌ Ese usuario ya existe.'; return; }

  // 🔒 Si se necesita rol admin, lo asigna el servidor vía RPC (solo superadmin puede)
  if (roleToCreate === 'admin') {
    const { error: rpcErr } = await db.rpc('set_user_role', {
      target_user_id: data.user.id, new_role: 'admin'
    });
    if (rpcErr) { errEl.textContent = '❌ Error asignando rol: ' + rpcErr.message; return; }
  }

  closeModal('userModal');
  const roleLabel = roleToCreate === 'admin' ? 'administrador' : 'vendedor';
  toast(`✅ Cuenta de ${roleLabel} "${username}" creada`);
}

// ══════════════════════════════════════
// USUARIOS: listar / desactivar / resetear contraseña / eliminar
// ══════════════════════════════════════
let allUsers = [];

async function openUsersModal() {
  const el = document.getElementById('usersList');
  if (window._demoMode) {
    el.innerHTML = '<div class="empty"><div class="ei">🧪</div>En modo demo no hay usuarios reales que listar.</div>';
    openModal('usersModal');
    return;
  }
  el.innerHTML = '<div class="loading">Cargando...</div>';
  openModal('usersModal');
  const { data, error } = await db.rpc('admin_list_users');
  if (error) { el.innerHTML = `<div class="empty"><div class="ei">❌</div>${esc(error.message)}</div>`; return; }
  allUsers = data || [];
  renderUsersList();
}

const roleLabelEs = r => ({ superadmin:'👑 Superadmin', admin:'⚙️ Admin', seller:'🛒 Vendedor' }[r] || r);

function renderUsersList() {
  const el = document.getElementById('usersList');
  if (!allUsers.length) { el.innerHTML = '<div class="empty"><div class="ei">👥</div>Sin usuarios</div>'; return; }
  el.innerHTML = allUsers.map(u => {
    const isSelf = u.id === user.id;
    const targetIsAdminTier = u.role === 'admin' || u.role === 'superadmin';
    const canManage = !isSelf && (!targetIsAdminTier || isSuperAdmin);
    const username = (u.email || '').split('@')[0];
    // 🔁 Ascender/degradar rol: solo superadmin, y nunca sobre otro superadmin.
    const promoBtn = (isSuperAdmin && !isSelf && u.role !== 'superadmin')
      ? `<button class="btn bsm" style="background:#EFF6FF;color:#1D4ED8;"
          onclick="promoteUser('${u.id}', '${u.role==='admin'?'seller':'admin'}', '${esc(u.full_name)}')">
          ${u.role==='admin' ? '⬇️ Volver a vendedor' : '⬆️ Ascender a admin'}</button>`
      : '';
    return `
    <div class="ocard" style="cursor:default;${u.banned?'border-left-color:var(--err);':''}">
      <div class="otop">
        <div class="oname">${esc(u.full_name)}${isSelf?' <span style="font-size:12px;color:var(--muted);">(tú)</span>':''}</div>
        <span>
          <span class="badge" style="background:#F3F4F6;color:#374151;">${roleLabelEs(u.role)}</span>
          ${u.banned?' <span class="badge" style="background:#FEF2F2;color:#991B1B;">🔒 Desactivado</span>':''}
        </span>
      </div>
      <div class="ometa">👤 ${esc(username)}</div>
      ${canManage ? `
        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
          ${promoBtn}
          <button class="btn bsm" style="background:${u.banned?'#F0FDF4':'#FEF2F2'};color:${u.banned?'#166534':'#991B1B'};"
            onclick="banUserToggle('${u.id}', ${u.banned})">${u.banned ? '🔓 Reactivar' : '🔒 Desactivar'}</button>
          <button class="btn bou bsm" onclick="resetUserPassword('${u.id}', '${esc(u.full_name)}')">🔑 Resetear contraseña</button>
          <button class="btn bda bsm" onclick="deleteUserAccount('${u.id}', '${esc(u.full_name)}')">🗑️ Eliminar</button>
        </div>
      ` : `<div style="font-size:12px;color:var(--muted);margin-top:8px;">
        ${isSelf ? 'No puedes gestionar tu propia cuenta.' : 'Solo un superadmin puede gestionar cuentas de administrador.'}
      </div>`}
    </div>`;
  }).join('');
}

// 🔒 Auditoría best-effort: si log_audit falla (ej. función aún no
// desplegada en Supabase), la acción principal ya se hizo — no la revertimos,
// solo avisamos por consola para no bloquear al usuario por un log.
async function logAudit(action, targetType, targetId, targetLabel, details) {
  if (window._demoMode) return;
  const { error } = await db.rpc('log_audit', {
    p_action: action, p_target_type: targetType, p_target_id: targetId,
    p_target_label: targetLabel, p_details: details || null,
  });
  if (error) console.warn('[auditoría] no se pudo registrar:', error.message);
}

async function promoteUser(id, newRole, name) {
  const label = newRole === 'admin' ? 'ascender a administrador' : 'volver a vendedor';
  if (!(await askConfirm(`¿Seguro que quieres ${label} a ${name}?`, { confirmLabel:'Sí, cambiar rol' }))) return;
  const { error } = await db.rpc('set_user_role', { target_user_id: id, new_role: newRole });
  if (error) { toast('❌ ' + error.message); return; }
  await logAudit('user.role_change', 'user', id, name, { new_role: newRole });
  toast(`✅ ${name} ahora es ${newRole === 'admin' ? 'administrador' : 'vendedor'}`);
  await openUsersModal();
}

async function banUserToggle(id, currentlyBanned) {
  const name = allUsers.find(u => u.id === id)?.full_name || '';
  const { error } = await db.rpc('admin_set_user_banned', { target_user_id: id, is_banned: !currentlyBanned });
  if (error) { toast('❌ ' + error.message); return; }
  await logAudit(currentlyBanned ? 'user.unban' : 'user.ban', 'user', id, name);
  toast(currentlyBanned ? '🔓 Cuenta reactivada' : '🔒 Cuenta desactivada');
  await openUsersModal();
}

async function resetUserPassword(id, name) {
  const pass = await askPrompt(`Escribe la nueva contraseña para ${name}.`, {
    title: '🔑 Resetear contraseña', hint: 'Mínimo 6 caracteres.', confirmLabel: 'Actualizar', inputType: 'text',
  });
  if (pass === null) return;
  if (pass.length < 6) { toast('⚠️ La contraseña debe tener al menos 6 caracteres'); return; }
  const { error } = await db.rpc('admin_reset_password', { target_user_id: id, new_password: pass });
  if (error) { toast('❌ ' + error.message); return; }
  await logAudit('user.password_reset', 'user', id, name);
  toast(`✅ Contraseña de ${name} actualizada`);
}

async function deleteUserAccount(id, name) {
  if (!(await askConfirm(`¿Eliminar la cuenta de ${name}? No se puede deshacer.`, { title:'🗑️ Eliminar cuenta', confirmLabel:'Eliminar', danger:true }))) return;
  const { error } = await db.rpc('admin_delete_user', { target_user_id: id });
  if (error) { toast('❌ ' + error.message); return; }
  await logAudit('user.delete', 'user', id, name);
  toast(`🗑️ Cuenta de ${name} eliminada`);
  await openUsersModal();
}

// ══════════════════════════════════════
// AUDITORÍA — quién hizo qué (admin/superadmin)
// ══════════════════════════════════════
const AUDIT_LABELS = {
  'event.create':        '📅 Creó el evento',
  'event.edit':          '✏️ Editó el evento',
  'event.close':         '🔒 Cerró el evento',
  'event.reopen':        '🔓 Reabrió el evento',
  'event.delete':        '🗑️ Eliminó el evento',
  'product.price_change':'💲 Cambió el precio de',
  'product.delete':      '🗑️ Eliminó el producto',
  'order.delete':        '🗑️ Eliminó el pedido de',
  'user.role_change':    '🔁 Cambió el rol de',
  'user.ban':            '🔒 Desactivó la cuenta de',
  'user.unban':          '🔓 Reactivó la cuenta de',
  'user.delete':         '🗑️ Eliminó la cuenta de',
  'user.password_reset': '🔑 Reseteó la contraseña de',
};

async function openAuditModal() {
  const el = document.getElementById('auditList');
  if (window._demoMode) {
    el.innerHTML = '<div class="empty"><div class="ei">🧪</div>En modo demo no hay auditoría real que mostrar.</div>';
    openModal('auditModal');
    return;
  }
  el.innerHTML = '<div class="loading">Cargando...</div>';
  openModal('auditModal');
  const { data, error } = await db.from('audit_log').select('*')
    .order('created_at', { ascending:false }).limit(100);
  if (error) { el.innerHTML = `<div class="empty"><div class="ei">❌</div>${esc(error.message)}</div>`; return; }
  renderAuditList(data || []);
}

function renderAuditList(rows) {
  const el = document.getElementById('auditList');
  if (!rows.length) { el.innerHTML = '<div class="empty"><div class="ei">📝</div>Sin actividad registrada aún</div>'; return; }
  el.innerHTML = rows.map(r => {
    const t = new Date(r.created_at).toLocaleString('es-CO',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
    const label = AUDIT_LABELS[r.action] || r.action;
    return `<div class="prow">
      <div>
        <div style="font-weight:700;font-size:14px;">${label} ${esc(r.target_label||'')}</div>
        <div style="font-size:12px;color:var(--muted);">${esc(r.actor_name||'—')} · ${t}</div>
      </div>
    </div>`;
  }).join('');
}

// ══════════════════════════════════════
// UBICACIÓN DE VENDEDORES — quién está en cada evento
// ══════════════════════════════════════
async function openWorkingLocationsModal() {
  const el = document.getElementById('locationsList');
  if (window._demoMode) {
    el.innerHTML = '<div class="empty"><div class="ei">🧪</div>En modo demo no hay vendedores reales que ubicar.</div>';
    openModal('locationsModal');
    return;
  }
  el.innerHTML = '<div class="loading">Cargando...</div>';
  openModal('locationsModal');
  const { data, error } = await db.rpc('admin_list_working_locations');
  if (error) { el.innerHTML = `<div class="empty"><div class="ei">❌</div>${esc(error.message)}</div>`; return; }
  renderWorkingLocationsList(data || []);
}

function renderWorkingLocationsList(rows) {
  const el = document.getElementById('locationsList');
  if (!rows.length) { el.innerHTML = '<div class="empty"><div class="ei">🛒</div>Aún no hay vendedores creados</div>'; return; }
  el.innerHTML = rows.map(r => `
    <div class="ocard" style="cursor:default;">
      <div class="otop">
        <div class="oname">${esc(r.full_name)}</div>
        ${r.event_name
          ? `<span class="badge bok">📍 ${esc(r.event_name)}</span>`
          : `<span class="badge" style="background:#F3F4F6;color:#6B7280;">Sin evento seleccionado</span>`}
      </div>
    </div>`).join('');
}

async function boot(u) {
  user = u;
  const { data: pr } = await db.from('profiles').select('*').eq('id', u.id).single();
  profile = pr;

  // 🔒 Verificamos el rol via RPC SECURITY DEFINER (fuente de verdad del servidor,
  //    independiente de caché o edge cases de RLS en el cliente)
  const [{ data: isSA }, { data: isAA }] = await Promise.all([
    db.rpc('is_superadmin'),
    db.rpc('is_admin_or_above')
  ]);
  isSuperAdmin = isSA === true;
  isAdmin      = isAA === true;

  console.log('[boot] role:', pr?.role, '| isSuperAdmin:', isSuperAdmin, '| isAdmin:', isAdmin);

  document.getElementById('loginScreen').classList.add('hide');
  document.getElementById('app').classList.remove('hide');
  const roleIcon = isSuperAdmin ? ' 👑' : isAdmin ? ' ★' : '';
  document.getElementById('hdrUser').textContent = '👤 ' + (pr?.full_name || u.email.split('@')[0]) + roleIcon;
  document.getElementById('hdrDate').textContent = new Date().toLocaleDateString('es-CO',{weekday:'short',day:'numeric',month:'short'});
  if (isAdmin) document.getElementById('adminPanel').classList.remove('hide');
  if (isSuperAdmin) {
    document.getElementById('superPanel').classList.remove('hide');
    document.getElementById('btnCreateAdmin').classList.remove('hide');
  }
  applyRoleVisibility();
  await loadAll();
  subscribeRealtime();
}

// 🔒 Un vendedor ve pedidos y estados de pago, pero no los totales de dinero
// recaudado por todo el equipo — esa vista completa queda solo para
// admin/superadmin.
function applyRoleVisibility() {
  document.getElementById('navFinances')?.classList.toggle('hide', !isAdmin);
  document.getElementById('tileRecaudado')?.classList.toggle('hide', !isAdmin);
  document.getElementById('cardRecentPays')?.classList.toggle('hide', !isAdmin);
}

function subscribeRealtime() {
  if (window._demoMode) return; // skip in demo
  db.channel('ventas-live')
    .on('postgres_changes', { event:'INSERT', schema:'public', table:'orders' }, payload => {
      const row = payload.new;
      if (!event || row.event_id !== event.id) return;
      if (!orders.find(o => o.id === row.id)) {
        orders.push(row);
        renderDashboard(); renderOrders();
        toast('🔔 Nuevo pedido: ' + row.customer_name);
      }
    })
    .on('postgres_changes', { event:'DELETE', schema:'public', table:'orders' }, payload => {
      orders = orders.filter(o => o.id !== payload.old.id);
      items  = items.filter(i => i.order_id !== payload.old.id);
      renderDashboard(); renderOrders(); renderFinances();
    })
    .on('postgres_changes', { event:'INSERT', schema:'public', table:'order_items' }, payload => {
      const row = payload.new;
      // Con multi-evento concurrente, solo nos importan los ítems de pedidos
      // que pertenecen al evento que ESTA persona tiene abierto.
      const relOrder = orders.find(o => o.id === row.order_id);
      if (!relOrder) return;
      if (!items.find(i => i.id === row.id)) {
        items.push(row);
        renderDashboard(); renderFinances();
      }
    })
    .on('postgres_changes', { event:'INSERT', schema:'public', table:'payments' }, payload => {
      const row = payload.new;
      const relOrder = orders.find(o => o.id === row.order_id);
      if (!relOrder) return;
      if (!payments.find(p => p.id === row.id)) {
        payments.push(row);
        renderDashboard(); renderOrders(); renderFinances();
        toast('💰 Pago registrado por ' + row.registered_by_name);
      }
    })
    .on('postgres_changes', { event:'UPDATE', schema:'public', table:'events' }, payload => {
      const row = payload.new;
      if (!event || row.id !== event.id) return;
      const wasClosed = event.closed;
      event = row;
      setHdrEvent(event.name);
      renderDashboard(); renderOrders(); renderFinances();
      if (!wasClosed && event.closed) toast('🔒 Este evento se cerró — ya no se pueden registrar más ventas');
      if (wasClosed && !event.closed) toast('🔓 El evento fue reabierto');
    })
    .subscribe();
}

// ══════════════════════════════════════
// DATA
// ══════════════════════════════════════
async function loadAll() {
  await loadEvent();
  await loadProducts();
  await loadOrders();
  await Promise.all([loadItems(), loadPayments()]);
  renderDashboard(); renderOrders(); renderFinances();
}

async function loadEvent() {
  let data = null;
  let savedId = null;
  try { savedId = localStorage.getItem('workingEventId_' + user.id); } catch(e) {}

  if (savedId) {
    ({ data } = await db.from('events').select('*').eq('id', savedId).maybeSingle());
  }
  if (!data) {
    // Sin selección propia (o ya no existe): cae al evento activo global.
    ({ data } = await db.from('events').select('*').eq('active',true)
      .order('created_at',{ascending:false}).limit(1).maybeSingle());
  }
  event = data;
  workingEventId = data?.id || null;
  if (data) { try { localStorage.setItem('workingEventId_' + user.id, data.id); } catch(e) {} }
  setHdrEvent(data?.name);
  await syncWorkingEventToServer();
  if (!data && isAdmin) toast('ℹ️ Configura el evento desde el panel admin');
}

// 📍 Guarda en el perfil en qué evento está trabajando esta persona ahora
// mismo, para que el panel de admin "quién está en cada evento" lo vea.
async function syncWorkingEventToServer() {
  if (window._demoMode || !user) return;
  const { error } = await db.from('profiles').update({ current_event_id: workingEventId }).eq('id', user.id);
  if (error) console.warn('No se pudo sincronizar el evento de trabajo:', error.message);
}

// Cambia el evento en el que ESTA persona está trabajando (vender/ver),
// sin afectar a otros usuarios ni al "evento activo" global.
async function switchWorkingEvent(id, opts = {}) {
  const { data } = await db.from('events').select('*').eq('id', id).single();
  if (!data) { toast('❌ No se encontró ese evento'); return; }
  event = data;
  workingEventId = data.id;
  try { localStorage.setItem('workingEventId_' + user.id, data.id); } catch(e) {}
  setHdrEvent(data.name);
  await syncWorkingEventToServer();
  await loadProducts(); await loadOrders();
  await Promise.all([loadItems(), loadPayments()]);
  renderDashboard(); renderOrders(); renderFinances();
  closeModal('eventsModal');
  if (!opts.silent) toast('📍 Ahora estás trabajando en: ' + data.name);
}

async function loadProducts() {
  if (!event) { products = []; return; }
  const { data } = await db.from('products').select('*')
    .eq('event_id', event.id).eq('active', true).order('display_order');
  products = data || [];
}

async function loadOrders() {
  if (!event) { orders = []; return; }
  const { data } = await db.from('orders').select('*')
    .eq('event_id', event.id).order('created_at');
  orders = data || [];
}

async function loadItems() {
  if (!orders.length) { items = []; return; }
  const { data } = await db.from('order_items').select('*')
    .in('order_id', orders.map(o => o.id));
  items = data || [];
}

async function loadPayments() {
  if (!orders.length) { payments = []; return; }
  const { data } = await db.from('payments').select('*')
    .in('order_id', orders.map(o => o.id)).order('created_at',{ascending:false});
  payments = data || [];
  await refreshSignedUrls(); // 🔒 genera URLs firmadas para comprobantes
}

// ══════════════════════════════════════
// CIERRE DE EVENTO (meta alcanzada o cierre manual)
// ══════════════════════════════════════
function updateClosedUI() {
  const closed = !!event?.closed;
  const banner = document.getElementById('closedBanner');
  if (banner) banner.classList.toggle('hide', !closed);
  const fab = document.getElementById('fab');
  if (fab) fab.disabled = closed;
}

// Cualquier cliente que vea que ya se alcanzó la meta marca el evento como
// cerrado en la BD — así los otros 3 vendedores se enteran al instante
// (vía el UPDATE de 'events' que escucha subscribeRealtime), sin esperar
// a que un admin haga algo.
async function checkEventClosure() {
  if (!event || event.closed) return;
  const totUnits = items.reduce((s,i) => s + i.quantity, 0);
  if (totUnits < (event.goal || 100)) return;

  event.closed = true; // evita relanzar esto en el próximo render
  updateClosedUI();
  toast('🎉 ¡Meta alcanzada! Este evento ya no acepta más ventas.');
  if (window._demoMode) return;

  const { error } = await db.from('events').update({ closed:true }).eq('id', event.id);
  if (error) console.warn('No se pudo marcar el evento como cerrado:', error.message);
}

// ══════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════
function renderDashboard() {
  updateClosedUI();
  checkEventClosure();

  const totRec  = payments.reduce((s,p) => s + Number(p.amount), 0);
  const pagados = orders.filter(o => statusOf(o) === 'paid').length;
  const pend    = orders.filter(o => statusOf(o) !== 'paid').length;
  const totUnits= items.reduce((s,i) => s + i.quantity, 0);
  const metaUnd = event?.goal || 100;
  const pct     = Math.min(100, Math.round(totUnits / metaUnd * 100));

  document.getElementById('sRec').textContent = cop(totRec);
  document.getElementById('sMet').textContent = `${totUnits}/${metaUnd}`;
  document.getElementById('sPag').textContent = `${pagados}/${orders.length}`;
  document.getElementById('sPen').textContent = pend;
  document.getElementById('sPct').textContent = pct + '%';
  document.getElementById('pFill').style.width = pct + '%';

  // Product breakdown line
  const byProd = {};
  items.forEach(i => {
    const pr = products.find(p => p.id === i.product_id);
    const k = (pr?.emoji||'🛒') + ' ' + (pr?.name||'?');
    byProd[k] = (byProd[k]||0) + i.quantity;
  });
  document.getElementById('prodSummaryLine').textContent =
    Object.entries(byProd).map(([k,v]) => `${v} ${k}`).join(' · ') || 'Sin pedidos aún';

  // Recent payments
  const rec = payments.slice(0,6);
  const el = document.getElementById('recentPays');
  if (!rec.length) { el.innerHTML='<div style="color:var(--muted);font-size:14px;">Sin pagos aún.</div>'; return; }
  el.innerHTML = rec.map(p => {
    const o = orders.find(x => x.id === p.order_id);
    return `<div class="prow">
      <div>
        <div style="font-weight:700;font-size:14px;">${esc(o?.customer_name||'—')}</div>
        <div style="font-size:12px;color:var(--muted);">${ico(p.method)} ${esc(p.method)} · ${esc(p.registered_by_name)}</div>
      </div>
      <div style="font-weight:800;color:var(--ok);">${cop(p.amount)}</div>
    </div>`;
  }).join('');
}

// ══════════════════════════════════════
// ORDERS
// ══════════════════════════════════════
function renderOrders() {
  const q = (document.getElementById('searchInput')?.value||'').toLowerCase();
  let list = [...orders];
  if (filter==='pending')  list = list.filter(o => statusOf(o) !== 'paid');
  if (filter==='paid')     list = list.filter(o => statusOf(o) === 'paid');
  if (filter==='delivery') list = list.filter(o => o.needs_delivery);
  if (filter==='preventa') list = list.filter(o => o.sale_type === 'preventa' || !o.sale_type);
  if (q) list = list.filter(o => o.customer_name.toLowerCase().includes(q));
  list.sort((a,b) => ({pending:0,partial:1,paid:2}[statusOf(a)] - {pending:0,partial:1,paid:2}[statusOf(b)]));

  const el = document.getElementById('ordersList');
  if (!list.length) { el.innerHTML='<div class="empty"><div class="ei">🔍</div>Sin resultados</div>'; return; }

  el.innerHTML = list.map(o => {
    const tot=totalOf(o), paid=paidOf(o), st=statusOf(o), rem=tot-paid;
    const bl = {paid:'✓ Pagado', partial:'⋯ Parcial', pending:'⏳ Pendiente'}[st];
    const bc = {paid:'bok', partial:'bpa', pending:'bp'}[st];
    const dlvb = o.needs_delivery ? '<span class="badge bdlv" style="margin-left:6px;">🛵</span>' : '';
    const prevb = o.sale_type === 'preventa' || !o.sale_type ? '<span class="badge bprev" style="margin-left:6px;">📋 Preventa</span>' : '<span class="badge" style="background:#FFF7ED;color:#C2410C;margin-left:6px;">🏪 En evento</span>';
    return `<div class="ocard ${st}" onclick="openDetail('${esc(o.id)}')">
      <div class="otop">
        <div class="oname">${esc(o.customer_name)}</div>
        <span class="badge ${bc}">${bl}</span>
      </div>
      <div class="ometa">${esc(itemsSummary(o))}${dlvb}${prevb}</div>
      ${o.address?`<div class="ometa" style="font-size:12px;">📍 ${esc(o.address)}
        <a href="${mapsLink(o.address)}" target="_blank" rel="noopener" onclick="event.stopPropagation()"
          style="color:var(--pr);font-weight:700;text-decoration:none;">🗺️ Cómo llegar</a></div>`:''}
      <div class="ofoot">
        <div class="oamt">${cop(tot)}</div>
        ${st!=='paid'?`<div style="font-size:13px;color:var(--muted);">Debe: <strong style="color:var(--err);">${cop(rem)}</strong></div>`:''}
      </div>
    </div>`;
  }).join('');
}

function setFilter(f, btn) {
  filter = f;
  document.querySelectorAll('.ftab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active'); renderOrders();
}

// ══════════════════════════════════════
// FINANCES
// ══════════════════════════════════════
function renderFinances() {
  const totC = payments.reduce((s,p) => s + Number(p.amount), 0);
  const totM = orders.reduce((s,o) => s + totalOf(o), 0);
  document.getElementById('fCob').textContent = cop(totC);
  document.getElementById('fPen').textContent = cop(Math.max(0, totM - totC));

  // By method
  const byM = {nequi:0, efectivo:0, transferencia:0};
  payments.forEach(p => byM[p.method] = (byM[p.method]||0) + Number(p.amount));
  document.getElementById('finMeth').innerHTML = `
    <div class="frow"><span>📱 Nequi</span><span style="font-weight:800;">${cop(byM.nequi)}</span></div>
    <div class="frow"><span>💵 Efectivo</span><span style="font-weight:800;">${cop(byM.efectivo)}</span></div>
    <div class="frow"><span>🏦 Transferencia</span><span style="font-weight:800;">${cop(byM.transferencia)}</span></div>`;

  // By product
  const byProd = {};
  items.forEach(i => {
    const pr = products.find(p => p.id === i.product_id);
    const k = i.product_id;
    if (!byProd[k]) byProd[k] = { pr, qty:0, rev:0 };
    byProd[k].qty += i.quantity;
    byProd[k].rev += i.quantity * i.unit_price;
  });
  const prodRows = Object.values(byProd);
  document.getElementById('finProd').innerHTML = !prodRows.length
    ? '<div style="color:var(--muted);font-size:14px;">Sin datos.</div>'
    : prodRows.map(({ pr, qty, rev }) =>
        `<div class="frow">
          <span>${pr?.emoji||'🛒'} ${pr?.name||'?'} <span style="color:var(--muted);font-size:12px;">(${qty} uds)</span></span>
          <span style="font-weight:800;">${cop(rev)}</span>
        </div>`).join('');

  // Deliveries
  const dlvs = orders.filter(o => o.needs_delivery);
  document.getElementById('finDlv').innerHTML = !dlvs.length
    ? '<div style="color:var(--muted);font-size:14px;">Sin domicilios.</div>'
    : dlvs.map(o => {
        const st = statusOf(o), icoSt = st==='paid'?'✅':'⏳';
        return `<div class="frow" style="cursor:pointer;" onclick="openDetail('${esc(o.id)}')">
          <div>
            <div style="font-weight:700;">${icoSt} ${esc(o.customer_name)}</div>
            <div style="font-size:12px;color:var(--muted);">📍 ${esc(o.address||'Sin dirección')}</div>
            ${o.address?`<a href="${mapsLink(o.address)}" target="_blank" rel="noopener" onclick="event.stopPropagation()"
              style="font-size:12px;color:var(--pr);font-weight:700;text-decoration:none;">🗺️ Cómo llegar</a>`:''}
            ${o.phone?`<div style="font-size:12px;color:var(--muted);">📞 ${esc(o.phone)}</div>`:''}
          </div>
          <span style="font-weight:800;color:var(--pr);">${cop(totalOf(o))}</span>
        </div>`;
      }).join('');

  // All payments
  document.getElementById('finAll').innerHTML = !payments.length
    ? '<div style="color:var(--muted);font-size:14px;">Sin pagos aún.</div>'
    : payments.map(p => {
        const o = orders.find(x => x.id === p.order_id);
        const t = new Date(p.created_at).toLocaleTimeString('es-CO',{hour:'2-digit',minute:'2-digit'});
        const rUrl = receiptUrl(p);
        const th = rUrl
          ? `<img src="${esc(rUrl)}" class="thumb" onclick="event.stopPropagation();viewImg('${esc(rUrl)}')">`
          : '';
        return `<div class="prow">
          <div>
            <div style="font-weight:700;font-size:14px;">${esc(o?.customer_name||'—')}</div>
            <div style="font-size:12px;color:var(--muted);">${ico(p.method)} ${esc(p.method)} · ${esc(p.registered_by_name)} · ${t}</div>
            ${p.received_by?`<div style="font-size:12px;color:var(--muted);">Recibió: ${esc(p.received_by)}</div>`:''}
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-weight:800;color:var(--ok);">${cop(p.amount)}</span>${th}
          </div>
        </div>`;
      }).join('');
}

// ══════════════════════════════════════
// ORDER DETAIL + PAYMENT
// ══════════════════════════════════════
function openDetail(orderId) {
  const o = orders.find(x => x.id === orderId); if (!o) return;
  selMethod = null;
  const tot=totalOf(o), paid=paidOf(o), rem=tot-paid, st=statusOf(o);
  const oPays = payments.filter(p => p.order_id === orderId);

  const paysHtml = oPays.length ? `<div style="margin-bottom:18px;">
    <div style="font-weight:700;font-size:14px;margin-bottom:8px;">Pagos recibidos:</div>
    ${oPays.map(p => {
      const rUrl = receiptUrl(p);
      const th = rUrl ? `<img src="${esc(rUrl)}" class="thumb" onclick="viewImg('${esc(rUrl)}')">`:'';
      return `<div style="display:flex;justify-content:space-between;align-items:center;
        background:#F0FDF4;border-radius:10px;padding:10px 12px;margin-bottom:6px;">
        <div>
          <div style="font-weight:700;font-size:14px;">${ico(p.method)} ${esc(p.method)} — ${cop(p.amount)}</div>
          <div style="font-size:12px;color:var(--muted);">Por: ${esc(p.registered_by_name)}</div>
          ${p.received_by?`<div style="font-size:12px;color:var(--muted);">Recibió: ${esc(p.received_by)}</div>`:''}
        </div>${th}
      </div>`;
    }).join('')}</div>` : '';

  const payForm = st !== 'paid' ? `
    <div style="font-size:16px;font-weight:800;margin-bottom:12px;">Registrar pago</div>
    <div class="mgrid">
      <div class="mth" id="mt_nequi"         onclick="selMth('nequi')"><span class="mi">📱</span>Nequi</div>
      <div class="mth" id="mt_efectivo"      onclick="selMth('efectivo')"><span class="mi">💵</span>Efectivo</div>
      <div class="mth" id="mt_transferencia" onclick="selMth('transferencia')"><span class="mi">🏦</span>Transf.</div>
    </div>
    <div class="fg"><label>Valor recibido</label>
      <input type="number" id="payAmt" value="${rem}" inputmode="numeric" class="amt-in"></div>
    <div id="photoSec" class="hide">
      <div class="fg"><label>📸 Comprobante</label>
        <div class="pdrop" onclick="document.getElementById('rcFile').click()">
          <div class="pi">📷</div>
          <div class="pl">Toca para tomar foto</div>
          <div class="ps">o selecciona de la galería</div>
          <input type="file" id="rcFile" accept="image/*" capture="environment"
            style="display:none;" onchange="prevPhoto(this)">
        </div>
        <img id="rPreview" src="" onclick="viewImg(this.src)">
      </div>
    </div>
    <div id="cashSec" class="hide">
      <div class="fg"><label>¿Quién recibe el efectivo?</label>
        <input type="text" id="cashWho" value="${profile?.full_name||''}" placeholder="Nombre del vendedor"></div>
    </div>
    <button class="btn bok2" id="cnfBtn" onclick="savePayment('${orderId}', ${tot})">
      💰 Confirmar pago
    </button>` : `<div style="text-align:center;padding:24px 0;color:var(--ok);">
      <div style="font-size:52px;">✅</div>
      <div style="font-weight:800;font-size:18px;margin-top:8px;">¡Pagado completamente!</div>
    </div>`;

  const delBtn = isAdmin
    ? `<button class="btn bda" style="margin-top:10px;" onclick="deleteOrder('${orderId}')">🗑️ Eliminar pedido</button>` : '';

  const saleLabel = o.sale_type === 'en_evento'
    ? '<span class="badge" style="background:#FFF7ED;color:#C2410C;">🏪 En evento</span>'
    : '<span class="badge bprev">📋 Preventa</span>';

  const addMoreBtn = `<button class="btn" style="background:#F0FDF4;color:#166534;font-weight:700;margin-bottom:12px;"
    onclick="openAddItems('${orderId}')">➕ Agregar más productos</button>
    <div id="addItemsForm_${orderId}" class="hide"></div>`;

  // 🛵 Domicilio: se puede agregar/editar después de creado el pedido
  // (ej: una preventa que al final sí necesita entrega), y si hay dirección
  // se puede abrir directo en Google Maps para direccionarse.
  const deliveryBlock = `
    <div style="margin-bottom:12px;">
      ${o.needs_delivery ? `
        <div style="font-size:12px;color:var(--muted);margin-top:3px;">📍 ${esc(o.address||'sin dirección')}</div>
        ${o.address ? `<a href="${mapsLink(o.address)}" target="_blank" rel="noopener" class="btn"
          style="background:#EFF6FF;color:#1D4ED8;font-weight:700;text-decoration:none;margin-top:8px;">
          🗺️ Cómo llegar (Google Maps)</a>` : ''}
      ` : ''}
      <button class="btn" style="background:#FFF7ED;color:#C2410C;font-weight:700;margin-top:8px;"
        onclick="openEditDelivery('${orderId}')">${o.needs_delivery ? '✏️ Editar domicilio' : '🛵 Agregar domicilio'}</button>
      <div id="editDeliveryForm_${orderId}" class="hide"></div>
    </div>`;

  document.getElementById('payContent').innerHTML = `
    <div style="margin-bottom:16px;">
      <div style="font-size:22px;font-weight:900;">${esc(o.customer_name)}</div>
      <div style="margin-top:6px;">${saleLabel}${o.needs_delivery?`<span class="badge bdlv" style="margin-left:6px;">🛵 Domicilio</span>`:''}</div>
      <div style="color:var(--muted);font-size:14px;margin-top:6px;">${esc(itemsSummary(o))}</div>
      ${o.phone?`<div style="font-size:13px;color:var(--muted);margin-top:4px;">📞 ${esc(o.phone)}</div>`:''}
    </div>
    <div class="dsum">
      <div class="drow"><span class="dk">Total pedido</span><span>${cop(tot)}</span></div>
      <div class="drow"><span class="dk">Ya pagado</span>
        <span style="color:var(--ok);font-weight:700;">${cop(paid)}</span></div>
      <div class="drow tot"><span class="dk">Pendiente</span>
        <span style="color:${rem>0?'var(--err)':'var(--ok)'};">${cop(rem)}</span></div>
    </div>
    ${deliveryBlock}
    ${addMoreBtn}
    ${paysHtml}${payForm}${delBtn}
    <button class="btn bgh" style="margin-top:10px;" onclick="closeModal('payModal')">Cerrar</button>`;

  openModal('payModal');
}

function openEditDelivery(orderId) {
  const o = orders.find(x => x.id === orderId); if (!o) return;
  const el = document.getElementById('editDeliveryForm_' + orderId);
  if (!el) return;
  const isOpen = !el.classList.contains('hide');
  if (isOpen) { el.classList.add('hide'); return; }

  el.innerHTML = `
    <div style="background:#FFF7ED;border-radius:14px;padding:14px;margin-top:10px;">
      <div class="chkrow">
        <input type="checkbox" id="edlv_${orderId}" ${o.needs_delivery?'checked':''}
          onchange="document.getElementById('eaddr_wrap_${orderId}').classList.toggle('hide', !this.checked)">
        <label for="edlv_${orderId}">🛵 Necesita domicilio</label>
      </div>
      <div id="eaddr_wrap_${orderId}" class="fg ${o.needs_delivery?'':'hide'}" style="margin-top:10px;">
        <label>Dirección</label>
        <input type="text" id="eaddr_${orderId}" value="${esc(o.address||'')}" placeholder="Ej: Cra 5 #12-34, San Felipe">
      </div>
      <button class="btn bok2" style="margin-top:10px;" onclick="saveDeliveryEdit('${orderId}')">✅ Guardar</button>
      <button class="btn bgh" style="margin-top:8px;" onclick="document.getElementById('editDeliveryForm_${orderId}').classList.add('hide')">Cancelar</button>
    </div>`;
  el.classList.remove('hide');
}

async function saveDeliveryEdit(orderId) {
  const needsDelivery = document.getElementById('edlv_' + orderId)?.checked || false;
  const address = document.getElementById('eaddr_' + orderId)?.value.trim() || '';
  if (needsDelivery && !address) { toast('⚠️ Ingresa la dirección de entrega'); return; }

  if (window._demoMode) {
    const o = orders.find(x => x.id === orderId);
    if (o) { o.needs_delivery = needsDelivery; o.address = address; }
    toast('🧪 Demo: domicilio actualizado localmente');
    openDetail(orderId); renderOrders(); return;
  }

  const { error } = await db.from('orders')
    .update({ needs_delivery: needsDelivery, address }).eq('id', orderId);
  if (error) { toast('❌ ' + error.message); return; }

  const o = orders.find(x => x.id === orderId);
  if (o) { o.needs_delivery = needsDelivery; o.address = address; }
  toast('✅ Domicilio actualizado');
  renderOrders(); renderFinances();
  openDetail(orderId);
}

function openAddItems(orderId) {
  if (event?.closed) { toast('🔒 Este evento está cerrado, no se pueden agregar más productos.'); return; }
  const el = document.getElementById('addItemsForm_' + orderId);
  if (!el) return;
  const isOpen = !el.classList.contains('hide');
  if (isOpen) { el.classList.add('hide'); return; }

  el.innerHTML = `
    <div style="background:#F0FDF4;border-radius:14px;padding:14px;margin-bottom:12px;">
      <div style="font-weight:700;font-size:14px;margin-bottom:10px;color:#166534;">
        ➕ ¿Qué quiere agregar?
      </div>
      ${products.map(p => {
        const rem = remainingOf(p);
        const soldOut = rem <= 0;
        const maxQty = Math.min(50, isFinite(rem) ? rem : 50);
        return `
        <div class="prod-row" style="margin-bottom:8px;">
          <div class="prod-emoji">${p.emoji||'🛒'}</div>
          <div class="prod-info">
            <div class="pn">${p.name}</div>
            <div class="pp">${cop(p.price)} c/u${isFinite(rem)?` · <span style="color:${soldOut?'var(--err)':'var(--muted)'};">${soldOut?'🚫 Agotado':`Quedan ${rem}`}</span>`:''}</div>
          </div>
          <input type="number" class="prod-qty" id="addqty_${orderId}_${p.id}"
            value="0" min="0" max="${maxQty}" inputmode="numeric" ${soldOut?'disabled':''}>
        </div>`;
      }).join('')}
      <button class="btn bok2" style="margin-top:6px;"
        onclick="saveAddItems('${orderId}')">✅ Confirmar adición</button>
      <button class="btn bgh" style="margin-top:6px;"
        onclick="document.getElementById('addItemsForm_${orderId}').classList.add('hide')">Cancelar</button>
    </div>`;
  el.classList.remove('hide');
}

async function saveAddItems(orderId) {
  const newItems = products.map(p => ({
    product_id: p.id,
    quantity: Number(document.getElementById('addqty_'+orderId+'_'+p.id)?.value)||0,
    unit_price: p.price,
  })).filter(i => i.quantity > 0);

  if (!newItems.length) { toast('⚠️ Agrega al menos un producto'); return; }
  if (!window._demoMode && !(await checkStockOrToast(newItems))) return;

  if (window._demoMode) {
    newItems.forEach(i => items.push({
      id:'demo-add-'+Date.now()+'-'+i.product_id,
      order_id:orderId, ...i
    }));
    toast('🧪 Demo: ítems agregados localmente');
    openDetail(orderId); return;
  }

  const { error } = await db.from('order_items').insert(
    newItems.map(i => ({ ...i, order_id: orderId }))
  );
  if (error) { toast('❌ ' + error.message); return; }

  // Update local state
  const { data: newRows } = await db.from('order_items')
    .select('*').eq('order_id', orderId);
  if (newRows) {
    items = items.filter(i => i.order_id !== orderId);
    items.push(...newRows);
  }
  toast('✅ Productos agregados al pedido');
  renderDashboard(); renderOrders(); renderFinances();
  openDetail(orderId); // refresh detail view
}

function selMth(m) {
  selMethod = m;
  ['nequi','efectivo','transferencia'].forEach(x =>
    document.getElementById('mt_'+x)?.classList.toggle('sel', x===m));
  document.getElementById('photoSec').classList.toggle('hide', !['nequi','transferencia'].includes(m));
  document.getElementById('cashSec').classList.toggle('hide', m!=='efectivo');
}

function prevPhoto(inp) {
  const f = inp.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = e => { const img=document.getElementById('rPreview'); img.src=e.target.result; img.style.display='block'; };
  r.readAsDataURL(f);
}

async function savePayment(orderId, orderTot) {
  if (!selMethod) { toast('⚠️ Selecciona método de pago'); return; }
  const amount = Number(document.getElementById('payAmt')?.value);
  if (!amount || amount <= 0) { toast('⚠️ Ingresa un valor válido'); return; }

  const btn = document.getElementById('cnfBtn');
  btn.innerHTML = '<span class="spin"></span> Guardando...'; btn.disabled = true;

  let receiptUrl = null;
  if (['nequi','transferencia'].includes(selMethod)) {
    const file = document.getElementById('rcFile')?.files[0];
    if (file) {
      const ext = file.name.split('.').pop()||'jpg';
      const path = `${orderId}/${Date.now()}.${ext}`;
      const { error: upErr } = await db.storage.from(BUCKET).upload(path, file, {contentType:file.type});
      if (!upErr) {
        receiptUrl = path; // 🔒 guardamos el path, no la URL pública (bucket privado)
      } else toast('⚠️ Error subiendo foto');
    } else toast('ℹ️ Recuerda subir el comprobante');
  }

  const { error } = await db.from('payments').insert({
    order_id: orderId, amount, method: selMethod,
    receipt_url: receiptUrl,
    received_by: selMethod==='efectivo' ? (document.getElementById('cashWho')?.value?.trim()||'') : null,
    registered_by_id: user.id,
    registered_by_name: profile?.full_name || user.email,
  });

  if (error) { toast('❌ ' + error.message); btn.innerHTML='💰 Confirmar pago'; btn.disabled=false; return; }
  toast('✅ Pago registrado');
  closeModal('payModal');
  await loadAll();
}

async function deleteOrder(orderId) {
  if (!(await askConfirm('¿Eliminar este pedido y sus pagos? No se puede deshacer.', { title:'🗑️ Eliminar pedido', confirmLabel:'Eliminar', danger:true }))) return;
  const name = orders.find(o => o.id === orderId)?.customer_name || '';
  await db.from('order_items').delete().eq('order_id', orderId);
  await db.from('payments').delete().eq('order_id', orderId);
  const { error } = await db.from('orders').delete().eq('id', orderId);
  if (error) { toast('❌ ' + error.message); return; }
  await logAudit('order.delete', 'order', orderId, name);
  toast('🗑️ Pedido eliminado'); closeModal('payModal'); await loadAll();
}

// ══════════════════════════════════════
// ADD ORDER
// ══════════════════════════════════════
function selSaleType(type) {
  selSaleTypeVal = type;
  document.getElementById('st_preventa').classList.toggle('sel', type === 'preventa');
  document.getElementById('st_en_evento').classList.toggle('sel', type === 'en_evento');
}

function openAddOrder() {
  if (!event) { toast('⚠️ El padre debe configurar el evento primero'); return; }
  if (event.closed) { toast('🔒 Este evento está cerrado, no se pueden registrar más ventas.'); return; }
  if (!products.length) { toast('⚠️ No hay productos configurados'); return; }
  document.getElementById('nName').value='';
  document.getElementById('nPhone').value='';
  document.getElementById('nDlv').checked=false;
  document.getElementById('nAddr').value='';
  document.getElementById('nNotes').value='';
  document.getElementById('dlvFields').classList.add('hide');
  selSaleType('preventa');

  // Render product qty inputs
  document.getElementById('prodInputs').innerHTML = products.map(p => {
    const rem = remainingOf(p);
    const soldOut = rem <= 0;
    const maxQty = Math.min(100, isFinite(rem) ? rem : 100);
    return `<div class="prod-row">
      <div class="prod-emoji">${p.emoji||'🛒'}</div>
      <div class="prod-info">
        <div class="pn">${p.name}</div>
        <div class="pp">${cop(p.price)} c/u${isFinite(rem)?` · <span style="color:${soldOut?'var(--err)':'var(--muted)'};">${soldOut?'🚫 Agotado':`Quedan ${rem}`}</span>`:''}</div>
      </div>
      <input type="number" class="prod-qty" id="qty_${p.id}"
        value="0" min="0" max="${maxQty}" inputmode="numeric" oninput="calcTotal()" ${soldOut?'disabled':''}>
    </div>`;
  }).join('');

  calcTotal();
  openModal('addModal');
  setTimeout(() => document.getElementById('nName').focus(), 300);
}

function toggleDlv() {
  document.getElementById('dlvFields').classList.toggle('hide', !document.getElementById('nDlv').checked);
}

function calcTotal() {
  let tot = 0;
  products.forEach(p => {
    const el = document.getElementById('qty_'+p.id);
    if (el) tot += (Number(el.value)||0) * p.price;
  });
  document.getElementById('orderTotalDisp').textContent = cop(tot);
}

// 🎯 Recheck de stock justo antes de guardar (best-effort, sin lock de fila —
// igual de eventual-consistente que checkEventClosure()). Reduce el riesgo
// de sobreventa por dos vendedores casi simultáneos, no lo elimina del todo.
async function checkStockOrToast(orderItems) {
  for (const oi of orderItems) {
    const p = products.find(pp => pp.id === oi.product_id);
    if (!p || p.stock_limit == null) continue;
    const { data } = await db.from('order_items').select('quantity').eq('product_id', p.id);
    const sold = (data||[]).reduce((s,r)=>s+r.quantity,0);
    if (sold + oi.quantity > p.stock_limit) {
      toast(`🚫 No hay suficiente stock de "${p.name}" (quedan ${Math.max(0, p.stock_limit-sold)})`);
      return false;
    }
  }
  return true;
}

async function saveOrder() {
  const name = document.getElementById('nName').value.trim();
  if (!name) { toast('⚠️ Ingresa el nombre del cliente'); return; }

  const orderItems = products.map(p => ({
    product_id: p.id,
    quantity: Number(document.getElementById('qty_'+p.id)?.value)||0,
    unit_price: p.price,
  })).filter(i => i.quantity > 0);

  if (!orderItems.length) { toast('⚠️ Agrega al menos un producto'); return; }
  if (!(await checkStockOrToast(orderItems))) return;

  const { data: newOrder, error } = await db.from('orders').insert({
    event_id: event.id,
    customer_name: name,
    phone: document.getElementById('nPhone').value.trim(),
    needs_delivery: document.getElementById('nDlv').checked,
    address: document.getElementById('nAddr').value.trim(),
    notes: document.getElementById('nNotes').value.trim(),
    sale_type: selSaleTypeVal,
    created_by: user.id,
  }).select().single();

  if (error) { toast('❌ ' + error.message); return; }

  const { error: ie } = await db.from('order_items').insert(
    orderItems.map(i => ({ ...i, order_id: newOrder.id }))
  );
  if (ie) { toast('❌ Error en ítems: ' + ie.message); return; }

  toast('✅ Pedido guardado'); closeModal('addModal'); await loadAll();
}

// ══════════════════════════════════════
// ADMIN: EVENT + PRODUCTS
// ══════════════════════════════════════
// Refresca las vistas globales (Dashboard/Pedidos/Finanzas) solo si el
// evento en gestión es el mismo que está activo en la sesión.
async function refreshGlobalIfActive() {
  if (mgmtEventId && event && mgmtEventId === event.id) {
    await loadProducts();
    renderDashboard(); renderOrders(); renderFinances();
  }
}

function renderAdminEventBadge(ev) {
  const badge = document.getElementById('adminEventBadge');
  const btnAct = document.getElementById('btnActivateEvent');
  const btnClose = document.getElementById('btnCloseEvent');
  if (!ev) {
    badge.innerHTML = '<span class="badge" style="background:#F3F4F6;color:#6B7280;">🆕 Nuevo evento</span>';
    btnAct.classList.add('hide');
    btnClose.classList.add('hide');
    return;
  }
  badge.innerHTML = (ev.active
    ? '<span class="badge bok">✅ Evento activo</span>'
    : '<span class="badge" style="background:#F3F4F6;color:#6B7280;">📦 Archivado</span>')
    + (ev.closed ? ' <span class="badge" style="background:#FEF2F2;color:#991B1B;">🔒 Cerrado</span>' : '');
  btnAct.classList.toggle('hide', !!ev.active);
  btnClose.classList.remove('hide');
  btnClose.textContent = ev.closed ? '🔓 Reabrir evento' : '🔒 Cerrar evento (no más ventas)';
  btnClose.style.background = ev.closed ? '#F0FDF4' : '#FEF2F2';
  btnClose.style.color      = ev.closed ? '#166534' : '#991B1B';
  btnClose.style.borderColor = ev.closed ? '#86EFAC' : '#FECACA';
}

async function toggleEventClosed() {
  if (!mgmtEventId) return;
  const { data: current } = await db.from('events').select('closed').eq('id', mgmtEventId).single();
  const newClosed = !current?.closed;
  const { error } = await db.from('events').update({ closed:newClosed }).eq('id', mgmtEventId);
  if (error) { toast('❌ '+error.message); return; }
  toast(newClosed ? '🔒 Evento cerrado a nuevas ventas' : '🔓 Evento reabierto');

  const { data: fresh } = await db.from('events').select('*').eq('id', mgmtEventId).single();
  await logAudit(newClosed ? 'event.close' : 'event.reopen', 'event', mgmtEventId, fresh?.name || '');
  renderAdminEventBadge(fresh);
  if (event && mgmtEventId === event.id) {
    event.closed = newClosed;
    updateClosedUI();
    renderDashboard(); renderOrders(); renderFinances();
  }
}

// eventId: gestionar ese evento puntual. forceNew: ignora todo y abre un formulario en blanco.
async function openAdminModal(eventId, forceNew) {
  mgmtEventId = forceNew ? null : (eventId !== undefined && eventId !== null ? eventId : (event?.id || null));

  if (mgmtEventId) {
    // En demo no hay Supabase real: usamos el evento/productos ficticios en memoria.
    const ev = window._demoMode ? event : (await db.from('events').select('*').eq('id', mgmtEventId).single()).data;
    if (!ev) { toast('❌ No se encontró ese evento'); return; }
    document.getElementById('aName').value = ev.name||'';
    document.getElementById('aDate').value = ev.date||'';
    document.getElementById('aGoal').value = ev.goal||100;
    renderAdminEventBadge(ev);
    if (window._demoMode) mgmtProducts = products.slice();
    else await loadMgmtProducts();
  } else {
    document.getElementById('aName').value = '';
    document.getElementById('aDate').value = new Date().toISOString().split('T')[0];
    document.getElementById('aGoal').value = 100;
    renderAdminEventBadge(null);
    mgmtProducts = [];
  }

  renderAdminProducts();
  renderEmojiPicker('🛒');
  document.getElementById('pName').value='';
  document.getElementById('pPrice').value='';
  document.getElementById('pEmoji').value='🛒';
  document.getElementById('pEmojiDisplay').textContent='🛒';
  openModal('adminModal');
}

async function loadMgmtProducts() {
  if (!mgmtEventId) { mgmtProducts = []; return; }
  const { data } = await db.from('products').select('*')
    .eq('event_id', mgmtEventId).eq('active', true).order('display_order');
  mgmtProducts = data || [];
}

function renderAdminProducts() {
  const el = document.getElementById('adminProdList');
  if (!mgmtEventId) { el.innerHTML='<div style="color:var(--muted);font-size:13px;">Guarda el evento primero para agregar productos.</div>'; return; }
  if (!mgmtProducts.length) { el.innerHTML='<div style="color:var(--muted);font-size:13px;">Sin productos. Agrega uno abajo.</div>'; return; }
  el.innerHTML = mgmtProducts.map(p =>
    `<div class="aprod-wrap">
      <div class="aprod" id="aprod_${p.id}">
        <span class="ae">${p.emoji||'🛒'}</span>
        <span class="an">${p.name}${p.stock_limit!=null?` <span style="font-size:11px;color:var(--muted);font-weight:400;">(límite: ${p.stock_limit} uds)</span>`:''}</span>
        <div style="display:flex;align-items:center;gap:6px;">
          <span class="apr" id="aprice_${p.id}">${cop(p.price)}</span>
          <button class="btn bsm" style="background:#EFF6FF;color:#1D4ED8;padding:6px 10px;" onclick="toggleEditPrice('${p.id}')">✏️</button>
          <button class="btn bda bsm" onclick="deleteProduct('${p.id}')">🗑️</button>
        </div>
      </div>
      <div id="editPriceForm_${p.id}" class="hide"></div>
    </div>`).join('');
}

function toggleEditPrice(id) {
  const el = document.getElementById('editPriceForm_' + id);
  if (!el) return;
  const isOpen = !el.classList.contains('hide');
  if (isOpen) { el.classList.add('hide'); return; }
  const prod = mgmtProducts.find(p => p.id === id);
  if (!prod) return;
  el.innerHTML = `
    <div class="aprod-editbox">
      <input type="number" id="newPrice_${id}" value="${prod.price}" inputmode="numeric"
        onkeydown="if(event.key==='Enter')saveEditPrice('${id}')">
      <button class="btn bok2 bsm" style="padding:10px 16px;" onclick="saveEditPrice('${id}')">✅ Guardar</button>
      <button class="btn bgh bsm" style="padding:10px 16px;" onclick="document.getElementById('editPriceForm_${id}').classList.add('hide')">Cancelar</button>
    </div>`;
  el.classList.remove('hide');
  const input = document.getElementById('newPrice_' + id);
  input?.focus(); input?.select();
}

async function saveEditPrice(id) {
  const prod = mgmtProducts.find(p => p.id === id);
  const currentPrice = prod?.price;
  const price = Number(document.getElementById('newPrice_' + id)?.value);
  if (!price || price <= 0) { toast('⚠️ Precio inválido'); return; }
  const { error } = await db.from('products').update({ price }).eq('id', id);
  if (error) { toast('❌ ' + error.message); return; }
  await logAudit('product.price_change', 'product', id, prod?.name || '', { old_price: currentPrice, new_price: price });
  if (prod) prod.price = price;
  const priceEl = document.getElementById('aprice_' + id);
  if (priceEl) priceEl.textContent = cop(price);
  document.getElementById('editPriceForm_' + id)?.classList.add('hide');
  toast('✅ Precio actualizado');
  await refreshGlobalIfActive();
}

async function saveEvent() {
  const name = document.getElementById('aName').value.trim();
  const date = document.getElementById('aDate').value;
  if (!name||!date) { toast('⚠️ Completa nombre y fecha'); return; }
  const goal = Number(document.getElementById('aGoal').value)||100;

  let err;
  if (mgmtEventId) {
    // Editar un evento existente (activo o archivado) — no toca cuál está activo.
    ({error:err} = await db.from('events').update({ name, date, goal }).eq('id', mgmtEventId));
  } else {
    // Evento nuevo: archiva el que esté activo y este queda como el nuevo activo.
    await db.from('events').update({active:false}).eq('active',true);
    const { data: newRow, error: insErr } = await db.from('events')
      .insert({ name, date, goal, active:true }).select().single();
    err = insErr;
    if (!err) mgmtEventId = newRow.id;
  }
  if (err) { toast('❌ '+err.message); return; }

  toast('✅ Evento guardado');
  await loadEvent(); // el evento activo global pudo haber cambiado
  const { data: fresh } = await db.from('events').select('*').eq('id', mgmtEventId).single();
  renderAdminEventBadge(fresh);
  await loadMgmtProducts(); renderAdminProducts();
  await refreshGlobalIfActive();
  renderDashboard(); renderOrders(); renderFinances();
}

async function activateEvent() {
  if (!mgmtEventId) return;
  await db.from('events').update({active:false}).eq('active',true);
  const { error } = await db.from('events').update({active:true}).eq('id', mgmtEventId);
  if (error) { toast('❌ '+error.message); return; }
  toast('🚀 Evento activado como el predeterminado de la parroquia');
  await switchWorkingEvent(mgmtEventId, { silent:true }); // te cambia también a ti a ese evento
  await loadMgmtProducts(); renderAdminProducts();
  renderAdminEventBadge(event);
}

async function saveProduct() {
  if (!mgmtEventId) { toast('⚠️ Guarda el evento primero'); return; }
  const name  = document.getElementById('pName').value.trim();
  const price = Number(document.getElementById('pPrice').value);
  const emoji = document.getElementById('pEmoji').value.trim()||'🛒';
  const stockLimitRaw = document.getElementById('pStockLimit').value;
  const stock_limit = stockLimitRaw === '' ? null : Number(stockLimitRaw);
  if (!name||!price) { toast('⚠️ Nombre y precio son obligatorios'); return; }

  const order = mgmtProducts.length;
  const { error } = await db.from('products').insert({
    event_id: mgmtEventId, name, price, emoji, display_order: order, stock_limit,
  });
  if (error) { toast('❌ '+error.message); return; }

  document.getElementById('pName').value='';
  document.getElementById('pPrice').value='';
  document.getElementById('pStockLimit').value='';
  document.getElementById('pEmoji').value='🛒';
  document.getElementById('pEmojiDisplay').textContent='🛒';
  renderEmojiPicker('🛒');
  toast('✅ Producto agregado');
  await loadMgmtProducts(); renderAdminProducts();
  await refreshGlobalIfActive();
}

async function deleteProduct(id) {
  if (!(await askConfirm('¿Eliminar este producto?', { title:'🗑️ Eliminar producto', confirmLabel:'Eliminar', danger:true }))) return;
  const prod = mgmtProducts.find(p => p.id === id);
  const { error } = await db.from('products').update({active:false}).eq('id',id);
  if (error) { toast('❌ '+error.message); return; }
  await logAudit('product.delete', 'product', id, prod?.name || '');
  toast('🗑️ Producto eliminado');
  await loadMgmtProducts(); renderAdminProducts();
  await refreshGlobalIfActive();
}

// ══════════════════════════════════════
// EVENTOS (historial completo)
// ══════════════════════════════════════
async function openEventsModal() {
  const el = document.getElementById('eventsList');
  document.getElementById('btnNewEventFromList').classList.toggle('hide', !isAdmin);
  openModal('eventsModal');
  if (window._demoMode) { allEvents = event ? [event] : []; renderEventsList(); return; }
  el.innerHTML = '<div class="loading">Cargando...</div>';
  const { data } = await db.from('events').select('*').order('date',{ascending:false});
  allEvents = data || [];
  renderEventsList();
}

function renderEventsList() {
  const el = document.getElementById('eventsList');
  if (!allEvents.length) { el.innerHTML = '<div class="empty"><div class="ei">📅</div>Aún no has creado eventos</div>'; return; }
  el.innerHTML = allEvents.map(ev => {
    const isCurrent = ev.id === workingEventId;
    return `
    <div class="ocard" style="cursor:default;${isCurrent?'border-left-color:var(--pr);':''}">
      <div class="otop">
        <div class="oname">${esc(ev.name)}</div>
        <span>
          ${ev.active
            ? '<span class="badge bok">✅ Activo</span>'
            : '<span class="badge" style="background:#F3F4F6;color:#6B7280;">📦 Archivado</span>'}
          ${ev.closed ? ' <span class="badge" style="background:#FEF2F2;color:#991B1B;">🔒 Cerrado</span>' : ''}
        </span>
      </div>
      <div class="ometa">📅 ${esc(ev.date)} · 🎯 Meta: ${ev.goal} uds</div>
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;align-items:center;">
        ${isCurrent
          ? '<span class="badge" style="background:var(--prl);color:var(--prd);">📍 Estás aquí</span>'
          : `<button class="btn bpr bsm" onclick="switchWorkingEvent('${ev.id}')">📍 Trabajar aquí</button>`}
        ${isAdmin ? `
          <button class="btn bou bsm" onclick="closeModal('eventsModal');openAdminModal('${ev.id}')">✏️ Gestionar</button>
          <button class="btn bsm" style="background:#F0FDF4;color:#166534;" onclick="exportXLSX('${ev.id}')">📊 Excel</button>
          <button class="btn bsm" style="background:#EFF6FF;color:#1D4ED8;" onclick="exportHTML('${ev.id}')">📄 Reporte</button>
        ` : ''}
        ${isSuperAdmin ? `
          <button class="btn bda bsm" onclick="deleteEventPermanently('${ev.id}', '${esc(ev.name)}')">🗑️ Eliminar</button>
        ` : ''}
      </div>
    </div>`;
  }).join('');
}

// 🗑️ Borrado permanente — solo superadmin, y solo si el evento nunca tuvo
// pedidos (lo valida admin_delete_event() en el servidor). Si ya tiene
// historial de ventas, se debe archivar en vez de borrar.
async function deleteEventPermanently(id, name) {
  if (!(await askConfirm(`¿Eliminar por completo "${name}"? Solo funciona si nunca tuvo pedidos.`, { title:'🗑️ Eliminar evento', confirmLabel:'Eliminar', danger:true }))) return;
  const { error } = await db.rpc('admin_delete_event', { target_event_id: id });
  if (error) { toast('❌ ' + error.message); return; }
  await logAudit('event.delete', 'event', id, name);
  toast(`🗑️ Evento "${name}" eliminado`);
  await openEventsModal();
  if (event?.id === id) await loadEvent();
}

// Trae del servidor todos los datos de UN evento puntual (para exportar
// exactamente ese evento, sin depender de qué esté cargado en memoria).
async function fetchEventScopedData(id) {
  if (window._demoMode) return { event, products, orders, items, payments };
  const { data: ev } = await db.from('events').select('*').eq('id', id).single();
  if (!ev) return null;
  const { data: prods } = await db.from('products').select('*').eq('event_id', id).order('display_order');
  const { data: ords }  = await db.from('orders').select('*').eq('event_id', id).order('created_at');
  const orderIds = (ords||[]).map(o => o.id);
  let its = [], pays = [];
  if (orderIds.length) {
    const [itemsRes, paysRes] = await Promise.all([
      db.from('order_items').select('*').in('order_id', orderIds),
      db.from('payments').select('*').in('order_id', orderIds).order('created_at',{ascending:false}),
    ]);
    its  = itemsRes.data || [];
    pays = paysRes.data || [];
  }
  return { event: ev, products: prods||[], orders: ords||[], items: its, payments: pays };
}

// ══════════════════════════════════════
// EXPORT CSV
// ══════════════════════════════════════
async function exportXLSX(eventId) {
  if (!window.XLSX) { toast('⚠️ Librería Excel no cargada aún, intenta de nuevo'); return; }
  const id = eventId || event?.id;
  if (!id) { toast('⚠️ Selecciona un evento para exportar'); return; }
  const scoped = await fetchEventScopedData(id);
  if (!scoped) { toast('❌ No se pudo cargar ese evento'); return; }

  // Se opera sobre el estado global (lo reutilizan totalOf/paidOf/statusOf/itemsOf)
  // y se restaura al terminar, para no afectar el evento activo que ve el usuario.
  const backup = { event, products, orders, items, payments };
  ({ event, products, orders, items, payments } = scoped);

  // 📎 Firma los comprobantes de este evento con un link de 7 días
  // (antes se guardaba el path crudo del archivo, que no era navegable).
  const receiptLinks = {};
  const receiptPaths = [...new Set(payments.map(p => pathFromUrl(p.receipt_url)).filter(Boolean))];
  if (receiptPaths.length) toast(`⏳ Preparando ${receiptPaths.length} comprobante(s)...`);
  for (const path of receiptPaths) receiptLinks[path] = await resolveReceiptSignedUrl(path);

  const wb = XLSX.utils.book_new();

  // ── Hoja 1: Resumen ──────────────────────────────────
  const totUnits = items.reduce((s,i) => s + i.quantity, 0);
  const totCob   = payments.reduce((s,p) => s + Number(p.amount), 0);
  const totPed   = orders.reduce((s,o) => s + totalOf(o), 0);
  const resumen  = [
    ['Reporte de Ventas Parroquiales'],
    ['Evento',    event?.name || ''],
    ['Fecha',     event?.date || ''],
    ['Exportado', new Date().toLocaleString('es-CO')],
    [],
    ['Total pedidos',       orders.length],
    ['Unidades vendidas',   totUnits],
    ['Meta (unidades)',     event?.goal || 100],
    ['Total facturado',     totPed],
    ['Total cobrado',       totCob],
    ['Por cobrar',          Math.max(0, totPed - totCob)],
    ['Pagados completamente', orders.filter(o => statusOf(o) === 'paid').length],
    ['Pendientes / parciales', orders.filter(o => statusOf(o) !== 'paid').length],
    [],
    ['Nota', 'Los links de comprobante de la hoja "Pagos" vencen en 7 días. Para verlas siempre, sin internet, usa el botón "📄 Reporte" — incluye las fotos.'],
  ];
  const ws1 = XLSX.utils.aoa_to_sheet(resumen);
  ws1['!cols'] = [{wch:26},{wch:30}];
  XLSX.utils.book_append_sheet(wb, ws1, 'Resumen');

  // ── Hoja 2: Pedidos ──────────────────────────────────
  const pedHeaders = ['Cliente','Teléfono','Tipo','Productos','Domicilio','Dirección','Total','Pagado','Pendiente','Estado','Notas'];
  const pedRows = orders.map(o => {
    const tot=totalOf(o), paid=paidOf(o);
    const prods = itemsOf(o).map(i => {
      const pr = products.find(p => p.id === i.product_id);
      return `${i.quantity}x ${pr?.name||'?'}`;
    }).join(' | ');
    const st = {paid:'Pagado', partial:'Parcial', pending:'Pendiente'}[statusOf(o)];
    return [
      o.customer_name, o.phone||'', o.sale_type==='en_evento'?'En evento':'Preventa',
      prods, o.needs_delivery?'Sí':'No', o.address||'',
      tot, paid, tot-paid, st, o.notes||''
    ];
  });
  const ws2 = XLSX.utils.aoa_to_sheet([pedHeaders, ...pedRows]);
  ws2['!cols'] = [{wch:22},{wch:15},{wch:11},{wch:35},{wch:9},{wch:28},{wch:12},{wch:12},{wch:12},{wch:10},{wch:20}];
  XLSX.utils.book_append_sheet(wb, ws2, 'Pedidos');

  // ── Hoja 3: Pagos ─────────────────────────────────────
  const pagHeaders = ['Cliente','Método','Monto','Registrado por','Recibió','Fecha','Comprobante (link 7 días)'];
  const pagRows = payments.map(p => {
    const o = orders.find(x => x.id === p.order_id);
    const path = pathFromUrl(p.receipt_url);
    return [
      o?.customer_name||'', p.method, Number(p.amount),
      p.registered_by_name, p.received_by||'',
      new Date(p.created_at).toLocaleString('es-CO'),
      path ? (receiptLinks[path]||'') : ''
    ];
  });
  const ws3 = XLSX.utils.aoa_to_sheet([pagHeaders, ...pagRows]);
  ws3['!cols'] = [{wch:22},{wch:14},{wch:12},{wch:18},{wch:16},{wch:20},{wch:50}];
  XLSX.utils.book_append_sheet(wb, ws3, 'Pagos');

  // ── Hoja 4: Por producto ──────────────────────────────
  const byProd = {};
  items.forEach(i => {
    const pr = products.find(p => p.id === i.product_id);
    const k  = i.product_id;
    if (!byProd[k]) byProd[k] = { name: pr?.name||'?', qty:0, rev:0 };
    byProd[k].qty += i.quantity;
    byProd[k].rev += i.quantity * i.unit_price;
  });
  const prodHeaders = ['Producto','Unidades vendidas','Ingresos'];
  const prodRows = Object.values(byProd).map(r => [r.name, r.qty, r.rev]);
  const ws4 = XLSX.utils.aoa_to_sheet([prodHeaders, ...prodRows]);
  ws4['!cols'] = [{wch:28},{wch:18},{wch:16}];
  XLSX.utils.book_append_sheet(wb, ws4, 'Por producto');

  XLSX.writeFile(wb, `ventas-${event?.date||'export'}.xlsx`);
  toast('📊 Excel exportado');

  ({ event, products, orders, items, payments } = backup);
}

async function exportHTML(eventId) {
  const id = eventId || event?.id;
  if (!id) { toast('⚠️ Selecciona un evento para exportar'); return; }
  const scoped = await fetchEventScopedData(id);
  if (!scoped) { toast('❌ No se pudo cargar ese evento'); return; }

  const backup = { event, products, orders, items, payments };
  ({ event, products, orders, items, payments } = scoped);

  // 📎 Trae y comprime cada foto de comprobante UNA vez (por path) y la
  // incrusta como base64 — así el reporte final es un solo archivo que
  // "se lleva" las fotos: se abre en cualquier navegador, sin internet
  // y sin que un link expire.
  const embeddedImgs = {};
  const receiptPaths = [...new Set(payments.map(p => pathFromUrl(p.receipt_url)).filter(Boolean))];
  if (receiptPaths.length) {
    toast(`⏳ Incrustando ${receiptPaths.length} comprobante(s) en el reporte...`);
    for (const path of receiptPaths) {
      const signed = await resolveReceiptSignedUrl(path, 3600); // solo dura lo que tarda en generarse
      if (!signed) continue;
      const dataUri = await fetchImageAsCompressedDataUri(signed);
      if (dataUri) embeddedImgs[path] = dataUri;
    }
  }

  const now = new Date().toLocaleString('es-CO');
  const totUnits = items.reduce((s,i) => s + i.quantity, 0);
  const totCob   = payments.reduce((s,p) => s + Number(p.amount), 0);
  const totPend  = Math.max(0, orders.reduce((s,o) => s + totalOf(o), 0) - totCob);

  const orderRows = orders.map(o => {
    const tot=totalOf(o), paid=paidOf(o), rem=tot-paid, st=statusOf(o);
    const stLabel = {paid:'✅ Pagado',partial:'⋯ Parcial',pending:'⏳ Pendiente'}[st];
    const stColor = {paid:'#166534',partial:'#92400E',pending:'#991B1B'}[st];
    const stBg    = {paid:'#DCFCE7',partial:'#FEF3C7',pending:'#FEE2E2'}[st];
    const prods = itemsOf(o).map(i => {
      const pr = products.find(p=>p.id===i.product_id);
      return `${i.quantity}× ${pr?.emoji||''} ${pr?.name||'?'}`;
    }).join('<br>');
    const oPays = payments.filter(p => p.order_id === o.id);
    const paysHtml = oPays.map(p => {
      const path = pathFromUrl(p.receipt_url);
      const embedded = path ? embeddedImgs[path] : null;
      const imgHtml = embedded
        ? `<br><img src="${embedded}" style="max-width:220px;border-radius:8px;margin-top:8px;border:1px solid #e5e7eb;">`
        : (p.receipt_url ? `<br><span style="font-size:11px;color:#9CA3AF;">📎 comprobante no disponible</span>` : '');
      return `<div style="font-size:12px;margin-top:4px;color:#374151;">
        ${ico(p.method)} ${p.method} — <strong>${cop(p.amount)}</strong>
        · Por: ${p.registered_by_name}
        ${p.received_by?`· Recibió: ${p.received_by}`:''}
        ${imgHtml}
      </div>`;
    }).join('');
    const saleType = o.sale_type === 'en_evento' ? '🏪 En evento' : '📋 Preventa';
    const dlvBadge = o.needs_delivery ? ` &nbsp;🛵 <em>${o.address||'sin dir.'}</em>` : '';
    return `<tr>
      <td style="font-weight:700;">${o.customer_name}
        ${o.phone?`<br><span style="font-weight:400;font-size:12px;color:#6B7280;">📞 ${o.phone}</span>`:''}
        <br><span style="font-size:11px;color:#6B7280;">${saleType}${dlvBadge}</span>
      </td>
      <td>${prods}</td>
      <td style="text-align:right;">${cop(tot)}</td>
      <td style="text-align:right;color:#16A34A;font-weight:700;">${cop(paid)}</td>
      <td style="text-align:right;color:${rem>0?'#DC2626':'#16A34A'};font-weight:700;">${cop(rem)}</td>
      <td><span style="background:${stBg};color:${stColor};padding:3px 10px;border-radius:100px;font-size:12px;font-weight:700;">${stLabel}</span></td>
      <td>${paysHtml||'<span style="color:#9CA3AF;font-size:12px;">Sin pagos</span>'}</td>
    </tr>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>Reporte Ventas · ${event?.name||''} · ${event?.date||''}</title>
<style>
  body{font-family:-apple-system,sans-serif;padding:32px;color:#111;max-width:960px;margin:0 auto;}
  h1{color:#F97316;margin-bottom:4px;}
  .sub{color:#6B7280;font-size:14px;margin-bottom:24px;}
  .stats{display:flex;gap:16px;margin-bottom:28px;flex-wrap:wrap;}
  .stat{background:#FFF7ED;border:1px solid #FED7AA;border-radius:12px;padding:14px 20px;}
  .stat .l{font-size:11px;text-transform:uppercase;color:#92400E;font-weight:700;}
  .stat .v{font-size:22px;font-weight:900;color:#F97316;margin-top:2px;}
  table{width:100%;border-collapse:collapse;font-size:13px;}
  th{background:#F9FAFB;font-size:11px;text-transform:uppercase;letter-spacing:.5px;
     padding:10px 12px;text-align:left;border-bottom:2px solid #E5E7EB;}
  td{padding:10px 12px;border-bottom:1px solid #F3F4F6;vertical-align:top;}
  tr:hover td{background:#FFFBF5;}
  @media print{body{padding:16px;} .noprint{display:none;}}
</style>
</head>
<body>
<h1>⛪ ${event?.name||'Ventas'}</h1>
<div class="sub">Fecha del evento: ${event?.date||'–'} · Exportado: ${now}</div>
${receiptPaths.length ? `<div class="sub" style="color:#16A34A;">📎 Las fotos de los comprobantes están incrustadas en este archivo — se ven sin necesidad de internet.</div>` : ''}
<div class="stats">
  <div class="stat"><div class="l">Pedidos</div><div class="v">${orders.length}</div></div>
  <div class="stat"><div class="l">Unidades vendidas</div><div class="v">${totUnits} / ${event?.goal||100}</div></div>
  <div class="stat"><div class="l">Total cobrado</div><div class="v">${cop(totCob)}</div></div>
  <div class="stat"><div class="l">Por cobrar</div><div class="v">${cop(totPend)}</div></div>
</div>
<table>
  <thead><tr>
    <th>Cliente</th>
    <th>Productos</th>
    <th>Total</th>
    <th>Pagado</th>
    <th>Pendiente</th>
    <th>Estado</th>
    <th>Pagos y comprobantes</th>
  </tr></thead>
  <tbody>${orderRows}</tbody>
</table>
<p style="margin-top:24px;font-size:12px;color:#9CA3AF;">
  Generado por Ventas Parroquiales · ${now}
</p>
</body>
</html>`;

  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([html],{type:'text/html;charset=utf-8;'}));
  a.download = `reporte-ventas-${event?.date||'export'}.html`;
  a.click();
  toast('📄 Reporte exportado — ábrelo en el navegador para imprimir o compartir');

  ({ event, products, orders, items, payments } = backup);
}

// ══════════════════════════════════════
// NAVIGATION
// ══════════════════════════════════════
function switchView(name, btn) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nb').forEach(b => b.classList.remove('active'));
  document.getElementById('view'+name).classList.add('active');
  btn?.classList.add('active');
  document.getElementById('fab').style.display = name==='Orders' ? 'flex' : 'none';
}

// ══════════════════════════════════════
// MODALS
// ══════════════════════════════════════
function openModal(id)  { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }
document.querySelectorAll('.overlay').forEach(el => {
  el.addEventListener('click', e => { if (e.target===el) el.classList.add('hidden'); });
});

function viewImg(url) { document.getElementById('imgV').src=url; openModal('imgModal'); }

// ══════════════════════════════════════
// MINI MODAL — reemplaza confirm()/prompt() nativos del navegador con un
// diálogo del mismo estilo que el resto de la app.
// ══════════════════════════════════════
let _miniModalResolve = null;
let _miniModalIsPrompt = false;

function miniModalConfirm() {
  if (!_miniModalResolve) return;
  const resolve = _miniModalResolve; _miniModalResolve = null;
  const value = _miniModalIsPrompt ? document.getElementById('miniModalInput').value : true;
  closeModal('miniModal');
  resolve(value);
}

function miniModalCancel() {
  if (!_miniModalResolve) return;
  const resolve = _miniModalResolve; _miniModalResolve = null;
  closeModal('miniModal');
  resolve(_miniModalIsPrompt ? null : false);
}

// Reemplazo de confirm(). Uso: if (!(await askConfirm('¿Seguro?'))) return;
function askConfirm(message, { title = '¿Estás seguro?', confirmLabel = 'Confirmar', danger = false } = {}) {
  return new Promise(resolve => {
    _miniModalResolve = resolve;
    _miniModalIsPrompt = false;
    document.getElementById('miniModalTitle').textContent = title;
    document.getElementById('miniModalBody').textContent = message;
    document.getElementById('miniModalInputWrap').classList.add('hide');
    const btn = document.getElementById('miniModalConfirmBtn');
    btn.textContent = confirmLabel;
    btn.className = 'btn ' + (danger ? 'bda' : 'bok2');
    openModal('miniModal');
  });
}

// Reemplazo de prompt(). Devuelve el texto escrito, o null si se cancela.
function askPrompt(message, { title = 'Escribe un valor', defaultValue = '', placeholder = '', hint = '', confirmLabel = 'Aceptar', inputType = 'text' } = {}) {
  return new Promise(resolve => {
    _miniModalResolve = resolve;
    _miniModalIsPrompt = true;
    document.getElementById('miniModalTitle').textContent = title;
    document.getElementById('miniModalBody').textContent = message;
    document.getElementById('miniModalInputWrap').classList.remove('hide');
    document.getElementById('miniModalHint').textContent = hint;
    const input = document.getElementById('miniModalInput');
    input.type = inputType; input.value = defaultValue; input.placeholder = placeholder;
    const btn = document.getElementById('miniModalConfirmBtn');
    btn.textContent = confirmLabel;
    btn.className = 'btn bok2';
    openModal('miniModal');
    setTimeout(() => { input.focus(); input.select(); }, 150);
  });
}

// ══════════════════════════════════════
// TOAST — apiladas, con color y duración según el tipo de mensaje
// ══════════════════════════════════════
const TOAST_MAX = 4; // evita que una ráfaga de eventos en tiempo real llene la pantalla

// El tipo se detecta por el emoji con el que ya arranca cada mensaje en toda
// la app — no hay que tocar cada llamada a toast() para clasificarlas.
function toastType(msg) {
  if (/^(❌|🚫)/.test(msg)) return 'err';
  if (/^⚠️/.test(msg)) return 'warn';
  if (/^(✅|🗑️|🚀|🎉|📊|📄)/.test(msg)) return 'ok';
  return 'info';
}
const TOAST_DURATION = { err:6000, warn:4500, ok:3200, info:3200 };

function toast(msg) {
  const container = document.getElementById('toastContainer');
  while (container.children.length >= TOAST_MAX) container.firstChild.remove();

  const type = toastType(msg);
  const el = document.createElement('div');
  el.className = 'toast-item ' + type;
  el.textContent = msg;
  el.title = 'Toca para cerrar';
  const dismiss = () => { el.classList.remove('show'); setTimeout(() => el.remove(), 250); };
  el.onclick = dismiss;
  container.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(dismiss, TOAST_DURATION[type]);
}

// ══════════════════════════════════════
// KEYBOARD + SESSION
// ══════════════════════════════════════
document.getElementById('lgUser').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('lgPass').focus();});
document.getElementById('lgPass').addEventListener('keydown',e=>{if(e.key==='Enter')doLogin();});

(async()=>{
  const {data:{session}} = await db.auth.getSession();
  if (session?.user) await boot(session.user);
})();
