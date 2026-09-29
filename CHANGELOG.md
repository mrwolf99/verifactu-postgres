# Cambios

Formato: [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/). Versiones: [SemVer](https://semver.org/lang/es/); mientras sea 0.x, una versión menor puede romper la compatibilidad.

## [0.1.0] — sin publicar

Primera versión.

### Añadido

- `sql/verifactu.sql`: instalación en una transacción, en el esquema `verifactu`, sin extensiones. Aborta sin dejar nada si el servidor es anterior a PostgreSQL 14, si la base no está en UTF8 o si ya está instalada.
- Tablas `verifactu.emisor` (una cadena por NIF, con su candado y su cursor) y `verifactu.registro` (altas y anulaciones).
- Huella SHA-256 según la especificación de la AEAT v0.1.2, con el núcleo de PostgreSQL (`sha256`, `convert_to`). Reproduce los tres ejemplos oficiales.
- Sellado por disparador. La base pone el seq, el NIF, la huella anterior, la hora y la huella:
  - La hora es la del servidor al sellar, en la zona del emisor, y nunca retrocede.
  - Antes de encadenar se comprueba la cola (VF007).
  - Regla de apertura por factura: VF004 y VF005.
- Sin bifurcaciones con emisiones concurrentes: candado en la fila del emisor, más `UNIQUE (emisor_id, seq)` y `UNIQUE (emisor_id, huella_anterior)`.
- Inalterabilidad en dos capas, privilegios y disparador. El disparador es `ENABLE ALWAYS` y para también al superusuario con `session_replication_role = replica`.
- API: `emitir_alta`, `emitir_anulacion`, `exportar_cadena` (JSON con los nombres de la AEAT) y `verificar_cadena` (primer eslabón roto y motivo, con ancla opcional).
- Permisos de serie: nadie salvo el propietario, ni siquiera roles con privilegios por defecto.
- `js/verifactu.mjs` y `js/verifactu.d.ts`: helper sin dependencias. Calcula la cadena y la huella y verifica una exportación. Funciona en Node 18 o posterior, en Deno y en navegadores.
- 17 pruebas y 10 sabotajes (`node test/run.mjs`, `node test/run.mjs --sabotajes`) sobre un clúster desechable, y CI en PostgreSQL 14 a 18, Node 18 a 24 y Deno.
- Ejemplos: empezar, un envoltorio para Supabase y verificar una exportación con el helper.
