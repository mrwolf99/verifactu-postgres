# verifactu-postgres

**La cadena de huellas VERI\*FACTU dentro de PostgreSQL:** una cadena por emisor, sellada por la propia base, inalterable y verificable, con un helper JS sin dependencias para comprobarla fuera.

Si la huella de un registro no coincide con la que calcula la AEAT, el registro queda «Aceptado con errores» (especificación de la huella, §7). Aquí la huella la calcula y la encadena la base, en el mismo sitio donde se guarda el registro, y un `UPDATE` o un `DELETE` no pueden deshacerla por error.

> **Estado: 0.1.0, sin publicar.** No se ha usado todavía en producción: revísalo antes de confiarle nada. Conforme a la [especificación de la huella de la AEAT v0.1.2 (27/08/2024)](https://www.agenciatributaria.es/static_files/AEAT_Desarrolladores/EEDD/IVA/VERI-FACTU/Veri-Factu_especificaciones_huella_hash_registros.pdf). Lee el [aviso legal](#aviso-legal) antes de usarlo.

## Índice

- [Qué hace y qué no hace](#qué-hace-y-qué-no-hace)
- [Instalación](#instalación)
- [Uso](#uso)
- [Los tres ejemplos oficiales](#los-tres-ejemplos-oficiales)
- [La especificación, regla a regla](#la-especificación-regla-a-regla)
- [Errores](#errores)
- [Qué puede y qué no un superusuario](#qué-puede-y-qué-no-un-superusuario)
- [La hora](#la-hora)
- [Pruebas y sabotajes](#pruebas-y-sabotajes)
- [Comparativa](#comparativa)
- [Aviso legal](#aviso-legal)
- [Licencia y patrocinio](#licencia-y-patrocinio)
- [English summary](#english-summary)

## Qué hace y qué no hace

| Hace | No hace |
|---|---|
| Calcula la huella SHA-256 de altas y anulaciones exactamente como la especificación v0.1.2 | Generar ni firmar el XML (XAdES), ni el código QR |
| Encadena cada registro con el anterior del **mismo emisor** (una cadena por NIF, altas y anulaciones mezcladas) | **Enviar nada a la AEAT** |
| Sella la hora con el reloj del servidor, en la zona del emisor, sin retroceder nunca | El registro de eventos (en VERI\*FACTU no hace falta) |
| Impide bifurcar la cadena, también con varias emisiones a la vez | Validar la letra de control del NIF (la AEAT valida contra el censo) |
| Impide `UPDATE`, `DELETE` y `TRUNCATE` sobre los registros, también al propietario y al superusuario | Importar una cadena de otro sistema |
| Exporta la cadena en JSON con los nombres de campo de la AEAT | Defenderse de un administrador que usa DDL a propósito (ver [superusuario](#qué-puede-y-qué-no-un-superusuario)) |
| Verifica la cadena en SQL y en JS y dice el primer eslabón roto y por qué | Aceptar `&` en `NumSerieFactura` (ver [más abajo](#la-especificación-regla-a-regla)) |

Sin extensiones: usa `sha256()` y `convert_to()` del núcleo (PostgreSQL 11+), sin `pgcrypto`. Necesita **PostgreSQL 14 o posterior** y una base en **UTF8**.

## Instalación

### PostgreSQL

```bash
psql -X -v ON_ERROR_STOP=1 -d mi_base -f sql/verifactu.sql
```

Es un script SQL plano, no una extensión: un `DROP EXTENSION` podría llevarse por delante la tabla con la cadena. Va en **una sola transacción** y aborta sin dejar nada a medias si el servidor es anterior a PostgreSQL 14, si la base no está en UTF8 o si el esquema `verifactu` ya existe.

Queda todo en el esquema `verifactu`, y **nadie salvo el propietario** tiene permisos: ni `PUBLIC` ni ningún rol que tuviera privilegios por defecto. Tú concedes lo justo:

```sql
-- la aplicación emite, y nada más
grant usage on schema verifactu to mi_app;
grant execute on function verifactu.emitir_alta(text, text, date, text, numeric, numeric, boolean),
                          verifactu.emitir_anulacion(text, text, date) to mi_app;

-- la auditoría exporta y verifica
grant usage on schema verifactu to mi_auditoria;
grant execute on function verifactu.exportar_cadena(text, bigint),
                          verifactu.verificar_cadena(text, bigint, text) to mi_auditoria;
```

Ningún rol toca las tablas directamente: las cuatro funciones de la API son `SECURITY DEFINER` con `search_path` vacío.

### Supabase

- **No expongas el esquema `verifactu` en la API** (no lo añadas a «Exposed schemas»).
- Instálalo con `psql` contra la cadena de conexión de la base, o pegando `sql/verifactu.sql` en el editor SQL.
- La app llama a una función tuya en `public` que decide quién emite y con qué NIF, y llama a `verifactu.emitir_alta(...)`. Tienes un ejemplo en [`ejemplos/02-supabase-envoltorio.sql`](ejemplos/02-supabase-envoltorio.sql): lee el NIF de `app_metadata` en el JWT (nunca de `user_metadata`, que el usuario puede cambiar), quita el permiso a `PUBLIC` y a `anon` y se lo da a `authenticated`.
- PostgREST abre una transacción READ COMMITTED por llamada: dos emisiones a la vez se encadenan en serie.

**Sin probar contra un proyecto de Supabase real.** Las pruebas simulan su peor caso: roles `anon`, `authenticated` y `service_role` con privilegios por defecto globales creados antes de instalar. También simulan `auth.jwt()` para el envoltorio.

### El helper JS

Un solo fichero, [`js/verifactu.mjs`](js/verifactu.mjs), sin compilación ni dependencias, con sus tipos en [`js/verifactu.d.ts`](js/verifactu.d.ts). Funciona en Node 18 o posterior, en Deno y en navegadores (WebCrypto; en Node 18, `node:crypto`). En la 0.1.0 se distribuye solo por GitHub:

```bash
npm install github:mrwolf99/verifactu-postgres
```

O copia el fichero: no tiene nada más.

## Uso

### SQL

```sql
-- 1. El emisor, una vez. La zona decide el huso de la hora sellada.
insert into verifactu.emisor (nif, zona_horaria) values ('89890001K', 'Europe/Madrid');

-- 2. Emitir. Devuelve la fila sellada entera: seq, huella, huella_anterior, hora...
select seq, huella, fecha_hora_huso_gen_registro
  from verifactu.emitir_alta('89890001K', '12345678/G33', date '2024-01-01', 'F1', 12.35, 123.45);

-- Corregir es una subsanación (un alta nueva de la misma factura); retirar es una anulación.
select * from verifactu.emitir_alta('89890001K', '12345678/G33', date '2024-01-01', 'F1', 12.60, 123.70, true);
select * from verifactu.emitir_anulacion('89890001K', '12345678/G33', date '2024-01-01');

-- 3. Exportar: una línea JSON por registro, con los nombres de la AEAT.
select verifactu.exportar_cadena('89890001K');

-- 4. Verificar: el primer eslabón roto y su motivo, u ok.
select * from verifactu.verificar_cadena('89890001K');
```

Usa `emitir_*` con `select ... from`. Con la forma `select (verifactu.emitir_alta(...)).*`, PostgreSQL llama a la función **una vez por columna**. La segunda llamada la para la propia librería con VF004 (el alta ya está vigente), pero la sentencia falla.

**El emisor.** El `nif` no cambia nunca: un NIF nuevo es un emisor nuevo, con su propia cadena. Para dejar de emitir, `update verifactu.emisor set activo = false`. Zonas admitidas: `Europe/Madrid` (por defecto), `Atlantic/Canary` y `Africa/Ceuta`. Del NIF solo se valida la forma: nueve caracteres, en mayúsculas, sin espacios.

**Los importes** son `numeric` y se escriben siempre con dos decimales (`12.3` sale `12.30`, `7` sale `7.00`). Nunca se redondean: con más de dos decimales significativos la emisión falla con VF003 (`12.300` vale, `12.345` no).

**El número de serie** admite de 1 a 60 caracteres, contados como `char_length`. Se le quitan los espacios del principio y del final, igual que en la especificación. Los interiores se conservan.

**Exportar a un fichero NDJSON:**

```bash
psql -XAt -d mi_base -c "select verifactu.exportar_cadena('89890001K')" > cadena.ndjson
```

Con `COPY ... TO STDOUT` no: su formato de texto duplica las barras invertidas y el JSON deja de ser el mismo.

Un registro exportado (el caso oficial 2):

```json
{"seq":2,"TipoRegistro":"alta","IDEmisorFactura":"89890001K","NumSerieFactura":"12345679/G34","FechaExpedicionFactura":"01-01-2024","TipoFactura":"F1","CuotaTotal":"12.35","ImporteTotal":"123.45","Subsanacion":"N","Encadenamiento":{"RegistroAnterior":{"IDEmisorFactura":"89890001K","NumSerieFactura":"12345678/G33","FechaExpedicionFactura":"01-01-2024","Huella":"3C464DAF61ACB827C65FDA19F352A4E3BDC2C640E9E9FC4CC058073F38F12F60"}},"FechaHoraHusoGenRegistro":"2024-01-01T19:20:35+01:00","TipoHuella":"01","Huella":"F7B94CFD8924EDFF273501B01EE5153E4CE8F259766F88CF6ACB8935802A2B97"}
```

**Anclas.** `verificar_cadena` ve una edición o un borrado en medio y un borrado al final. Lo que no puede ver desde dentro es una vuelta atrás coherente, por ejemplo una copia de seguridad vieja restaurada: esa cadena está bien por dentro. Para eso, guarda **fuera de la base** el último `seq` y su huella (la columna `ultima_huella`) y pásalos como ancla:

```sql
select * from verifactu.verificar_cadena('89890001K', 15, '...huella del 15...');
```

En modalidad VERI\*FACTU la AEAT guarda las huellas que recibe, y eso hace de ancla natural.

### JS

```js
import { verificarCadena, huellaRegistro, cadenaAlta, sha256Hex } from "verifactu-postgres";

const registros = texto.split("\n").filter(Boolean).map((l) => JSON.parse(l)); // la exportación
const r = await verificarCadena(registros, { nif: "89890001K", ancla: { seq: 15, huella: "..." } });
if (!r.ok) console.log(`roto en el ${r.seq}: ${r.motivo} (${r.detalle})`);
```

El helper es **estricto**: no recorta ni redondea nada. Si un campo no tiene la forma exacta que escribe la base (`12.3`, un espacio al final, la hora con `Z`, `f1`...), lanza `ErrorFormato` nombrando el campo. Así no puede divergir del SQL por un recorte distinto; el `trim()` de JS, por ejemplo, quita también el espacio duro y el de Java no.

`verificarCadena` da los mismos motivos, en el mismo orden, que `verificar_cadena`, con dos diferencias a propósito:

- No ve `cola`, porque no conoce el cursor del emisor.
- Cuenta `revisados` (hasta la rotura) donde el SQL da `registros` (el total).

Tienes un ejemplo completo en [`ejemplos/03-verificar-exportacion.mjs`](ejemplos/03-verificar-exportacion.mjs).

### Motivos de verificación

| Motivo | Qué detecta | Lista L1E |
|---|---|---|
| `secuencia` | falta un registro, o la cadena no empieza en 1 | cadena |
| `encadenamiento` | la huella anterior de un registro no es la del registro previo | 07–09 |
| `emisor` | un registro con otro NIF | — |
| `formato` | (solo JS) un campo sin la forma exacta | — |
| `huella` | la huella guardada no es la que sale de los datos | 01 |
| `fecha_hora_retrocede` | la hora es anterior a la del registro previo | 11 |
| `fecha_hora_futura` | la hora va más de un minuto por delante del reloj | fechas |
| `regla_apertura` | anulación o subsanación sin alta vigente, o alta repetida | — |
| `cola` | (solo SQL) falta el final de la cadena | — |
| `ancla` | el registro anclado no existe o su huella no es la anclada | — |

## Los tres ejemplos oficiales

La especificación (§6) trae tres casos, y aquí se reproducen por tres caminos: las funciones SQL puras, la emisión real con el reloj fijado y el helper JS en Node y en Deno. Los datos exactos están en [`test/vectores/aeat-huella-v0.1.2.json`](test/vectores/aeat-huella-v0.1.2.json).

| Caso | Huella |
|---|---|
| 1 · primer registro, alta `12345678/G33`, 19:20:30+01:00 | `3C464DAF61ACB827C65FDA19F352A4E3BDC2C640E9E9FC4CC058073F38F12F60` |
| 2 · alta encadenada `12345679/G34`, 19:20:35+01:00 | `F7B94CFD8924EDFF273501B01EE5153E4CE8F259766F88CF6ACB8935802A2B97` |
| 3 · anulación encadenada de `12345679/G34`, 19:20:40+01:00 | `177547C0D57AC74748561D054A9CEC14B4C4EA23D1BEFD6F2E69E3A388F90C68` |

```sql
select verifactu.huella_registro('alta', '89890001K', '12345678/G33', date '2024-01-01', 'F1', 12.35, 123.45,
                                 '', '2024-01-01T19:20:30+01:00');
-- 3C464DAF61ACB827C65FDA19F352A4E3BDC2C640E9E9FC4CC058073F38F12F60
```

## La especificación, regla a regla

| Regla | Dónde se cumple |
|---|---|
| Orden de los campos del alta (8) y de la anulación (5), §3 | `verifactu.cadena_alta`, `verifactu.cadena_anulacion`; `cadenaAlta`, `cadenaAnulacion` en JS |
| `campo=valor` unidos por `&`, sin codificar | las mismas |
| Sin espacios al principio ni al final de cada valor | `tg_sellar` recorta `NumSerieFactura`; el CHECK `registro_num_serie` lo exige |
| Campo vacío: `nombre=` sin valor (el primer registro lleva `Huella=`) | `huella_anterior = ''` cuando `seq = 1` (CHECK `registro_primero`) |
| SHA-256 sobre los bytes UTF-8, hexadecimal, mayúsculas, 64 caracteres; `TipoHuella` 01 | `verifactu.sha256_hex`; CHECK `registro_huella_forma` |
| Importes: uno o dos decimales valen igual; aquí siempre dos, sin `+` | `verifactu.formato_importe`; CHECK `registro_campos` |
| `FechaExpedicionFactura` en dd-mm-aaaa | `verifactu.formato_fecha` |
| `FechaHoraHusoGenRegistro` en ISO 8601 con huso | `verifactu.formato_fecha_hora`; CHECK `registro_fecha_hora` |
| Una cadena por sistema y obligado, con altas y anulaciones mezcladas (Orden HAC/1177/2024, art. 7.c y 7.d) | tabla `verifactu.emisor`; `UNIQUE (emisor_id, seq)` |
| El primer registro se identifica como tal (7.b) | `seq = 1`; `"PrimerRegistro":"S"` en la exportación |
| Cada registro lleva NIF, serie, fecha y huella del anterior (7.a) | `RegistroAnterior` en `exportar_cadena` |
| Fecha y hora exactas, con margen de un minuto, y sin retroceder (7.e a 7.h) | paso 5 de `tg_sellar`; motivos `fecha_hora_*` |
| Comprobar el último registro antes de generar uno nuevo (7.i) | paso 3 de `tg_sellar` (VF007) |
| Inalterabilidad (RD 1007/2023, art. 8.2.a) | privilegios, disparador `registro_inalterable` y el CHECK que recalcula la huella |

**El `&` en `NumSerieFactura`.** Las validaciones de la AEAT prohíben `"`, `'`, `<`, `>` y `=`, pero no `&`. Aquí se rechaza, porque la cadena de la huella no se escapa y un `&` en el valor la haría ambigua. Si algún día se admite, las cadenas ya emitidas siguen valiendo. Al revés no pasaría: prohibirlo después dejaría cadenas con registros que ya no se aceptan. También se rechazan los caracteres de control (U+0001–U+001F y U+007F–U+009F).

## Errores

Las funciones fallan con una excepción, nunca con un resultado a medias: la transacción de quien integra cae entera.

| SQLSTATE | Significa |
|---|---|
| `VF001` | inalterable: no se modifica ni se borra |
| `VF002` | emisor desconocido o desactivado |
| `VF003` | formato; el mensaje nombra el campo (`NumSerieFactura`, `CuotaTotal`...) |
| `VF004` | la factura ya tiene un alta vigente (para corregirla, subsanación) |
| `VF005` | la factura no tiene un alta vigente (para anularla o subsanarla) |
| `VF006` | el reloj del servidor va más de un minuto por detrás del último registro |
| `VF007` | la cola de la cadena no cuadra: alguien la tocó por fuera |
| `VF008` | quien inserta intenta fijar un campo que pone la base (seq, huella, hora, NIF) |

Además, las de PostgreSQL: `40001` (reintentar la transacción), `23505`, `23514` y `42501`.

## Qué puede y qué no un superusuario

La base no puede defenderse de su administrador. Lo que ofrece es que alterar la cadena **exija DDL deliberado**, no un `UPDATE` por error, y que el resultado **quede a la vista** al verificar.

| Acción | Rol de la aplicación | Propietario | Superusuario |
|---|---|---|---|
| `UPDATE`, `DELETE`, `TRUNCATE` (también `UPDATE ... where false`) | 42501 | VF001 | VF001 |
| Lo mismo con `session_replication_role = replica` | — | — | VF001 (el disparador es `ENABLE ALWAYS`) |
| `INSERT` directo | 42501 | se sella igual; si fija huella o seq, VF008 | igual |
| `TRUNCATE emisor CASCADE` / borrar un emisor con registros | 42501 | VF001 / 23503 | igual |
| Cambiar un campo con los disparadores apagados | — | 23514: el CHECK recalcula la huella | igual |
| Meter una rama con los disparadores apagados | — | 23505 | igual |
| `DISABLE TRIGGER`, `DROP CONSTRAINT`, reemplazar funciones | — | **puede** | **puede** |
| Reescribir la cadena desde un punto, o restaurar una copia vieja | — | **puede**: solo lo ve un [ancla](#uso) | **puede** |
| Tocar los ficheros de datos | — | — | **puede** |

Se detecta al verificar:

- Una edición en medio: `encadenamiento` o `huella`.
- Un borrado en medio: `secuencia`.
- Un borrado al final: `cola`. Además, tras un borrado la emisión se bloquea con VF007.

`pg_dump` y `pg_restore` dejan la cadena idéntica y no vuelven a sellar nada, porque los disparadores se crean después de cargar los datos.

## La hora

- `FechaHoraHusoGenRegistro` es el reloj del servidor **en el instante de sellar**: `clock_timestamp()`, tomado después del candado y truncado a segundos. No se usa `now()`, que es la hora del `BEGIN`: una transacción que espera el candado sellaría con una hora anterior a la del registro que la precede.
- Se escribe en la zona del emisor, con `±hh:mm` y sin `Z` ni fracciones. Los cambios de hora salen bien: `2024-10-27T02:59:59+02:00` va seguido de `2024-10-27T02:00:00+01:00`.
- **Nunca retrocede.** Si el reloj va hasta un minuto por detrás del último registro, se sella con la hora de ese registro. Si va más de un minuto por detrás, VF006 y no se emite nada.
- El servidor tiene que tener el reloj sincronizado (NTP). La AEAT avisa de horas futuras, y `verificar_cadena` las marca a partir de un minuto.
- Las emisiones de un mismo emisor van en serie por diseño (el candado es la fila del emisor). Las de emisores distintos no se esperan.

## Pruebas y sabotajes

```bash
PG_BIN="$(pg_config --bindir)" node test/run.mjs              # pasada normal
PG_BIN="$(pg_config --bindir)" node test/run.mjs --sabotajes  # cada sabotaje pone en rojo SU prueba
node test/js-solo.mjs                                         # solo el helper JS, sin PostgreSQL
```

Sin dependencias. `node test/run.mjs` crea un clúster **desechable** y lo borra al terminar:

- `initdb` en un directorio temporal, con un puerto libre al azar.
- Solo escucha por socket Unix.
- Quita del entorno las variables `PG*` heredadas: no puede apuntar a una base que ya exista.

Cada prueba recibe una base recién instalada.

| Prueba | Qué comprueba |
|---|---|
| 01 | Los ejemplos oficiales por SQL, cadena carácter a carácter |
| 02 | Los ejemplos oficiales por `emitir_*` con el reloj fijado; la exportación, byte a byte con el fixture |
| 03 | El helper JS en Node (WebCrypto y el respaldo `node:crypto`) y en Deno |
| 04 | Cadena rica con dos emisores; paridad SQL–JS fila a fila |
| 05–07 | Concurrencia: READ COMMITTED, REPEATABLE READ (40001), dos emisores |
| 08 | Con los disparadores apagados, una rama correcta da 23505 y un campo cambiado 23514 |
| 09 | Inalterabilidad para la app, el propietario y el superusuario |
| 10 | Hora del sellado, husos, cambios de hora, tope y VF006 |
| 11 | Detección en SQL y JS: encadenamiento, huella, cola y ancla (copia vieja) |
| 12 | Validaciones: cada entrada mala, su código y su campo |
| 13 | ROLLBACK, SAVEPOINT y varias filas en una sentencia |
| 14 | Permisos, SECURITY DEFINER, `search_path` y el caso Supabase simulado |
| 15 | `pg_dump` + `pg_restore` |
| 16 | Instalación por psql, reinstalar, LATIN1 y los ejemplos |
| 17 | Que el repositorio no lleve NIF, rutas, correos ni claves |

Cada **sabotaje** rompe a propósito una guarda en una copia (quita el candado, el disparador, la UNIQUE, el tope de la hora...) y exige que su prueba caiga con su causa. Antes de creerse un rojo se comprueba que el sabotaje se aplicó: el ancla casa una vez, el texto cambió y el ancla ya no está. Cuando un mismo defecto lo ven dos pruebas (un orden de campos cambiado lo ven los ejemplos oficiales y la paridad SQL–JS), se declara en [`test/sabotajes.mjs`](test/sabotajes.mjs). Un rojo que no esté declarado cuenta como fallo.

La CI ([`.github/workflows/pruebas.yml`](.github/workflows/pruebas.yml)) corre las pruebas en PostgreSQL 14 a 18, el helper en Node 18 a 24 y en Deno, y los sabotajes en PostgreSQL 17.

## Comparativa

Hay librerías que calculan la huella VERI\*FACTU en la aplicación (en JS, PHP, C#...). No hemos encontrado ninguna que la calcule y la encadene **dentro de la base**, que es lo que hace esta. La comparativa detallada, proyecto a proyecto, queda pendiente: no se publica sin haber comprobado cada fila.

## Aviso legal

`verifactu-postgres` es un componente, no un Sistema Informático de Facturación (SIF) ni un sistema VERI\*FACTU completo. No genera ni firma el XML, **no envía nada a la AEAT**, no genera el código QR ni el registro de eventos.

Quien lo integra en su programa de facturación es el **productor** de ese sistema, y es quien debe suscribir la **declaración responsable**. La [FAQ oficial de la AEAT](https://sede.agenciatributaria.gob.es/Sede/iva/sistemas-informaticos-facturacion-verifactu/preguntas-frecuentes/certificacion-sistemas-informaticos-declaracion-responsable.html) la atribuye también a quien «integre partes de otro software, ya sea o no de código abierto».

Se ofrece «tal cual», sin garantía (licencia MIT). **No es asesoramiento fiscal ni jurídico.** Es un proyecto independiente, sin relación con la AEAT.

## Licencia y patrocinio

[MIT](LICENSE) © 2026 Samy Haggag.

Si te ahorra trabajo, puedes apoyar su mantenimiento en [GitHub Sponsors](https://github.com/sponsors/mrwolf99). El patrocinio no compra soporte, certificación ni garantía de cumplimiento.

Para avisar de un fallo de seguridad, mira [SECURITY.md](SECURITY.md).

## English summary

`verifactu-postgres` keeps the Spanish VERI\*FACTU invoice-record hash chain **inside PostgreSQL**:

- **Official spec:** SHA-256 hashes computed exactly as in AEAT specification v0.1.2, reproducing its three official examples.
- **Sealing:** one chain per issuer (tax ID), sealed by a trigger with the server clock, which never goes backwards.
- **Concurrency:** no forks under concurrency, in READ COMMITTED or REPEATABLE READ.
- **Append-only:** `UPDATE`, `DELETE` and `TRUNCATE` fail even for the owner and the superuser.
- **Export and verify:** records export as JSON with the AEAT field names, and are verified in SQL or with a dependency-free JS helper (Node, Deno, browsers).

It needs no extensions (PostgreSQL 14+, UTF8 database). It is a component, **not** a complete invoicing system (SIF): it does not build or sign the XML, send anything to the tax agency, or generate the QR code. Whoever integrates it is the producer of their system and is responsible for the *declaración responsable*.

Run the tests with `PG_BIN="$(pg_config --bindir)" node test/run.mjs`: they use a throwaway cluster. MIT licensed.
