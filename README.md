# ⛪ Ventas Parroquiales

Aplicación web para gestionar **pedidos y pagos en eventos parroquiales** (bazares, catedratones, ventas de comida, etc.). Permite a los vendedores registrar pedidos y pagos desde el celular en tiempo real, y a los administradores configurar el evento, los productos, las cuentas de usuario y consultar reportes financieros — todo desde el navegador, sin instalar nada.

## Tabla de contenidos

- [Características](#características)
- [Stack tecnológico](#stack-tecnológico)
- [Estructura del proyecto](#estructura-del-proyecto)
- [Cómo correr el proyecto localmente](#cómo-correr-el-proyecto-localmente)
- [Configuración de Supabase](#configuración-de-supabase)
- [Modo demo](#modo-demo)
- [Roles y permisos](#roles-y-permisos)
- [Exportes](#exportes)
- [Limitaciones conocidas](#limitaciones-conocidas)

## Características

### Para vendedores
- Login con usuario y contraseña (sin correo real).
- Registrar pedidos, tanto **preventa** como **en evento**, con o sin domicilio.
- Detección automática de emoji según el nombre del producto.
- Registrar pagos (Nequi, efectivo, transferencia) con foto del comprobante.
- Ver el estado de cada pedido (pagado / parcial / pendiente).
- Cambiar de evento de trabajo de forma independiente (cada vendedor puede estar en un evento distinto al mismo tiempo).

### Para administradores
- Configurar evento (nombre, fecha, meta de unidades) y productos (nombre, precio, ícono, límite de stock opcional).
- Cerrar/reabrir un evento a nuevas ventas (manual o automático al alcanzar la meta).
- Crear cuentas de vendedor.
- Ver finanzas completas: total recaudado, por método de pago, por producto, domicilios y todos los pagos.
- Ver quién está trabajando en cada evento (`📍 Quién está en cada evento`).
- Ver auditoría de acciones sensibles (`📝 Ver auditoría`): cierres/borrados de evento, cambios de precio, gestión de cuentas.
- Exportar el evento a Excel o a un reporte HTML autocontenido con los comprobantes incrustados.
- Eliminar eventos que nunca tuvieron pedidos.

### Para superadmin
- Todo lo anterior, más:
- Crear y gestionar cuentas de administrador.
- Ascender/degradar el rol de cualquier usuario (vendedor ↔ admin).
- Desactivar, reactivar, resetear contraseña o eliminar cualquier cuenta.

### Modo demo
Desde el login, dos botones ("🧪 Probar sin cuenta") cargan datos ficticios en memoria para explorar la interfaz como administrador o como vendedor, sin conexión real a Supabase.

## Stack tecnológico

- **Frontend:** HTML + CSS + JavaScript vanilla — sin frameworks, sin build step, sin `npm install`.
- **Backend:** [Supabase](https://supabase.com/) (Auth, Postgres, Realtime, Storage).
- **Librerías vía CDN:**
  - [`@supabase/supabase-js`](https://github.com/supabase/supabase-js) — cliente de Supabase.
  - [`xlsx`](https://github.com/SheetJS/sheetjs) — exportación de reportes a Excel.

## Estructura del proyecto

```
ventas_parroquiales/
├── index.html            # Punto de entrada: login, vistas de la app y todos los modales
├── css/
│   └── styles.css        # Estilos — mobile-first, con layout responsive para tablet/desktop
├── js/
│   └── app.js             # Lógica de la app: auth, carga de datos, render, exportes, realtime
├── .vscode/
│   └── settings.json      # Puerto de la extensión Live Server
├── NOTAS-TECNICAS.md      # Bitácora técnica: bugs corregidos, decisiones y pendientes
├── .gitignore
└── README.md
```

## Cómo correr el proyecto localmente

Es una app estática, sin build ni dependencias de Node — basta con servirla:

1. **VS Code + Live Server** (ya configurado en `.vscode/settings.json`, puerto `5502`): clic derecho sobre `index.html` → "Open with Live Server".
2. **Cualquier servidor estático**, por ejemplo:
   ```bash
   npx serve .
   # o
   python -m http.server 5502
   ```
3. Abre `http://localhost:5502` en el navegador.

> No abras `index.html` directamente con `file://` si vas a usar Supabase real — algunas APIs del navegador lo bloquean en ese contexto. El **modo demo** sí funciona sin servidor.

## Configuración de Supabase

Las credenciales del proyecto se configuran al inicio de `js/app.js`:

```js
const SUPABASE_URL      = 'https://tu-proyecto.supabase.co';
const SUPABASE_ANON_KEY = 'tu-anon-key';
const BUCKET            = 'receipts';
```

La base de datos necesita las tablas (`profiles`, `events`, `products`, `orders`, `order_items`, `payments`, `audit_log`), las políticas RLS y las funciones RPC (`is_admin_or_above`, `is_superadmin`, `set_user_role`, `admin_list_users`, `admin_set_user_banned`, `admin_reset_password`, `admin_delete_user`, `admin_list_working_locations`, `admin_delete_event`, `log_audit`) que usa `js/app.js`.

> ⚠️ **Pendiente:** `NOTAS-TECNICAS.md` referencia un script `ventas_parroquiales_supabase.sql` con todo este esquema (idempotente, con `IF NOT EXISTS` / `CREATE OR REPLACE`), pero **ese archivo no está en este repositorio**. Hace falta añadirlo para que el setup de Supabase quede completo y reproducible.

## Roles y permisos

| Rol | Puede |
|---|---|
| **Vendedor** | Registrar pedidos y pagos, ver el estado de cada pedido |
| **Admin** | Todo lo del vendedor + configurar evento/productos, crear vendedores, ver finanzas, auditoría y ubicación de vendedores |
| **Superadmin** | Todo lo del admin + crear/gestionar cuentas de administrador y cambiar roles |

Un vendedor **no ve** la pestaña Finanzas ni los totales de dinero recaudado — solo el estado de pago de cada pedido, que necesita para atender clientes.

## Exportes

- **Excel (.xlsx):** resumen de pedidos y pagos, con un link firmado (válido 7 días) a cada comprobante.
- **Reporte HTML autocontenido:** cada comprobante se descarga, se comprime y se incrusta como imagen base64 — el archivo se abre en cualquier navegador sin internet y sin links que expiren, ideal para hacer cuadre de caja con muchos comprobantes.

## Limitaciones conocidas

- **Sin modo offline:** la app depende de tener internet al momento de guardar.
- **Rate limits de Supabase por IP:** si muchos vendedores comparten la misma red/IP pública, pueden toparse con los límites de signup/login del plan gratuito.
- **Sin recuperación de contraseña self-service:** las cuentas usan usuarios ficticios (no correos reales); el reseteo de contraseña lo hace un admin/superadmin desde la app.
- **`js/app.js` es un solo archivo** (~2000 líneas), pendiente de modularizar.
- **Sin pruebas automatizadas** (no hay build ni test runner en el proyecto todavía).
- El control de stock por producto y el cierre de evento por meta son chequeos *eventuales* desde el cliente, no bloqueos a nivel de fila en la base de datos.

Para el detalle completo de bugs corregidos, decisiones de diseño y pendientes, ver [`NOTAS-TECNICAS.md`](./NOTAS-TECNICAS.md).
