# Notas técnicas — Ventas Parroquiales

Este archivo responde punto por punto a la lista de pendientes que se levantó
sobre la app. Antes de tocar código se verificó el estado real (varios puntos
de "Administradores" ya estaban resueltos y la lista original quedó
desactualizada en esa parte).

## ⚠️ Antes de usar: ejecuta el SQL actualizado

Todo lo nuevo de esta pasada requiere correr de nuevo
`ventas_parroquiales_supabase.sql` en el SQL Editor de Supabase (es
idempotente — usa `IF NOT EXISTS` / `CREATE OR REPLACE`, no borra nada).
Añade la sección **v3** al final: columna `current_event_id` en `profiles`,
columna `stock_limit` en `products`, tabla `audit_log`, y las funciones
`admin_list_working_locations`, `admin_delete_event`, `log_audit`.

## 🐛 Bug encontrado y corregido: los comprobantes nunca se veían

Al revisar cómo se "traen" 50 comprobantes en un export se encontró que
`pathFromUrl()` esperaba una URL completa con `/receipts/` adentro, pero
`savePayment()` guarda `receipt_url` como un **path plano** (ej.
`"orderId/1234567890.jpg"`, sin ese texto). Resultado: la función siempre
devolvía `null`, así que **las miniaturas de comprobante nunca se mostraban
en ninguna parte de la app** (Dashboard, Finanzas, detalle de pedido) — ni
en los exports, que además usaban el path crudo directamente como si fuera
una URL navegable. Todo esto pasaba en silencio (los `<img onerror>` ocultan
la imagen rota sin avisar).

Se corrigió `pathFromUrl()` para que trate el valor guardado como lo que es
(un path), y los dos exports ahora:
- **Excel**: la columna de comprobante trae un link firmado real, válido
  7 días (antes era el path crudo, no navegable).
- **Reporte HTML**: cada foto se descarga, se comprime (JPEG, ancho máx.
  900px) y se **incrusta directamente en el archivo** como base64 — el
  reporte queda autocontenido: se abre en cualquier navegador sin
  internet y sin que ningún link expire, ideal para llevarte 50
  comprobantes de una vez para hacer cuadre de caja.

## Resuelto en esta pasada

- **Promover un vendedor a admin (o bajarlo)** — botón "⬆️ Ascender a
  admin" / "⬇️ Volver a vendedor" en el modal de Usuarios, solo visible
  para superadmin. No necesitó tabla nueva: `set_user_role()` ya servía
  para cualquier usuario existente, solo faltaba el botón.
- **Auditoría básica** — nueva tabla `audit_log` + función `log_audit()`
  (SECURITY DEFINER, toma el autor de `auth.uid()` para que no se pueda
  falsificar). Queda registrado: cerrar/reabrir/eliminar evento, cambiar
  precio, eliminar producto, eliminar pedido, y toda gestión de cuentas
  (ascender/bajar rol, desactivar/reactivar, resetear contraseña, eliminar).
  Panel "📝 Ver auditoría" en el panel de admin (últimas 100 acciones).
- **Vista financiera reducida para vendedores** — un vendedor ya no ve la
  pestaña "Finanzas" ni el total "Recaudado" ni "Últimos pagos" en el
  Dashboard. Sigue viendo el estado de cada pedido (pagado/parcial/pendiente)
  porque lo necesita para atender clientes.
  **Límite real de este cambio:** es una restricción de interfaz, no de base
  de datos — las políticas RLS de `payments` siguen permitiendo que
  cualquier vendedor autenticado lea todos los pagos (así lo requiere el
  flujo actual: un vendedor necesita ver si OTRO vendedor ya cobró un
  pedido). Restringir esto a nivel de fila rompería ese flujo compartido a
  menos que se rediseñe cómo se calcula el estado de pago (por ejemplo, con
  un campo `is_paid` calculado en el servidor en vez de sumarlo en el
  cliente). Si se necesita confidencialidad real (no solo ocultar la
  pestaña), es un cambio de diseño aparte — avisar si se quiere abordar.
