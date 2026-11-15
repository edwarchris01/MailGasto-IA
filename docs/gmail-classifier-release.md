# Publicación del clasificador de Gmail

NestJS recibe los avisos por OAuth y conserva una entrega hasta que n8n confirma el resultado. Al recibir un POST válido, n8n responde `202` antes de consultar Ollama. Un payload inválido recibe `400`. Las conclusiones `ignored` también cierran entregas OAuth. Si Ollama no responde o entrega JSON inválido, NestJS programa otro intento sin registrar un movimiento. Un callback repetido conserva la identidad del intento.

La migración 017 asocia la autenticación y el reenvío al intento. Reagenda las entregas que estaban en curso antes de que existieran esos datos. Las migraciones 015 y 016 habilitan Bre-B y las referencias verificadas de operación. Esas referencias se guardan como huellas por cuenta. El importe y la fecha pueden sugerir revisión, pero no bastan para conciliar copias.

## Pruebas

- Ejecutar `npm run build` y `npm test` con PostgreSQL y Mailpit aislados. Configurar `MAILGASTO_TEST_DATABASE_URL` con la base dedicada `mailgasto_test`.
- Ejecutar `node test/gmail-classifier-benchmark.mjs` contra n8n y Ollama aislados. `--case ID` permite repetir casos puntuales. Pasar `--corpus RUTA` si hay una muestra reservada en el mismo formato de etiquetas. Archivar fuera de Git los insumos y resultados por mensaje de una muestra real.
- Ejecutar `node --env-file=.env --import tsx test/n8n-mobile-e2e.ts` con n8n, Ollama, PostgreSQL y Mailpit aislados para validar OAuth, las escrituras, SMTP y los reintentos. La prueba simula Gmail.

## Publicación de n8n y reversión

1. Exportar el borrador y la versión publicada del workflow `khhwo1xLLPt3J8Vi` y guardar ambas definiciones fuera del repositorio. Generar la importación con `node n8n/workflows.mjs intake-update ACTIVO.json`. La cadena con salida estructurada es la variante predeterminada. Revisar los vínculos de credenciales, la tabla y el destino privado del callback.
2. Generar el piloto con `node n8n/benchmark.mjs --acceptance --chain --json`. El piloto usa casos sintéticos como entrada, Ollama como modelo y una salida de métricas. Su grafo carece de nodos que escriban en NestJS o en la tabla de reintentos.
3. Subir el commit a `main` para desplegar NestJS por Dokploy. Confirmar el webhook de GitHub Actions, la salud y el contrato del backend. Un callback `retry` con UUID sintético sin entrega devuelve `200` y `discarded` en el backend nuevo. Esa prueba se ejecuta por la red privada y no genera movimientos.
4. Publicar el JSON sobre el mismo workflow y comprobar la versión activa, el `202` privado y el cierre del callback. Mantener desactivados `Gmail Trigger` y `Revisar entregas pendientes`. También mantener desactivados el acceso MCP y la persistencia de ejecuciones. Ante un fallo de entrega o un autoguardado indebido, restaurar y republicar primero la versión anterior. Después, revertir el commit de NestJS si hace falta. Conservar las migraciones y los datos.

| Cambio de topología | Motivo |
| --- | --- |
| OAuth evita `Procesar avisos uno a uno` y `Continuar lote`. | Su productor envía un correo por POST. |
| Basic LLM Chain y Structured Output Parser sustituyen al AI Agent y a `consultar_reglas_aviso` en el workflow desplegable. | Las reglas aportan contexto con `ruleCheck` y comprueban por separado las citas del modelo. La variante agente queda disponible para comparar con `MAILGASTO_GMAIL_CLASSIFIER=agent`. |
| La rama directa conserva el lote, la lectura de cabeceras y la tabla de pendientes. | La cobertura OAuth de todos los buzones sigue sin confirmarse. El lote solo avanza después de resolver o conservar el pendiente. |
| La entrada OAuth añade una respuesta explícita y el callback añade un reintento temporal. | Los fallos de contrato se distinguen de los del modelo y del transporte. |

## Comparación sintética del 14 de noviembre de 2026

Las dos variantes usaron `qwen3.5:4b` en la instancia de n8n de producción. El piloto ejecutó los mismos seis casos etiquetados en lotes pequeños, sin callbacks de ingesta ni escrituras financieras. Cuatro casos llegaron al modelo. Los otros dos comprueban el rechazo explícito y el traslado propio. No se encontró una muestra independiente reservada.

| Métrica | Cadena + parser | Agente + herramienta |
| --- | ---: | ---: |
| Estados correctos | 6/6 | 2/6 |
| Precisión de autoguardado | 4/4 | Sin autoguardados |
| Cobertura de autoguardado | 4/4 | 0/4 |
| Campos correctos de movimientos | 20/20 | 0/20 |
| Descartes incorrectos | 0 | 0 |
| Respuestas que cumplen el esquema | 4/4 | 1/4 |
| Latencia p95 por aviso | 52,989 s | 47,231 s |

El agente no invocó la herramienta en estos casos. Una salida tenía JSON legible con una categoría fuera del catálogo y una propiedad adicional. En el caso de importes y fechas con roles distintos, el agente dejó el aviso en revisión. La cadena registró los cuatro recibos esperados con las citas verificadas. Las cifras describen esta muestra sintética.
