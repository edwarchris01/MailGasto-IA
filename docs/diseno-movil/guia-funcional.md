# Guía funcional de MailGasto IA para Android

MailGasto IA reúne ingresos y gastos que llegan como avisos bancarios y movimientos que el usuario registra a mano. Inicio resume el periodo, Movimientos muestra el detalle y Análisis permite comparar importes. El registro manual está disponible desde el primer acceso, antes de vincular un buzón.

## Marca y láminas

| Recurso | Contenido |
| --- | --- |
| [Logo completo](logo-mailgasto.png) | Arte de referencia con el sobre azul, la hoja blanca, la gráfica verde y el nombre MailGasto IA. |
| [Icono para Android](icono-mailgasto-android.png) | Variante cuadrada con fondo transparente. Usar el símbolo como base para el icono de la app y comprobar su recorte con máscaras de launcher. |
| [01 Acceso y verificación](01-acceso.png) | Inicio de sesión, registro, verificación, recuperación, enlace vencido y primer acceso. |
| [02 Resumen y análisis](02-resumen-y-analisis.png) | Inicio, gráfica comparativa, desgloses y tabla de datos, con variantes de carga, vacío y una sola serie. |
| [03 Movimientos y registro](03-movimientos.png) | Listas de ingresos y gastos, avisos, captura manual, detalles y revisión de coincidencias. |
| [04 Cuenta y asistente](04-cuenta-y-asistente.png) | Conversaciones, perfil, seguridad, Gmail y estados de vinculación. |

La interfaz usa fondo #F5F7FF, superficies blancas y texto azul noche #111A40. Las acciones principales usan azul #2945DB. Los ingresos usan verde #08785B con flecha entrante y signo positivo. Los gastos usan índigo #5140C1 con flecha saliente y signo negativo en el historial. Ámbar distingue avisos pendientes y buzones por reconectar. Rojo identifica errores y acciones destructivas. Las etiquetas de tipo, estado y origen acompañan al color.

De izquierda a derecha, la barra inferior muestra **Inicio**, **Movimientos**, **Análisis**, **Asistente** y **Perfil**. Buzones se abre desde Perfil o desde **Vincular Gmail** en el primer acceso y en Inicio si no hay un buzón activo.

## Acceso y cuenta

| Apartado | Comportamiento |
| --- | --- |
| **Iniciar sesión** | Solicita correo y contraseña. El icono del campo permite mostrar y ocultar la contraseña. **Crear cuenta** y **Olvidé mi contraseña** abren sus formularios. Una cuenta sin verificar recibe el mensaje «Verifica tu correo antes de iniciar sesión». |
| **Crear cuenta y verificar correo** | Solicita nombre, correo y contraseña de al menos 12 caracteres. Después del envío, **Verifica tu correo** muestra la dirección y los pasos para abrir el enlace, confirmar la contraseña y volver a la app. |
| **Recuperar contraseña** | Solicita el correo de acceso y presenta el mismo mensaje de confirmación para todas las solicitudes. El enlace de un solo uso abre el formulario de nueva contraseña y confirmación. Al guardar, invalidar las sesiones anteriores y volver a Iniciar sesión. Si el enlace venció, ofrecer **Solicitar otro enlace**. |
| **Primer acceso** | **Vincular Gmail** lleva a Buzones. **Más tarde** abre Inicio, donde el usuario puede registrar un movimiento. |
| **Perfil** | Muestra el nombre y el correo verificado. **Editar nombre** abre un formulario con **Guardar** y **Cancelar**. Desde aquí se llega a Buzones, Seguridad y privacidad, o **Cerrar sesión**. El cierre limpia la sesión y devuelve al acceso. |
| **Seguridad y privacidad** | Para cambiar la contraseña, solicitar la actual, la nueva y su confirmación. **Permisos de buzones** abre las conexiones y explica el acceso de lectura. **Solicitar eliminación** informa qué se elimina y envía una confirmación al correo verificado. Si existen buzones OAuth por desvincular, guiar primero a Buzones. |
| **Buzones** | Permite vincular varios Gmail. Cada tarjeta muestra la dirección, el estado y la última sincronización disponible. **Vincular Gmail** explica el permiso de solo lectura y abre Google. Al regresar, actualizar la lista si se completó la autorización, o mostrar **Vinculación cancelada** y ofrecer reintentar. **Reconectar** pide elegir el mismo buzón. **Desvincular** detiene la sincronización y conserva los registros. Outlook aparece como **Próximamente**. |

