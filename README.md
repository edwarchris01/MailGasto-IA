# MailGasto IA

El Gmail existente y los buzones vinculados por OAuth llegan al mismo filtro de n8n. Allí se identifican los avisos bancarios, se protege el texto y se verifica la extracción de Ollama. NestJS sincroniza los buzones OAuth y guarda los resultados en PostgreSQL junto con las notificaciones.

## Desarrollo local

Requiere Node.js 24 y Docker Compose. Copia `.env.example` a `.env`. Define `POSTGRES_PASSWORD` y una `DATABASE_URL` que coincida. Genera tres valores independientes de 32 bytes en hexadecimal para `ENCRYPTION_KEY`, `N8N_INGEST_KEY` y `N8N_AGENT_KEY`. Mantén `PUBLIC_URL` y `SMTP_URL` en sus valores locales. Deja `N8N_GMAIL_WEBHOOK_URL` y los valores de Google vacíos hasta conectar un n8n de prueba.

    npm ci
    docker compose -p mailgasto-ia-dev -f compose.yaml -f compose.dev.yaml up -d db mailpit
    npm run build
    npm start

La API aplica las migraciones al iniciar. Abre la aplicación en http://localhost:3105 y Mailpit en http://localhost:8026. `npm test` ejecuta las pruebas unitarias. Para incluir PostgreSQL y Mailpit, configura `MAILGASTO_TEST_DATABASE_URL` con una base dedicada de Compose. La integración ejecuta el código de normalización y filtro exportado a n8n y simula Gmail, el webhook y Ollama.

## Contratos internos

| Origen | Ruta | Autenticación |
| --- | --- | --- |
| NestJS | `POST /webhook/mailgasto-private-gmail` | `X-MailGasto-Agent` |
| n8n | `POST /v1/internal/gmail/results` | `X-MailGasto-Ingest` |
| NestJS | `POST /webhook/mailgasto-private-intent` | `X-MailGasto-Agent` |
| NestJS (cola anterior, hasta vaciarla) | `POST /webhook/mailgasto-private-extract` | `X-MailGasto-Agent` |
| Operador de soporte | `POST /v1/internal/account/deletion` | `X-MailGasto-Support` |

El webhook de Gmail acepta `deliveryId`, `attemptId`, `messageId`, `receivedAt`, `labels`, `from`, `subject` y `text`. Su `202` confirma la recepción. NestJS registra los IDs en `gmail_deliveries` antes de avanzar el cursor de Gmail, recupera el texto en cada intento y reenvía las entregas sin resultado. La cola guarda identificadores, no el correo.

El callback devuelve `registered`, `pending`, `error` o `ignored`. La rama OAuth conserva `deliveryId` y `attemptId`; la rama directa usa el buzón configurado con `LEGACY_GMAIL_ADDRESS` y envía `startedAt`. El resultado contiene la identidad del mensaje, proveedor, confianza y movimiento cuando aplica, sin texto del correo. Los montos viajan como cadenas de centavos. `ignored` solo cierra las entregas OAuth. NestJS responde `200` tras guardar, detectar un duplicado, cerrar un correo descartado o rechazar un resultado obsoleto. Los fallos de guardado conservan la entrega pendiente.

El historial mantiene los estados `processing` (cola previa), `registered`, `pending` y `error`. Los resúmenes y el chat siguen en `/v1/summary` y `/v1/chat/sessions`. Para una solicitud de eliminación recibida por el canal de soporte, verifica el remitente contra el correo registrado y envía `email` al endpoint interno; el titular confirma desde su sesión.

## Puesta en servicio en el servidor de n8n

