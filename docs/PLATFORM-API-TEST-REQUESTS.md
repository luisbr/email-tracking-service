# Requests de prueba de la primera iteracion

Todos los endpoints de plataforma requieren la cookie de la sesion admin actual. Los ejemplos usan una sesion ya autenticada guardada en `cookies.txt`.

## Crear cliente

```bash
curl -sS -b cookies.txt -X POST http://127.0.0.1:3010/api/platform/clients \
  -H 'Content-Type: application/json' \
  -d '{"name":"Cliente de prueba","slug":"cliente-prueba"}'
```

Respuesta esperada:

```json
{"ok":true,"client":{"id":1,"name":"Cliente de prueba","slug":"cliente-prueba","status":"active"}}
```

## Crear audiencia e importar contactos

```bash
curl -sS -b cookies.txt -X POST http://127.0.0.1:3010/api/platform/audiences \
  -H 'Content-Type: application/json' \
  -d '{"clientId":1,"name":"Audiencia de prueba"}'

curl -sS -b cookies.txt -X POST http://127.0.0.1:3010/api/platform/audiences/1/contacts/import \
  -H 'Content-Type: application/json' \
  -d '{"csv":"email,name\nana@example.test,Ana\nluis@example.test,Luis\nana@example.test,Ana duplicada"}'
```

La segunda respuesta debe indicar `received: 3`, `imported: 2` y `duplicates: 1`.

## Crear template y su segunda version

```bash
curl -sS -b cookies.txt -X POST http://127.0.0.1:3010/api/platform/templates \
  -H 'Content-Type: application/json' \
  -d '{"clientId":1,"name":"Boletin de prueba","subject":"Version 1","html":"<table><tr><td>Version 1</td></tr></table>","sourceType":"manual"}'

curl -sS -b cookies.txt -X POST http://127.0.0.1:3010/api/platform/templates/1/versions \
  -H 'Content-Type: application/json' \
  -d '{"subject":"Version 2","html":"<table><tr><td>Version 2</td></tr></table>","sourceType":"manual"}'
```

La segunda respuesta incluye `version: 2`. Use el `versionId` de la respuesta de creacion del template al crear la campana.

## Crear campaña asociada

```bash
curl -sS -b cookies.txt -X POST http://127.0.0.1:3010/api/platform/campaigns \
  -H 'Content-Type: application/json' \
  -d '{"clientId":1,"audienceId":1,"templateVersionId":1,"name":"Campana de prueba","subject":"Asunto de prueba"}'
```

La API rechaza una audiencia o version que pertenezca a otro cliente. El estado inicial siempre es `draft`.

## Verificar transición controlada

```bash
curl -sS -b cookies.txt -X PATCH http://127.0.0.1:3010/api/platform/campaigns/1/status \
  -H 'Content-Type: application/json' \
  -d '{"status":"test_ready"}'
```

`draft -> test_ready` es valido; `draft -> completed` debe responder `400`.

## Comprobar tracking histórico

```bash
curl -sS -X POST http://127.0.0.1:3010/api/email-tracking/link \
  -H 'Content-Type: application/json' \
  -d '{"email":"tracking@example.test","campaign":"Compatibilidad tracking"}'
```

Con el `token` retornado, solicitar `GET /api/email-tracking/open.gif?token=...` debe responder `200` y registrar `pixel_open`, sin requerir ninguna entidad nueva de plataforma.