## Inicio, análisis y movimientos

### Inicio

Abre en el mes actual hasta hoy y en COP. Las tarjetas separan **Ingresos** y **Gastos**. **Balance del periodo** muestra la diferencia entre ambos importes. **Ver análisis** abre la gráfica con los mismos filtros. La tarjeta de avisos pendientes lleva a **Movimientos → Avisos** con el periodo y el estado **Pendiente**. Los movimientos recientes abren su detalle y **Registrar movimiento** abre el formulario manual.

### Análisis

La comparativa usa barras agrupadas con una escala común que empieza en cero. Ambas series muestran magnitudes positivas. Al seleccionar un intervalo, el panel inferior muestra el rango y los importes exactos. **Ver movimientos** abre Todos con ese intervalo y esa moneda. **Ver tabla** presenta los mismos intervalos y cifras que la gráfica.

Debajo se muestran **Gastos por categoría** e **Ingresos por origen de registro**, con una etiqueta y el importe en cada barra. Al tocar una categoría, abrir Gastos con esa categoría. Al tocar **Correo** o **Manual**, abrir Ingresos con ese origen. En ambos casos se conserva el periodo y la moneda.

Los filtros ofrecen **Este mes**, **Mes anterior**, **Últimos seis meses** y **Rango personalizado**. Los últimos seis meses incluyen el mes actual hasta hoy. El rango usa días de calendario de Colombia e incluye sus dos extremos. Las gráficas agrupan por día hasta 14 días, por semana de lunes a domingo entre 15 y 90 días, y por mes para rangos mayores. Cada vista usa una moneda, elegida entre COP, USD y EUR. La tabla mantiene los intervalos con valor cero para que coincidan con la gráfica.

### Movimientos y detalle

**Todos**, **Ingresos** y **Gastos** agrupan movimientos registrados por fecha descendente y permiten filtrar por periodo, moneda, categoría y origen. Cada fila muestra el importe con signo y la etiqueta **Correo** o **Manual**. **Avisos** agrupa los registros sin movimiento confirmado y ofrece filtros por periodo y estado.

Al abrir un movimiento, mostrar tipo, importe, moneda, fecha, descripción, categoría, medio de pago y origen. En avisos, mostrar el estado y los campos disponibles. Un **Pendiente** indica qué campo falta o qué dato está por confirmar y explica cómo reenviar el aviso original. **En proceso** indica que se está validando. **Error** muestra un motivo entendible cuando está disponible.

En un movimiento de correo, el detalle permite añadir o borrar una nota y cambiar la categoría de un gasto. **Corregir datos** permite corregir el monto o la fecha y restaurar cada valor original. Los valores vigentes se usan en los totales y filtros. **Historial de correcciones** muestra cada cambio de monto o fecha con sus valores anterior y nuevo y la hora de Bogotá.

### Registro manual y revisión de coincidencias

El usuario elige **Ingreso** o **Gasto**, ingresa un monto positivo, selecciona moneda y fecha y puede añadir medio de pago y descripción. En un gasto elige una categoría. Un ingreso usa la categoría **Ingresos**. El formulario parte de la moneda seleccionada y la fecha de hoy en Colombia. Si se abre desde Ingresos o Gastos, preselecciona ese tipo. Al guardar, volver al historial y actualizar Inicio, Análisis y las consultas posteriores.

Un movimiento manual se puede editar o eliminar desde su detalle. La eliminación requiere confirmación. Si existe una coincidencia entre un manual y un movimiento de correo en tipo, monto, moneda y fecha, mostrar ambos con su origen. Se cuentan como registros independientes hasta que el usuario elimine el manual. Si lo elimina, las cifras se recalculan con el movimiento de correo.

### Asistente

Permite abrir conversaciones anteriores y empezar una nueva. Sugerir preguntas como «¿Cuánto ingresó este mes?» y «Compara mis ingresos y gastos». Las respuestas muestran el periodo y la moneda consultados. Una respuesta comparativa incluye ingresos, gastos y balance del periodo, con acceso a Análisis. Si el usuario pide registrar un movimiento, ofrecer abrir el formulario manual.

