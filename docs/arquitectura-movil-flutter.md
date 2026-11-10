# Arquitectura y diseño móvil de MailGasto IA

La app Android combina ingresos y gastos importados de avisos y de registros manuales. Permite consultar gráficas, revisar avisos pendientes y gestionar los buzones Gmail. Los avisos de otros remitentes se muestran para revisión y quedan fuera del saldo. El acceso admite correo verificado con contraseña y Google. Outlook aparece como **Próximamente**.

## Stack y responsabilidades

| Capa | Decisión |
| --- | --- |
| Plataforma | Flutter 3.41.9, Dart 3.11.5, Android API 24 mínimo, compilación y destino API 36 |
| Interfaz | Material 3, navegación con `go_router`, localización `es-CO` |
| Aplicación | MVVM por funcionalidad y Riverpod para estado e inyección |
| Datos | Repositorios sobre Dio, sesión en `flutter_secure_storage`, datos de pantalla en memoria |
| Integración Android | Auth Tab para Google y Android App Links mediante `app_links` |
| Servidor | NestJS aplica autenticación y reglas de negocio, PostgreSQL persiste y n8n con Ollama procesa avisos |

La app vive en `mobile/`. Las vistas invocan comandos de sus ViewModels. Los ViewModels consumen repositorios y el cliente HTTP concentra el transporte, la cookie y la traducción de errores. Los importes se leen como centavos enteros a partir de `amount_minor`. Las fechas de calendario y las marcas de sincronización se presentan en `America/Bogota`. Las pantallas de lectura contemplan carga, vacío, error y actualización.

## Navegación y diseño

El acceso, registro y recuperación tienen rutas públicas. La sesión abre **Inicio**. La barra inferior contiene **Inicio**, **Movimientos**, **Análisis**, **Asistente** y **Perfil**. Perfil agrupa seguridad, privacidad y Buzones. Inicio muestra el acceso a Gmail cuando no hay buzón activo y permite registrar movimientos desde el primer acceso.

Las cuatro láminas y los estados se documentan en la [guía funcional](diseno-movil/guia-funcional.md). El color principal es azul `#2945DB`. Ingresos y gastos usan verde e índigo junto con etiquetas y signos.

## Contratos con NestJS

| Función | Contrato |
| --- | --- |
| Sesión | `POST /v1/auth/register`, `POST /v1/auth/login`, `GET /v1/auth/me`, `POST /v1/auth/logout`. La verificación usa el enlace enviado por correo. La cookie `mailgasto_session` solo viaja al origen configurado. Las escrituras incluyen el mismo `Origin`. |
| Movimientos | `GET /v1/movements` admite periodo, moneda, categoría, origen, dirección y paginación. `GET /v1/movements/:id` devuelve posibles coincidencias entre correo y manual. `POST` usa un `requestId` idempotente por cuenta. `PATCH` y `DELETE` por ID solo operan sobre manuales del titular. |
| Análisis | `GET /v1/analytics?from=…&to=…&currency=…` devuelve totales, balance, intervalos y desgloses en centavos representados como cadenas. `GET /v1/summary` mantiene el resumen de gastos por correo para la web. |
| Avisos | `GET /v1/notices` admite `unregistered=true` para la pestaña Avisos, además de periodo, estado y paginación. `GET /v1/notices/:id` devuelve `unconfirmed_fields` cuando se conocen. |
| Asistente | `GET/POST /v1/chat/sessions` y `GET/POST /v1/chat/sessions/:id/messages`. El envío devuelve `answer`, una acción opcional y el periodo efectivo para abrir Análisis. |
| Cuenta | `PATCH /v1/account/profile` edita el nombre. `POST /v1/account/password` exige la contraseña actual. `POST /v1/auth/password/reset` y `POST /v1/auth/password/reset/confirm` usan un enlace de un solo uso y revocan las sesiones previas al confirmar. |
| Buzones | `GET /v1/mailboxes` devuelve el estado y `last_synced_at`. `DELETE /v1/mailboxes/:id` desvincula y conserva el historial. |
| OAuth móvil | `POST /v1/mobile/mailboxes/gmail/authorize` acepta `mailboxId` opcional y devuelve `{url}`. Google vuelve a `GET /v1/mobile/mailboxes/gmail/callback`. Flutter recibe el comprobante y envía `{receipt}` a `POST /v1/mobile/mailboxes/gmail/complete`. |
| Acceso con Google | `POST /v1/mobile/auth/google/authorize` acepta el desafío del dispositivo. `GET /v1/mobile/auth/google/callback` valida la identidad y el nonce. `POST /v1/mobile/auth/google/complete` canjea el comprobante y verificador por una sesión. |

El callback valida el estado de OAuth y redirige directamente al App Link HTTPS de Gmail o del inicio de sesión. Auth Tab (Chrome 137 o posterior) entrega ese enlace a Flutter al cerrar la pestaña; los navegadores sin Auth Tab usan la asociación de Android App Links. No hay una página intermedia. El enlace lleva un comprobante de uso único de dos minutos o el resultado de cancelación o error. La app completa la vinculación con la sesión que la inició. NestJS conserva el verificador PKCE, mantiene el código de Gmail cifrado hasta el canje y almacena el token de renovación cifrado. Cerrar sesión o recibir un 401 de una ruta protegida borra la sesión local y los datos de pantalla de la cuenta.

## Desarrollo y validación Android

Desde `mobile/`, ejecutar `flutter pub get`, `flutter analyze` y `flutter test`. Iniciar el backend local según el README. Con el dispositivo autorizado, ejecutar:

