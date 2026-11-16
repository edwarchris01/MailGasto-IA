# MailGasto IA para Android

La [arquitectura móvil](../docs/arquitectura-movil-flutter.md) contiene los contratos, la maqueta y los pasos para ejecutar la app y las pruebas con ADB.

La app actualiza movimientos, avisos y totales al volver al primer plano, abrir las pestañas de consulta y terminar una revisión de Gmail. Buzones muestra los correos en cola, en reintento y con error cuando el servidor entrega ese diagnóstico. La actualización no vuelve a registrar movimientos ni cambia los datos del usuario.

Cuando el correo confirma una entrada o salida pero no indica la fecha de la operación, el servidor puede registrar la fecha y hora de recepción. La app la identifica como estimada y permite corregir monto y fecha desde **Corregir datos**. Después de corregir la fecha conserva la recepción como referencia, sin atribuir su hora a la fecha corregida.

`flutter test test/import_refresh_test.dart` comprueba este recorrido con repositorios sintéticos. En Windows, usa `./test-android-audit.ps1 -Serial SERIAL_DEL_TELEFONO` para repetirlo en un teléfono físico. El script compila y verifica primero el paquete `co.com.styleplus.mailgasto.audit`, separado de la app principal y su sesión. El runner de integración de Flutter desinstala el paquete de prueba al finalizar, por lo que no se debe ejecutar directamente contra el paquete principal.

Para actualizar la app normal, compila con `flutter build apk --debug --target lib/main.dart` y usa `adb -s SERIAL_DEL_TELEFONO install -r build/app/outputs/flutter-apk/app-debug.apk`.

## SMS de Nequi en Android

En Perfil → SMS de Nequi, el usuario puede activar la identificación local automática desde el 1 de noviembre. Android solicita `READ_SMS` y `RECEIVE_SMS` al pulsar Activar; antes no se consulta el proveedor de SMS. No se necesitan números cortos configurados. El detector reconoce una fuente declarada Nequi por remitente, cabecera o una referencia explícita a la cuenta propia; esto no autentica al banco. Descarta localmente códigos de acceso, otros emisores y operaciones no efectivas antes de guardar o enviar candidatos.

La app registra el dispositivo con su sesión y recibe una credencial restringida a importar SMS. El token y la cola se cifran con Android Keystore; nunca se copia la sesión general al trabajador. `SMS_RECEIVED` sólo despierta un escaneo local. WorkManager conserva el trabajo al cerrar la app y reintenta envíos sin red o ante errores temporales. La fecha y `_id` del proveedor permiten recuperar mensajes nuevos; la revisión diaria y la versión del detector vuelven a evaluar casos no resueltos. Los resultados registrados y duplicados permanecen terminales. Los contadores de la pantalla corresponden al último lote enviado, no a totales financieros.

Desactivar o cerrar sesión cancela trabajos y borra la cola y la credencial local; también se solicita la revocación del dispositivo. El servidor revoca las credenciales relacionadas al cerrar sesión. Android puede aplazar trabajos y una detención forzada requiere volver a abrir la app. No se conceden permisos mediante ADB ni se alteran restricciones de batería o del instalador.

El vencimiento de la sesión de consulta no revoca el consentimiento independiente para SMS. Volver a iniciar sesión en la misma cuenta conserva ese estado, incluyendo una conexión revocada que sigue detenida. Cambiar de cuenta limpia la credencial y la cola anteriores antes de guardar la nueva sesión. Si la limpieza local falla al cerrar sesión, la app informa el error y mantiene la sesión abierta para no aparentar que detuvo un acceso que sigue activo.

Los movimientos importados tienen `source=sms`; el detalle identifica su origen y permite corregir monto y fecha conservando la fecha original. La idempotencia por SMS usa remitente, recepción y contenido; el servidor sólo une SMS y correo mediante referencias de operación explícitas, nunca por coincidencia de monto solamente.

Pruebas: `./gradlew.bat :app:testDebugUnitTest` en `android` verifica detección, exclusión de OTP, identidad y recuperación por versión/cursor. Las pruebas Flutter y el runner físico aislado incluyen activación con permisos simulados, denegación, limpieza al desactivar y corrección de un SMS sintético. No acceden a SMS reales ni conceden permisos.

Referencias oficiales: [permisos en tiempo de ejecución](https://developer.android.com/training/permissions/requesting), [excepción para broadcasts SMS](https://developer.android.com/develop/background-work/background-tasks/broadcasts/broadcast-exceptions), [reintentos de WorkManager](https://developer.android.com/develop/background-work/background-tasks/persistent/getting-started/define-work). Google Play contempla administración de dinero por SMS como excepción sujeta a declaración y revisión; la distribución actual es APK directo. [Política de SMS de Google Play](https://support.google.com/googleplay/android-developer/answer/10208820?hl=en).