## Estados y ejemplo de comprobación

- **Carga y fallo de lectura.** Mantener visibles los filtros. Mostrar indicadores de carga en las zonas que esperan datos y una acción **Reintentar** si falla la consulta.
- **Periodo vacío.** Identificar el periodo y la moneda. Ofrecer cambiar las fechas o registrar un movimiento. Si hay una sola serie, mostrar cero en la otra y conservar ambas etiquetas.
- **Totales.** Sumar solo movimientos registrados. Mantener importes enteros en unidades menores para el cálculo y mostrar los valores con formato `es-CO`. Calcular el balance por separado para cada moneda.
- **Lectura ampliada.** Permitir que campos, tarjetas y etiquetas se ajusten en varias líneas. La tabla ofrece los valores exactos con lectores de pantalla y cuando resulte más fácil recorrerlos como texto.

Las láminas comparten el ejemplo ficticio del **1 al 10 de noviembre de 2026**, en **COP**.

| Comprobación | Importe |
| --- | ---: |
| Ingresos por correo | 1.350.000 |
| Ingresos manuales | 300.000 |
| **Ingresos totales** | **1.650.000** |
| Gastos en alimentación | 220.000 |
| Gastos en transporte | 112.000 |
| Gastos en vivienda | 94.000 |
| Otros gastos | 60.000 |
| **Gastos totales** | **486.000** |
| **Balance del periodo** | **1.164.000** |

Al seleccionar el **5 de noviembre** en la gráfica, deben aparecer COP 450.000 de ingresos y COP 94.000 de gastos. **Ver movimientos** debe abrir el abono de Nequi y el servicio de hogar de ese día. El aviso pendiente del 10 de noviembre conserva «Monto por confirmar».

## Integración y pruebas Android

Flutter consulta movimientos y análisis en NestJS. PostgreSQL mantiene separados los registros manuales y los procedentes de avisos y los combina para las consultas por cuenta. El asistente usa los mismos datos. Los contratos y pasos de compilación están en la [arquitectura móvil](../arquitectura-movil-flutter.md).

**Continuar con Google** abre el navegador y solicita identidad básica. El permiso de lectura de Gmail se concede aparte desde **Buzones**. Para usar ambos flujos con Google real, el backend HTTPS necesita los clientes, las URI autorizadas y la asociación Android indicados en el [README](../../README.md).

En cada implementación Flutter, ejecutar `flutter analyze` y `flutter test`, compilar el APK e instalarlo en el teléfono físico con `adb -s SERIAL_DEL_TELEFONO install -r`. Abrir `co.com.styleplus.mailgasto/.MainActivity` mediante ADB y usar HTTPS y Android App Links para validar el retorno real desde Google.

| Recorrido en Android | Resultado esperado |
| --- | --- |
| Crear cuenta, verificar correo, iniciar sesión y recuperar acceso | El estado sin verificar, el enlace vencido y el regreso al acceso muestran la acción correspondiente. |
| Registrar ingreso y gasto sin Gmail, editar uno y eliminarlo | El historial separa los tipos. Inicio, Análisis y el Asistente reflejan los importes actualizados. |
| Procesar un aviso, revisar un pendiente y comparar una coincidencia | El registrado entra al total. El pendiente conserva su motivo. Al eliminar un duplicado manual confirmado, queda un movimiento de correo. |
| Cambiar periodo y moneda, seleccionar una barra y abrir la tabla | Gráfica, tabla e historial muestran los importes del mismo filtro. Comprobar rangos vacíos y con una sola serie. |
| Vincular Gmail, cancelar, reconectar y desvincular | La app vuelve desde Google al estado correcto y conserva el historial después de desvincular. |
| Editar nombre, cambiar contraseña y cerrar sesión | Las pantallas usan la cuenta autenticada. Validar que una segunda cuenta solo vea sus propios datos. |
| Ampliar la fuente y recorrer con TalkBack | Los controles, importes, tipos y estados se leen completos. Las gráficas tienen una tabla equivalente. |
