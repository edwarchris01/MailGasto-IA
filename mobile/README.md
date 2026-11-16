# MailGasto IA para Android

La [arquitectura móvil](../docs/arquitectura-movil-flutter.md) contiene los contratos, la maqueta y los pasos para ejecutar la app y las pruebas con ADB.

La app actualiza movimientos, avisos y totales al volver al primer plano, abrir las pestañas de consulta y terminar una revisión de Gmail. Buzones muestra los correos en cola, en reintento y con error cuando el servidor entrega ese diagnóstico. La actualización no vuelve a registrar movimientos ni cambia los datos del usuario.

Cuando el correo confirma una entrada o salida pero no indica la fecha de la operación, el servidor puede registrar la fecha y hora de recepción. La app la identifica como estimada y permite corregir monto y fecha desde **Corregir datos**. Después de corregir la fecha conserva la recepción como referencia, sin atribuir su hora a la fecha corregida.

`flutter test test/import_refresh_test.dart` comprueba este recorrido con repositorios sintéticos. En Windows, usa `./test-android-audit.ps1 -Serial SERIAL_DEL_TELEFONO` para repetirlo en un teléfono físico. El script compila y verifica primero el paquete `co.com.styleplus.mailgasto.audit`, separado de la app principal y su sesión. El runner de integración de Flutter desinstala el paquete de prueba al finalizar, por lo que no se debe ejecutar directamente contra el paquete principal.

Para actualizar la app normal, compila con `flutter build apk --debug --target lib/main.dart` y usa `adb -s SERIAL_DEL_TELEFONO install -r build/app/outputs/flutter-apk/app-debug.apk`.
