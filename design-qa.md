# Validación visual de MailGasto IA en Android

Comparación de las cuatro láminas con el APK de depuración instalado mediante ADB en el teléfono físico. Se usaron datos ficticios en una API local. Las pantallas conservan los controles adicionales que ya existían en la app, como el acceso con Google y la desvinculación de un buzón por reconectar.

| Referencia | Pantallas comparadas en el teléfono |
| --- | --- |
| [01 Acceso y verificación](docs/diseno-movil/01-acceso.png) | [Acceso, registro, verificación y recuperación](C:/Users/berse/.codex/visualizations/2026/11/11/01a1cb81-36f6-7112-b6e0-be84de32f180/comparacion-01-acceso.png) |
| [02 Resumen y análisis](docs/diseno-movil/02-resumen-y-analisis.png) | [Inicio, gráfica, desgloses y tabla](C:/Users/berse/.codex/visualizations/2026/11/11/01a1cb81-36f6-7112-b6e0-be84de32f180/comparacion-02-resumen-y-analisis.png) |
| [03 Movimientos y registro](docs/diseno-movil/03-movimientos.png) | [Ingresos, gastos, avisos y captura manual](C:/Users/berse/.codex/visualizations/2026/11/11/01a1cb81-36f6-7112-b6e0-be84de32f180/comparacion-03-movimientos.png) |
| [04 Cuenta y asistente](docs/diseno-movil/04-cuenta-y-asistente.png) | [Asistente, perfil, seguridad y buzones](C:/Users/berse/.codex/visualizations/2026/11/11/01a1cb81-36f6-7112-b6e0-be84de32f180/comparacion-04-cuenta-y-asistente.png) |

El teléfono capturó a 1080 × 2400 px y 450 dpi (384 dp de ancho). Cada lámina mide 3246 × 2646 px. Para comparar, se recortó cada panel de la lámina y el área de la app en la captura, sin las barras del sistema Android. Ambos se ajustaron a 272 px de ancho sin cambiar sus proporciones.

La revisión usó el periodo activo del teléfono, del 1 al 11 de noviembre de 2026, frente al ejemplo del 1 al 10 de noviembre de las láminas. El día adicional quedó en cero. Se comprobaron COP 1.650.000 de ingresos, COP 486.000 de gastos y COP 1.164.000 de balance. El intervalo del día 5 conserva la selección en la tabla y abre solo la consignación de COP 450.000 y el servicio de hogar de COP 94.000 en Movimientos.

## Ajustes después de la primera comparación

- En [Inicio, primera pasada](C:/Users/berse/.codex/visualizations/2026/11/11/01a1cb81-36f6-7112-b6e0-be84de32f180/05-inicio-inicial.png), «500 mil» saltaba de línea y la primera fila reciente quedaba debajo del botón fijo. Se ajustaron el ancho del eje, el alto de la gráfica compacta y el espacio del aviso. En la [captura final](C:/Users/berse/.codex/visualizations/2026/11/11/01a1cb81-36f6-7112-b6e0-be84de32f180/05-inicio.png) se leen la escala y el primer movimiento.
- Los enlaces de Análisis y los importes de desgloses, historial, tabla y Asistente quedaban hacia el centro. Las capturas finales confirman que se alinean con el borde derecho y que el texto de la izquierda usa el ancho restante.
- En Buzones se colocaron las dos acciones de reconexión en una fila con el tamaño de letra normal. La [captura con fuente ampliada a 1,55](C:/Users/berse/.codex/visualizations/2026/11/11/01a1cb81-36f6-7112-b6e0-be84de32f180/19-fuente-ampliada.png) muestra cómo se apilan las acciones y se mantienen legibles las etiquetas. Se restauró la escala original.

También se revisaron el [detalle de un aviso pendiente](C:/Users/berse/.codex/visualizations/2026/11/11/01a1cb81-36f6-7112-b6e0-be84de32f180/17-aviso-detalle.png) y el [diálogo de permiso de lectura](C:/Users/berse/.codex/visualizations/2026/11/11/01a1cb81-36f6-7112-b6e0-be84de32f180/18-permiso-gmail.png). La cuenta de prueba no pasó por la autorización real de Google.

## Comprobaciones

- `flutter analyze` sin hallazgos y cinco pruebas unitarias aprobadas.
- Dos pruebas de integración en el teléfono físico con NestJS y Mailpit locales: acceso, recuperación, movimientos manuales, filtros, tabla, desgloses, asistente, perfil y buzones; y descarte y confirmación de avisos.

final result: passed
