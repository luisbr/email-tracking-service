# Email Tracking Service

Servicio Node aislado para medir aperturas de correo con una imagen trackeada y un pixel invisible.

## Qué incluye

- `POST /api/email-tracking/link` para crear un token por destinatario y campaña
- `GET /api/email-tracking/image?token=...` para servir la imagen principal y registrar apertura
- `GET /api/email-tracking/open.gif?token=...` para servir el pixel 1x1 y registrar apertura
- `GET /api/email-tracking/export` para exportar métricas en Excel
- `npm run tracking:links` para generar tokens masivamente desde un CSV local

## Estructura

- `server.js`: servicio HTTP mínimo
- `db/schema.sql`: tablas MySQL
- `scripts/generate-email-tracking-links.js`: carga local por CSV
- `public/image/060926-Mailing2_01.png`: asset base del correo

## Arranque local

```bash
npm install
cp .env.example .env
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS email_tracking"
mysql -u root -p email_tracking < db/schema.sql
mysql -u root -p email_tracking < db/migrations/001_platform_foundation.sql
mysql -u root -p email_tracking < db/migrations/002_delivery_and_assets.sql
npm run dev
```

La evolucion hacia la plataforma de campanas y la migracion compatible estan documentadas en [PLATFORM-MIGRATION-PLAN.md](docs/PLATFORM-MIGRATION-PLAN.md).

Para procesar envíos en segundo plano, ejecutar en otro proceso:

```bash
npm run worker
```

## Crear un link manual

```bash
curl -s http://127.0.0.1:3010/api/email-tracking/link \
  -H 'Content-Type: application/json' \
  -d '{
    "email":"correo@ejemplo.com",
    "campaign":"Devs-Challenge-2026"
  }'
```

Respuesta esperada:

```json
{
  "ok": true,
  "token": "…",
  "imageUrl": "http://127.0.0.1:3010/api/email-tracking/image?token=…",
  "pixelUrl": "http://127.0.0.1:3010/api/email-tracking/open.gif?token=…",
  "assetPath": "/image/060926-Mailing2_01.png"
}
```

## Generación masiva por CSV

CSV de entrada mínimo:

```csv
email,campaign
luis.buendia@gmail.com,Devs-Challenge-2026
alejandro.buendia@gmail.com,Devs-Challenge-2026
```

Comando:

```bash
npm run tracking:links -- ./destinatarios.csv ./tracking-salida.csv Devs-Challenge-2026
```

Salida:

- `email`
- `campaign`
- `token`
- `asset_path`
- `image_url`
- `pixel_url`

## HTML para el correo

```html
<img src="https://tu-dominio.com/api/email-tracking/image?token=TOKEN" alt="" width="100%" style="display:block;border:0;">
<img src="https://tu-dominio.com/api/email-tracking/open.gif?token=TOKEN" alt="" width="1" height="1" style="display:block;border:0;">
```

## Notas operativas

- Gmail y otros clientes cachean imágenes; la métrica es señal de apertura, no verdad absoluta.
- Apple Mail Privacy puede inflar aperturas.
- Si se mueve a Lambda después, conviene separar:
  - endpoint público de tracking
  - script local de generación por CSV
  - export/consulta administrativa
