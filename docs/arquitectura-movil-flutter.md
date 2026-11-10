# Arquitectura y diseño móvil de MailGasto IA

El piloto Android permite consultar gastos registrados a partir de avisos bancarios, entender por qué un aviso quedó pendiente y vincular un buzón Gmail. La cuenta de MailGasto se verifica por correo y se usa para entrar. Outlook queda para una fase posterior con Microsoft Graph.

## Stack y responsabilidades

| Capa | Decisión |
| --- | --- |
| Plataforma | Flutter 3.41.9, Dart 3.11.5, Android API 24 mínimo, compilación y destino API 36 |
| Interfaz | Material 3, navegación con `go_router`, localización `es-CO` |
| Aplicación | MVVM por funcionalidad y Riverpod para estado e inyección |
| Datos | Repositorios sobre Dio, sesión en `flutter_secure_storage`, datos de pantalla en memoria |
| Integración Android | Navegador externo mediante `url_launcher` y retorno por Android App Links mediante `app_links` |
| Servidor | NestJS aplica autenticación y reglas de negocio, PostgreSQL persiste y n8n con Ollama procesa avisos |

La app vive en `mobile/`. Las vistas invocan comandos de sus ViewModels. Los ViewModels consumen repositorios y el cliente HTTP concentra el transporte, la cookie y la traducción de errores. Los importes se leen como centavos enteros a partir de `amount_minor`. Las fechas de calendario y las marcas de sincronización se presentan en `America/Bogota`. Las pantallas de lectura contemplan carga, vacío, error y actualización.

## Navegación y maqueta

Acceso y registro son rutas públicas. Una sesión válida abre Inicio. La barra principal tiene Inicio, Historial, Asistente y Configuración. Configuración abre Buzones y ofrece el cierre de sesión. El fondo es `#F7F9F7` y las acciones principales usan `#14532D`. Pendiente usa fondo `#FDE68A` con texto `#78350F`. Todos los avisos muestran su estado por escrito.

Los datos de esta maqueta son ficticios.

```text
┌─ Acceso ────────────────────┐  ┌─ Registro ──────────────────┐
│ MailGasto IA                 │  │ Crear cuenta                │
│ Correo                       │  │ Nombre                      │
│ Contraseña                   │  │ Correo y contraseña         │
│ [ Iniciar sesión ]           │  │ [ Registrarme ]             │
│ Crear cuenta                 │  │ Verifica tu correo          │
└──────────────────────────────┘  └─────────────────────────────┘

┌─ Inicio ────────────────────┐   ┌─ Historial ─────────────────┐
│ [ Este mes ▾ ]              │   │ Fecha ▾ Categoría ▾ Estado ▾│
│ Gastos registrados           │   │ Nequi · COP 25.000,00       │
│ COP 40.000,00                │   │ Registrado                › │
│ Alimentación · COP 25.000,00 │   │ Bancolombia · USD 12,50     │
│ Transporte · COP 15.000,00   │   │ Registrado                › │
│ [ Ver avisos pendientes ]    │   │ Nequi · Pendiente         › │
└──────────────────────────────┘   └─────────────────────────────┘

┌─ Asistente ─────────────────┐   ┌─ Buzones ───────────────────┐
│ [ Conversaciones ▾ ]        │   │ usuario@example.test        │
│ ¿Cuánto gasté en             │   │ Vinculado                   │
│ alimentación este mes?      │   │ Última sincronización       │
│ COP 25.000,00                │   │ 10/11/2026 08:30            │
│ Del 01/11/2026 al 10/11/2026 │   │ Desvincular                 │
│ [ Escribe tu pregunta   ➤ ] │   │ [ Vincular cuenta ]         │
└──────────────────────────────┘   └─────────────────────────────┘
```

Inicio ofrece este mes, mes anterior y un rango personalizado. «Ver avisos pendientes» traslada el rango a Historial y aplica el estado Pendiente. Historial conserva la moneda original, permite combinar filtros y carga páginas adicionales. Al abrir el aviso ficticio de Nequi marcado como Pendiente, el detalle muestra «Monto por confirmar» y «Datos por confirmar: monto». Buzones muestra el estado y la última sincronización disponible. El flujo de vinculación explica que el permiso es de solo lectura y se usa para identificar avisos bancarios.

## Contratos con NestJS

