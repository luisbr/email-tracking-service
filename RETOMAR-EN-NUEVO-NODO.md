# Retomar En Nuevo Nodo

Este directorio ya deja el tracking de correo desacoplado del proyecto original.

## Qué se movió

- lógica de generación de tokens
- endpoints públicos de tracking
- export a Excel
- schema MySQL
- asset base del mailing

## Qué falta en el proyecto nuevo

1. Correr `npm install`
2. Crear `.env` desde `.env.example`
3. Crear base de datos y aplicar `db/schema.sql`
4. Confirmar el dominio final en `EMAIL_TRACKING_BASE_URL`
5. Probar:
   - `POST /api/email-tracking/link`
   - `GET /api/email-tracking/image?token=...`
   - `GET /api/email-tracking/open.gif?token=...`
   - `GET /api/email-tracking/export`

## Si luego se migra a Lambda

La frontera correcta ya quedó separada:

- `server.js` puede dividirse en handlers
- `scripts/generate-email-tracking-links.js` puede quedarse local
- `db/schema.sql` puede seguir en MySQL o migrarse a DynamoDB/RDS

## Recomendación

Primero levantarlo como Node aislado. Después, si el flujo se valida, evaluar Lambda para el endpoint público y dejar la generación CSV fuera de AWS.