1. Configura el DNS y HTTPS de `mailgasto.styleplus.com.co`. Deniega `/v1/internal/` en el proxy público y `/webhook/mailgasto-private-*` y `/webhook-test/mailgasto-private-*` en el host público de n8n. Estas rutas usan la red privada `mailgasto-integration`.
2. Configura los clientes OAuth de tipo **Aplicación web** en el proyecto Google Cloud `mailgastoia` y habilita Gmail API para la vinculación. Agrega las cuentas piloto en **Google Auth Platform → Público** si la aplicación está en pruebas. Conserva la credencial `Gmail account` de n8n para su buzón original.
3. Configura los secretos, SMTP, `LEGACY_GMAIL_ADDRESS` y los valores de OAuth en el servidor. Despliega con `docker compose -p mailgasto-ia up -d --build` y conecta n8n y el proxy a la red privada. Desde n8n, NestJS debe resolver como `mailgasto-api:3105`. Deja `N8N_GMAIL_WEBHOOK_URL` vacío hasta probar la ruta privada y publicar el flujo.
4. Asigna `Ollama account 2` a **Ollama Chat Model**, conectado a **Clasificar aviso con AI Agent** con `qwen3.5:4b`. El agente puede consultar `consultar_reglas_aviso` y tiene un límite de dos iteraciones por aviso. Un fallo del agente activa las reglas de respaldo. El flujo envía un resultado a la vez y tiene un límite de ejecución de 150 s. Crea `MailGasto Agent Header` con `X-MailGasto-Agent` para `Recibir Gmail vinculado` y `MailGasto Ingest Header` con `X-MailGasto-Ingest` para `Entregar resultado a NestJS`. Activa ambos nodos tras asignar sus credenciales.
5. Crea o reutiliza la tabla `MailGasto Gmail pendientes` en el mismo proyecto de n8n: `messageId`, `receivedAt` y `startedAt` (String), `retryAt` (Date), `attempts` (Number). Solo conserva los IDs del Gmail directo pendientes de confirmar. Copia al filtro la lista de remitentes verificados de `BANK_SENDERS_JSON`; favorece direcciones exactas y verifica cada formato con ejemplos anonimizados.
6. Ejecuta **Fetch Test Event** en el Gmail Trigger y prueba con avisos sintéticos las dos entradas, la autenticación en ambos sentidos y el guardado real. Mantén deshabilitado el guardado de ejecuciones y desactiva **Available in MCP** para el workflow con datos reales. Publica después de probar con la cuenta piloto. Configura `N8N_GMAIL_WEBHOOK_URL` con la URL privada de producción `http://n8n:5678/webhook/mailgasto-private-gmail` (ajusta el nombre interno de n8n).

`node --env-file-if-exists=.env n8n/workflows.mjs intake` genera el JSON importable. `intake-sdk` genera el SDK validable. `intake-operations <current-workflow.json>` genera cambios para el flujo existente conservando el ID del Gmail Trigger. Usa `MAILGASTO_N8N_TABLE_ID` para apuntar a la tabla por ID y `MAILGASTO_RESULTS_URL` para ajustar el destino privado de NestJS. `MAILGASTO_STAGE=1` genera un borrador con ambos nodos de comunicación con NestJS deshabilitados.

### Google para Android y web

En [Credenciales del proyecto mailgastoia](https://console.cloud.google.com/apis/credentials?project=mailgastoia), agrega las URI de redirección exactas del origen HTTPS desplegado.

| Uso | URI autorizada | Configuración del servidor |
| --- | --- | --- |
| Vincular Gmail desde web | `https://mailgasto.styleplus.com.co/v1/mailboxes/gmail/callback` | `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET` |
| Vincular Gmail desde Android | `https://mailgasto.styleplus.com.co/v1/mobile/mailboxes/gmail/callback` | El mismo cliente de Gmail, con `gmail.readonly` |
| Iniciar sesión con Google en Android | `https://mailgasto.styleplus.com.co/v1/mobile/auth/google/callback` | `GOOGLE_SIGNIN_CLIENT_ID` y `GOOGLE_SIGNIN_CLIENT_SECRET`, con `openid email profile` |

Si usas un solo cliente web, registra las tres URI en él y configura el par `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET`. El secreto vive en el backend. La app recibe un comprobante de un solo uso y lo canjea por su sesión. El acceso admite cuentas Gmail y Google Workspace con correo verificado. Una cuenta local existente solo se asocia automáticamente si su correo ya está verificado.

Publica `/.well-known/assetlinks.json` con `ANDROID_APP_LINK_SHA256` de la firma del APK instalado. Comprueba la asociación de `co.com.styleplus.mailgasto` en el teléfono con `adb shell pm get-app-links co.com.styleplus.mailgasto`. Los enlaces de retorno de Gmail y Google, recuperación de contraseña y confirmación de eliminación comparten el origen HTTPS. Consulta la [arquitectura móvil](docs/arquitectura-movil-flutter.md) y la [guía funcional](docs/diseno-movil/guia-funcional.md).

### Producción en Dokploy

El servicio `backend` de `MailGastoIA` se compila con el `Dockerfile` de `main` al recibir un evento `push`. Usa la conexión interna de PostgreSQL y el buzón `mailgastoia@styleplus.com.co` para SMTP. Guarda `DATABASE_URL`, `SMTP_URL`, `SMTP_FROM`, las credenciales de Google y las claves de aplicación en las variables de ejecución de Dokploy. Comprueba el despliegue en `GET /v1/health`.

## Validación de rendimiento

`node n8n/benchmark.mjs` genera el SDK de un piloto manual con el filtro, el agente y su herramienta. Prueba los 30 avisos con los parámetros `start` y `size` del disparador. Los casos 30 y 31 comprueban la consulta de reglas y el estado pendiente por importes contradictorios. El piloto compara monto, moneda, fecha, medio, dirección y categoría, y mide la latencia de cada aviso. La meta es más del 90 % de avisos exactos.

Registra el p95 del recorrido real desde `accepted_at` hasta `completed_at` de `notices` y mide por separado la espera del sondeo de Gmail y la entrega SMTP. El tiempo del piloto sintético solo mide la extracción en n8n. El resultado de una prueba con el modelo simulado no mide Ollama.