- **"Quién está en cada evento"** — cada dispositivo ahora sincroniza su
  `current_event_id` al perfil cada vez que cambia de evento de trabajo.
  Panel "📍 Quién está en cada evento" en el panel de admin, vía la función
  `admin_list_working_locations()`. Es la última selección conocida de cada
  vendedor, no una sesión en vivo (no dice si está conectado ahora mismo).
- **Límite de stock por producto** — campo opcional "Límite de unidades" al
  crear un producto. Si se llena, la app deshabilita la cantidad y muestra
  "🚫 Agotado" cuando se acaba, y hace una segunda verificación contra el
  servidor justo antes de guardar el pedido. Al igual que el cierre por meta
  global del evento (que ya funcionaba así antes de esta pasada), es un
  chequeo *eventual* hecho desde el cliente, no un bloqueo con lock de fila
  en la base de datos — dos vendedores registrando el último producto en el
  mismo segundo podrían, en un caso muy raro, vender una unidad de más.
  Blindarlo del todo requeriría un trigger/lock en Postgres.
- **Borrar eventos vacíos** — un superadmin ahora puede eliminar por
  completo un evento que nunca tuvo pedidos (botón "🗑️ Eliminar" en el
  listado de Eventos). Si el evento ya tiene pedidos, el servidor rechaza el
  borrado y hay que seguir archivándolo, para no perder historial de ventas
  reales.
- **Checklist de seguridad para tablas/funciones nuevas** — quedó como
  comentario al final del `.sql`, extraído del patrón que ya usaba todo el
  archivo (RLS + GRANT + SECURITY DEFINER que valida el rol del que llama).

## Deliberadamente fuera de esta pasada (necesitan una decisión, no un parche)

- **Modo offline / cola de sincronización.** Hoy la app depende 100% de
  tener internet en el momento de guardar. Construir esto bien (cola local,
  reintentos, resolución de conflictos si dos vendedores editan lo mismo sin
  señal) es un cambio de arquitectura, no un ajuste de una función — y al
  tratarse de dinero real de un bazar, hacerlo a medias es más riesgoso que
  no tenerlo (pagos duplicados o perdidos). Si se quiere, es un proyecto
  aparte con su propio diseño.
- **Rate limits de Supabase compartidos por IP.** Es un límite de la
  infraestructura de Supabase (3 signups/hora, 5 logins/min por IP), no algo
  que la app pueda cambiar desde el código. Si el wifi de la parroquia
  concentra a muchos vendedores detrás de una sola IP pública, la única
  vía es pedir a Supabase soporte un límite más alto (plan pago) o cambiar
  a un esquema de autenticación distinto.
- **Recuperación de contraseña por el propio vendedor ("Olvidé mi
  contraseña").** Las cuentas usan usuarios ficticios (`user@parroquia.local`),
  no correos reales, así que un flujo de recuperación por email no aplica
  tal cual. Ya se resolvió el caso práctico: admin/superadmin puede
  resetear la contraseña de cualquier vendedor desde la app (no requiere
  SQL). Un self-service real necesitaría correos verdaderos o un canal
  alterno (SMS, pregunta de seguridad), que es una decisión de producto.
- **Dividir `js/app.js` (ya pasa de 1600 líneas) en módulos.** Es deuda
  técnica real, pero es un refactor mecánico de alto riesgo de regresión
  y cero valor visible para quien usa la app hoy. Vale la pena hacerlo con
  calma y con pruebas manuales de cada pantalla, no mezclado con cambios de
  funcionalidad. Ofrecerlo como tarea aparte.
- **Pruebas automatizadas.** El proyecto no tiene build ni test runner hoy
  (HTML + JS plano, sin npm). Meter pruebas implica primero decidir tooling
  (¿Vitest + jsdom? ¿Playwright para los flujos de UI?) — es una decisión de
  infraestructura que vale la pena tomar explícitamente, no colar de paso.
- **Cierre de evento por hora/fecha límite.** Quedó fuera a propósito en una
  conversación anterior; no se tocó aquí.