| Función | Contrato |
| --- | --- |
| Sesión | `POST /v1/auth/register`, `POST /v1/auth/login`, `GET /v1/auth/me`, `POST /v1/auth/logout`. La verificación usa el enlace enviado por correo. La cookie `mailgasto_session` solo viaja al origen configurado. Las escrituras incluyen el mismo `Origin`. |
| Resumen | `GET /v1/summary?from=…&to=…`. Inicio usa las filas COP de `totals` y `categories`. |
| Historial | `GET /v1/notices` admite `from`, `to`, `category`, `status`, `page` y `limit`. La respuesta incluye `items`, `page` y `hasMore`. `GET /v1/notices/:id` devuelve `unconfirmed_fields` cuando se conoce qué datos quedaron sin confirmar. Los avisos anteriores conservan su motivo general. |
| Asistente | `GET/POST /v1/chat/sessions` y `GET/POST /v1/chat/sessions/:id/messages`. El envío devuelve `{answer}`, con el importe por moneda y el rango efectivo o «Todo el historial». |
| Buzones | `GET /v1/mailboxes` devuelve el estado y `last_synced_at`. `DELETE /v1/mailboxes/:id` desvincula y conserva el historial. |
| OAuth móvil | `POST /v1/mobile/mailboxes/gmail/authorize` acepta `mailboxId` opcional y devuelve `{url}`. Google vuelve a `GET /v1/mobile/mailboxes/gmail/callback`. Flutter recibe el comprobante y envía `{receipt}` a `POST /v1/mobile/mailboxes/gmail/complete`. |

El callback valida el estado de OAuth y genera un comprobante de uso único de dos minutos. Android abre el App Link HTTPS `/mobile/gmail/return` y la app completa la operación con la sesión que la inició. NestJS mantiene el código de Google cifrado hasta el canje, conserva el verificador PKCE y almacena el token de renovación cifrado. Cerrar sesión o recibir un 401 de una ruta protegida borra la sesión local y los datos de pantalla de la cuenta.

## Desarrollo y validación Android

Desde `mobile/`, ejecutar `flutter pub get`, `flutter analyze` y `flutter test`. Iniciar el backend local según el README. Con el dispositivo autorizado, ejecutar:

```powershell
adb devices -l
adb reverse tcp:3105 tcp:3105
flutter build apk --debug --dart-define=API_BASE_URL=http://localhost:3105
adb install -r build/app/outputs/flutter-apk/app-debug.apk
adb shell am start -n co.com.styleplus.mailgasto/.MainActivity
```

El APK de depuración permite HTTP local. El APK de publicación requiere HTTPS. Para validar Google en un entorno HTTPS, registrar `/v1/mobile/mailboxes/gmail/callback` con el origen exacto en el cliente OAuth web de Google. Configurar `ANDROID_APP_LINK_SHA256` con la huella de la firma instalada para servir `/.well-known/assetlinks.json`. Compilar con ese mismo origen en `API_BASE_URL` y ajustar la propiedad Gradle `mailgastoAppLinkHost` si el host difiere de `mailgasto.styleplus.com.co`. Verificar la asociación con `adb shell pm get-app-links co.com.styleplus.mailgasto`.

La prueba automatizada en Android usa una base separada, `mailgasto_mobile`, que debe existir en el PostgreSQL local. Arrancar Mailpit con Compose y ejecutar `node --env-file=.env --import tsx test/mobile-fixtures.ts` desde la raíz. Conectar el dispositivo y ejecutar desde `mobile/`:

```powershell
adb reverse tcp:3105 tcp:3115
adb reverse tcp:8026 tcp:8026
flutter test integration_test/mobile_flow_test.dart -d <serial> --dart-define=API_BASE_URL=http://localhost:3105 --dart-define=TEST_MAILPIT_URL=http://localhost:8026
```

En cada cambio Flutter, instalar el APK y recorrer en Android el flujo afectado. La matriz del piloto incluye registro y verificación, sesión al reabrir, aislamiento de cuentas, periodos y filtros, datos pendientes, chat con y sin resultados, y vinculación, cancelación, reconexión y desvinculación de Gmail. Desplegar el backend que acepta los resultados nuevos de extracción antes de actualizar el flujo de n8n.

Referencias [Arquitectura de Flutter](https://docs.flutter.dev/app-architecture/recommendations) · [OAuth de Google](https://developers.google.com/identity/protocols/oauth2/policies) · [Android App Links](https://developer.android.com/training/app-links/verify-applinks) · [ADB](https://developer.android.com/tools/adb)
