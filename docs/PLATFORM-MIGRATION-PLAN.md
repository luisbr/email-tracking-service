# Plan de migracion a Email Campaign Platform

## Decision de migracion

La plataforma se construye sobre el servicio actual. No se crea un sistema de tracking paralelo ni se cambian las URLs publicas existentes. La primera iteracion agrega el modelo operativo y sus APIs; el envio SES, el worker y el editor visual quedan fuera de este corte.

## Datos que se conservan

`email_tracking_links` y `email_tracking_events` se conservan sin renombrar ni borrar columnas. Sus tokens, conteos, eventos y relaciones actuales siguen siendo la fuente para las aperturas historicas y para los endpoints publicos.

La migracion agrega `email_tracking_links.campaign_id` como campo nullable e indice. No agrega una llave foranea en este corte: permite que las filas historicas, que solo tienen el nombre de campana, sigan funcionando aunque todavia no haya una campana formal equivalente. Las filas nuevas podran asociarse gradualmente por ID.

## Modelo nuevo

```text
accounts
  users
  clients
    ses_accounts
    audiences -> audience_contacts
    templates -> template_versions
    campaigns -> assets (opcional)
```

`campaigns.template_version_id` fija exactamente el contenido usado. Las versiones son inmutables por convención de API: una correccion crea otra version en vez de sobrescribir HTML historico.

La segunda iteracion agregara `campaign_recipients` y `send_jobs`. Entonces el vinculo sera `campaign_recipient -> token -> email_tracking_links/events`, sin depender de comparar strings de campana.

## Tablas

Se mantienen:

- `email_tracking_links`
- `email_tracking_events`

Se crean en la primera iteracion:

- `accounts`, `users`, `clients`
- `ses_accounts` (estructura y credenciales cifradas, sin integracion de envio aun)
- `campaigns`
- `audiences`, `audience_contacts`
- `templates`, `template_versions`
- `assets` (catálogo y carga S3 mediante API)

La migracion esta en [001_platform_foundation.sql](/Users/osx/Documents/LBR/tracking/db/migrations/001_platform_foundation.sql). Es aditiva: se aplica despues del schema base y no elimina datos.

## Orden de implementacion

1. Aplicar `db/schema.sql` en instalaciones nuevas y despues `db/migrations/001_platform_foundation.sql`.
2. Establecer una cuenta de plataforma con `PLATFORM_DEFAULT_ACCOUNT_ID`, o permitir que se cree la cuenta inicial indicada por `PLATFORM_DEFAULT_ACCOUNT_NAME`.
3. Crear clientes, audiencias e importar sus CSVs a `audience_contacts`; desde ese momento la DB es la fuente de verdad.
4. Crear templates y su primera version; enlazar una version al crear una campana en una siguiente ampliacion del CRUD.
5. Crear `campaign_recipients`, generar tokens desde esos registros y poblar `campaign_id` en links nuevos.
6. Incorporar pruebas, aprobacion, SES, `send_jobs` y el worker recuperable.

## Compatibilidad de endpoints

Estos endpoints se conservan sin cambios:

- `POST /api/email-tracking/link`
- `GET /api/email-tracking/image?token=...`
- `GET /api/email-tracking/open.gif?token=...`
- `GET /api/email-tracking/export`
- `GET /api/admin/links`
- `GET /api/admin/links/:id/events`

## Nuevos endpoints de primera iteracion

Todos requieren la sesion admin existente:

- `GET|POST /api/platform/clients`
- `PATCH /api/platform/clients/:id`
- `GET|POST /api/platform/campaigns`
- `PATCH /api/platform/campaigns/:id/status`
- `GET|POST /api/platform/audiences`
- `DELETE /api/platform/audiences/:id`
- `POST /api/platform/audiences/:id/contacts/import` con `{ "csv": "email,name..." }`
- `GET|POST /api/platform/templates`
- `POST /api/platform/templates/:id/versions`

Los endpoints de campanas, audiencias y templates aceptan `clientId` para crear y filtrar. La importacion ignora duplicados por `audience_id + email` y actualiza `total_contacts` dentro de la misma transaccion. Las transiciones de campana se validan en backend; no se puede cambiar libremente un estado terminal.

## Archivos modificados

- `db/migrations/001_platform_foundation.sql`: estructura aditiva.
- `src/platform-repository.js`: repositorio y validaciones del primer CRUD.
- `server.js`: rutas administrativas para el modulo de plataforma; las rutas de tracking no cambian.
- `.env.example`: configuracion de la cuenta inicial.

## Limites deliberados

No hay envio masivo, SES activo, worker, pruebas, aprobacion, carga S3, IA, editor WYSIWYG ni WhatsApp en esta entrega. Las tablas dejan las relaciones necesarias preparadas sin introducir una ruta que pueda enviar correos accidentalmente.

## Estado de implementacion

Implementado en codigo:

- migracion aditiva con `accounts`, `users`, `clients`, `ses_accounts`, `campaigns`, `audiences`, `audience_contacts`, `templates`, `template_versions` y `assets`;
- `assets.client_id` obligatorio y `assets.campaign_id` nullable, para assets reutilizables del cliente;
- `campaigns.audience_id` y `campaigns.template_version_id` nullable, con validacion de pertenencia al mismo cliente en el repositorio;
- `created_by` en `campaigns`, `audiences` y `template_versions`, validado contra `users` cuando se proporciona;
- APIs administrativas para clientes, campañas, audiencias/importación CSV y templates/versiones;
- transiciones de campaña controladas exclusivamente por el backend;
- endpoints históricos de tracking sin cambios de ruta ni contrato.

## Segunda y tercera iteración implementadas

- [002_delivery_and_assets.sql](/Users/osx/Documents/LBR/tracking/db/migrations/002_delivery_and_assets.sql) crea `campaign_recipients`, `campaign_tests`, `campaign_approvals` y `send_jobs`.
- El snapshot de audiencia omite contactos que no estén `active`, evita duplicados por campaña/email y enlaza cada destinatario al token y al tracking histórico.
- `POST /api/platform/campaigns/:id/tests` realiza pruebas SES con variables de tracking; `POST /approve` exige al menos una prueba enviada; `POST /send` exige aprobación y crea un job persistente.
- [worker.js](/Users/osx/Documents/LBR/tracking/worker.js) ejecuta jobs fuera de HTTP, respeta pausa/reanudación, limita reintentos y nunca vuelve a enviar un destinatario `sent`.
- `GET /api/platform/send-jobs/:id` entrega progreso; `POST /pause` y `POST /resume` controlan el job.
- `POST /api/platform/assets` sube un archivo base64 a S3 y registra el asset para el cliente o la campaña.
- Se añadieron preview de campaña, historial de versiones, clonado de templates y `POST /api/platform/templates/:id/ai`, que utiliza la API Responses y siempre crea una versión nueva.
- `/platform` ofrece la consola web inicial para crear clientes, audiencias, templates y campañas sin terminal.

## Configuración y prueba final

Aplicar las dos migraciones, configurar MySQL, `PLATFORM_ENCRYPTION_KEY`, credenciales SES/S3 y, opcionalmente, `OPENAI_API_KEY`; iniciar la app con `npm start` y el worker con `npm run worker`. Las requests de primera iteración están en [PLATFORM-API-TEST-REQUESTS.md](/Users/osx/Documents/LBR/tracking/docs/PLATFORM-API-TEST-REQUESTS.md).

La prueba integral de SES/S3/IA no se ha ejecutado aún: depende de las credenciales locales y debe realizarse una sola vez, con destinatarios controlados, como pide el alcance.