```powershell
adb devices -l
$serialTelefono = 'SERIAL_DEL_TELEFONO'
adb -s $serialTelefono reverse tcp:3105 tcp:3105
flutter build apk --debug --dart-define=API_BASE_URL=http://localhost:3105
adb -s $serialTelefono install -r build/app/outputs/flutter-apk/app-debug.apk
adb -s $serialTelefono shell am start -n co.com.styleplus.mailgasto/.MainActivity
```

El APK de depuración permite HTTP local. Para probar Google real, registrar las URI HTTPS de Gmail y acceso con Google que figuran en el [README](../README.md). Configurar `ANDROID_APP_LINK_SHA256` con la huella de la firma instalada para servir `/.well-known/assetlinks.json`. Compilar con ese mismo origen en `API_BASE_URL` y ajustar la propiedad Gradle `mailgastoAppLinkHost` si el host difiere de `mailgasto.styleplus.com.co`. Verificar la asociación en el teléfono con `adb -s $serialTelefono shell pm get-app-links co.com.styleplus.mailgasto`.

La prueba automatizada en Android usa una base separada, `mailgasto_mobile`, que debe existir en el PostgreSQL local. Arrancar Mailpit con Compose y ejecutar `node --env-file=.env --import tsx test/mobile-fixtures.ts` desde la raíz. El fixture acepta `MAILGASTO_MOBILE_DATABASE_URL`, `MAILGASTO_MOBILE_TEST_PORT`, `MAILGASTO_MOBILE_SMTP_URL` y `MAILGASTO_MOBILE_AGENT_URL` para apuntar a servicios locales aislados. Conectar el teléfono físico y ejecutar desde `mobile/`:

```powershell
adb -s $serialTelefono reverse tcp:3105 tcp:3115
adb -s $serialTelefono reverse tcp:8026 tcp:8026
flutter test integration_test/mobile_flow_test.dart -d $serialTelefono --dart-define=API_BASE_URL=http://localhost:3105 --dart-define=TEST_MAILPIT_URL=http://localhost:8026
```

En cada cambio Flutter, instalar el APK y recorrer en Android el flujo afectado. La matriz del piloto incluye registro y verificación, sesión al reabrir, aislamiento de cuentas, periodos y filtros, datos pendientes, chat con y sin resultados, y vinculación, cancelación, reconexión y desvinculación de Gmail. Desplegar el backend que acepta los resultados nuevos de extracción antes de actualizar el flujo de n8n.

### E2E con n8n y Ollama

Esta prueba usa NestJS, n8n, Ollama, PostgreSQL y Mailpit reales. Solo sustituye las respuestas externas de Google y Gmail por un buzón con avisos sintéticos. El worker consulta ese buzón y usa el webhook del workflow generado; la prueba no inserta avisos ni movimientos en PostgreSQL. Verifica el monto y la moneda, la ausencia de duplicados, el descarte de correo personal, que un importe ambiguo no se registre, las notificaciones SMTP y la respuesta de Ollama. Después, Flutter consulta el mismo backend en el teléfono.

Desde la raíz, con `.env` apuntando al PostgreSQL local, prepara servicios exclusivos para la prueba:

```powershell
docker compose -p mailgasto-ia-dev -f compose.yaml -f compose.dev.yaml up -d db mailpit
docker compose -p mailgasto-ia-dev -f compose.yaml -f compose.dev.yaml exec -T db createdb -U mailgasto mailgasto_mobile_e2e
docker network create mailgasto-e2e
docker run -d --name mailgasto-e2e-n8n --network mailgasto-e2e -p 127.0.0.1:5679:5678 n8nio/n8n:2.47.3
docker run -d --name mailgasto-e2e-ollama --network mailgasto-e2e --network-alias ollama -v mailgasto-e2e-ollama-models:/root/.ollama ollama/ollama:0.24.0
docker exec mailgasto-e2e-ollama ollama pull qwen3:0.6b
$env:MAILGASTO_E2E_MODEL = 'qwen3:0.6b'
node --env-file=.env --import tsx test/n8n-mobile-e2e.ts
```

El script importa y publica los flujos en ese contenedor local, genera sus claves de prueba y deja la API escuchando en `localhost:3116`. Para probar con el modelo de producción, usa una versión de Ollama compatible con `qwen3.5:4b`, descarga ese modelo y omite `MAILGASTO_E2E_MODEL`.

Cuando el script indique `TEST_GMAIL_E2E_EMAIL`, conserva el proceso abierto y ejecuta desde `mobile/` con el serial físico:

```powershell
adb -s $serialTelefono reverse tcp:3116 tcp:3116
flutter test integration_test/gmail_pipeline_test.dart -d $serialTelefono --dart-define=API_BASE_URL=http://localhost:3116 --dart-define=TEST_GMAIL_E2E_EMAIL=CORREO_IMPRESO_POR_EL_SCRIPT
adb -s $serialTelefono reverse --remove tcp:3116
```

El piloto de Gmail real requiere un aviso recibido en el buzón autorizado después de vincularlo. Con un remitente bancario verificado puede aparecer en Movimientos; con otro remitente, comprueba que aparezca en Avisos y no cambie el saldo.

Referencias [Arquitectura de Flutter](https://docs.flutter.dev/app-architecture/recommendations) · [OAuth de Google](https://developers.google.com/identity/protocols/oauth2/policies) · [Android App Links](https://developer.android.com/training/app-links/verify-applinks) · [ADB](https://developer.android.com/tools/adb)
