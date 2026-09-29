# verifactu-postgres

**La cadena de huellas VERI\*FACTU dentro de PostgreSQL:** una cadena por emisor, sellada por la propia base, inalterable y verificable, con un helper JS sin dependencias para comprobarla fuera.

Si la huella de un registro no coincide con la que calcula la AEAT, el registro queda «Aceptado con errores» (especificación de la huella, §7). Aquí la huella la calcula y la encadena la base, en el mismo sitio donde se guarda el registro, y un `UPDATE` o un `DELETE` no pueden deshacerla por error.

> **Estado: 0.1.0, primera versión.** No se ha usado todavía en producción ni se ha probado contra el entorno de preproducción de la AEAT: revísalo antes de confiarle nada. Conforme a la [especificación de la huella de la AEAT v0.1.2 (27/08/2024)](https://www.agenciatributaria.es/static_files/AEAT_Desarrolladores/EEDD/IVA/VERI-FACTU/Veri-Factu_especificaciones_huella_hash_registros.pdf). Lee el [aviso legal](#aviso-legal) antes de usarlo.

## Índice

- [Qué hace y qué no hace](#qué-hace-y-qué-no-hace)
- [Cuándo es obligatorio](#cuándo-es-obligatorio)
- [Instalación](#instalación)
- [Uso](#uso)
- [Los tres ejemplos oficiales](#los-tres-ejemplos-oficiales)
- [La especificación, regla a regla](#la-especificación-regla-a-regla)
- [Errores](#errores)
- [Qué puede y qué no un superusuario](#qué-puede-y-qué-no-un-superusuario)
- [La hora](#la-hora)
- [Actualizar](#actualizar)
- [Pruebas y sabotajes](#pruebas-y-sabotajes)
- [Comparativa](#comparativa)
- [Aviso legal](#aviso-legal)
- [Licencia y patrocinio](#licencia-y-patrocinio)
- [English summary](#english-summary)

## Qué hace y qué no hace

| Hace | No hace |
|---|---|
| Calcula la huella SHA-256 de altas y anulaciones exactamente como la especificación v0.1.2 | Generar el XML ni el código QR. Tampoco firma: en VERI\*FACTU los registros no se firman, basta la huella (RRSIF, art. 16.3); la firma XAdES es de la modalidad NO VERI\*FACTU |
| Encadena cada registro con el anterior del **mismo emisor** (una cadena por NIF, altas y anulaciones mezcladas) | **Enviar nada a la AEAT** |
| Sella la hora con el reloj del servidor, en la zona del emisor, sin retroceder nunca | El registro de eventos (en VERI\*FACTU no hace falta) |
| Impide bifurcar la cadena, también con varias emisiones a la vez | Validar la letra de control del NIF (la AEAT valida contra el censo) |
| Impide `UPDATE`, `DELETE` y `TRUNCATE` sobre los registros, también al propietario y al superusuario (salvo DDL deliberado: ver [superusuario](#qué-puede-y-qué-no-un-superusuario)) | Importar una cadena de otro sistema |
| Rechaza en `NumSerieFactura` lo que la AEAT rechaza: fuera del ASCII imprimible (32–126), `"`, `'`, `<`, `>` y `=`; y además `&` (ver [más abajo](#la-especificación-regla-a-regla)) | Defenderse de un administrador que usa DDL a propósito |
| Rechaza una `FechaExpedicionFactura` posterior al día del sellado | Imponer la fecha mínima de la AEAT (28-10-2024): los ejemplos oficiales son de 2024 y las pruebas los reproducen. Esa validación es tuya |
| Exporta la cadena en JSON con los nombres de campo de la AEAT | Anular una factura sin alta previa en esta cadena (`SinRegistroPrevio = S` del XSD): da VF005 |
| Verifica la cadena en SQL y en JS y dice el primer eslabón roto y por qué | Sellar con husos distintos para un mismo NIF: hay **una zona por emisor**. Si facturas desde Canarias y desde la Península con el mismo NIF, la hora de una de las dos no irá en el huso de su territorio (Orden HAC/1177/2024, art. 7.e) |

Sin extensiones: usa `sha256()` y `convert_to()` del núcleo, sin `pgcrypto`. La instalación exige **PostgreSQL 14 o posterior** y una base en **UTF8**.

**Dónde se ha probado:** PostgreSQL 17.11, Node 24 y Deno 2.9, en macOS; y en la CI de GitHub ([`.github/workflows/pruebas.yml`](.github/workflows/pruebas.yml)), en verde el 29 sep 2026 sobre **PostgreSQL 14, 15, 16, 17 y 18**, **Node 18, 20, 22 y 24** y **Deno** ([primera pasada](https://github.com/mrwolf99/verifactu-postgres/actions/runs/36629272215)). En navegadores, sin probar.

## Cuándo es obligatorio

Lo fija la disposición final cuarta del Real Decreto 1007/2023, en la redacción del Real Decreto-ley 15/2025 (a 29-09-2026):

- Contribuyentes del Impuesto sobre Sociedades (art. 3.1.a del Reglamento): sistemas adaptados **antes del 1 de enero de 2027**.
- El resto de obligados del art. 3.1: sistemas operativos **antes del 1 de julio de 2027**.

Estas fechas ya han cambiado más de una vez. Compruébalas en el [texto consolidado del BOE](https://www.boe.es/buscar/act.php?id=BOE-A-2023-24840) antes de planificar nada.

## Instalación

### PostgreSQL

```bash
psql -X -v ON_ERROR_STOP=1 -d mi_base -f sql/verifactu.sql
```

Es un script SQL plano, no una extensión: un `DROP EXTENSION` podría llevarse por delante la tabla con la cadena. Va en **una sola transacción** y aborta sin dejar nada a medias si el servidor es anterior a PostgreSQL 14, si la base no está en UTF8 o si el esquema `verifactu` ya existe.

Queda todo en el esquema `verifactu`, y **nadie salvo el propietario** tiene permisos: ni `PUBLIC` ni ningún rol que tuviera privilegios por defecto. Tú concedes lo justo:

```sql
-- mi_app y mi_auditoria son tus roles. Si todavía no existen:
--   create role mi_app login;  create role mi_auditoria login;

-- la aplicación emite, y nada más
grant usage on schema verifactu to mi_app;
grant execute on function verifactu.emitir_alta(text, text, date, text, numeric, numeric, boolean),
                          verifactu.emitir_anulacion(text, text, date) to mi_app;

-- la auditoría exporta y verifica
grant usage on schema verifactu to mi_auditoria;
grant execute on function verifactu.exportar_cadena(text, bigint),
                          verifactu.verificar_cadena(text, bigint, text) to mi_auditoria;
```

Ningún rol toca las tablas directamente: las cuatro funciones de la API son `SECURITY DEFINER`. Todas las funciones fijan `search_path = pg_catalog, pg_temp`, que es la pauta de la documentación de PostgreSQL para este tipo de funciones: con un `search_path` vacío, el esquema temporal de quien llama se consultaría **antes** que `pg_catalog` al resolver nombres de tipo; con `pg_temp` explícito y al final, no.

Como refuerzo, si en esa base ningún rol de la aplicación necesita tablas temporales, quítales el permiso (afecta a toda la base, decídelo tú):

```sql
revoke temporary on database mi_base from public;
```

### Supabase

- **No expongas el esquema `verifactu` en la API** (no lo añadas a «Exposed schemas»).
- Instálalo con `psql` contra la cadena de conexión de la base, o pegando `sql/verifactu.sql` en el editor SQL.
- La app llama a una función tuya en `public` que decide quién emite y con qué NIF, y llama a `verifactu.emitir_alta(...)`. Tienes un ejemplo en [`ejemplos/02-supabase-envoltorio.sql`](ejemplos/02-supabase-envoltorio.sql): lee el NIF de `app_metadata` en el JWT (nunca de `user_metadata`, que el usuario puede cambiar), quita el permiso a `PUBLIC` y a `anon` y se lo da a `authenticated`.
- PostgREST abre una transacción READ COMMITTED por llamada: dos emisiones a la vez se encadenan en serie.

**Sin probar contra un proyecto de Supabase real.** Las pruebas simulan su peor caso: roles `anon`, `authenticated` y `service_role` con privilegios por defecto globales creados antes de instalar. También simulan `auth.jwt()` para el envoltorio.

### El helper JS

Un solo fichero, [`js/verifactu.mjs`](js/verifactu.mjs), sin compilación ni dependencias, con sus tipos en [`js/verifactu.d.ts`](js/verifactu.d.ts). Usa WebCrypto y, en Node 18, `node:crypto`. En la 0.1.0 se distribuye solo por GitHub:

```bash
npm install github:mrwolf99/verifactu-postgres
```

O copia el fichero: no tiene nada más.

- **Deno:** no está en npm, así que `npm:` no sirve. Copia `js/verifactu.mjs` e impórtalo por ruta (`import { verificarCadena } from "./verifactu.mjs";`).
- **Navegador:** `crypto.subtle` solo existe en un contexto seguro (HTTPS o `localhost`). Servido por `http://` desde otra dirección, el helper falla con un error que lo dice.

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

**El emisor.** El `nif` no cambia nunca: un NIF nuevo es un emisor nuevo, con su propia cadena. Para dejar de emitir, `update verifactu.emisor set activo = false`. Zonas admitidas: `Europe/Madrid` (por defecto), `Atlantic/Canary` y `Africa/Ceuta`, una por emisor. Del NIF solo se valida la forma: nueve caracteres, en mayúsculas, sin espacios.

**Los importes** son `numeric` y se escriben siempre con dos decimales (`12.3` sale `12.30`, `7` sale `7.00`). Nunca se redondean: con más de dos decimales significativos la emisión falla con VF003 (`12.300` vale, `12.345` no).

**El número de serie** admite de 1 a 60 caracteres del **ASCII imprimible** (del 32 al 126), como exigen las validaciones de la AEAT (documento de validaciones y errores v1.2.2, IDFactura del alta), salvo `"`, `'`, `<`, `>`, `=` y `&`. Una `Ñ`, una `º`, una tilde, un emoji, un espacio duro o un carácter invisible dan VF003, y el mensaje dice cuál (`U+00D1 en la posición 5`). Así tampoco pueden entrar como facturas distintas dos números que se leen igual. Se le quitan los espacios del principio y del final, igual que en la especificación de la huella; los interiores se conservan.

**La fecha de expedición** no puede ser posterior al día del sellado en la zona del emisor (la AEAT rechaza el registro). Da VF003 y no se sella nada: una errata de año (`2062` por `2026`) no queda para siempre en la cadena.

**Exportar a un fichero NDJSON:**

```bash
PGCLIENTENCODING=UTF8 psql -XAt -d mi_base -c "select verifactu.exportar_cadena('89890001K')" > cadena.ndjson
```

- Fija `PGCLIENTENCODING=UTF8`. Si no, `psql` convierte la salida a la codificación del terminal, que en Windows no es UTF-8. Con el número de serie limitado a ASCII, la exportación de la 0.1.0 es ASCII entera, pero no dependas de eso.
- Con `COPY ... TO STDOUT` no: su formato de texto duplica las barras invertidas y el JSON deja de ser el mismo.

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
import { readFileSync } from "node:fs";
import { verificarCadena } from "verifactu-postgres";

// cadena.ndjson: la exportación de verifactu.exportar_cadena() (ver «Exportar a un fichero NDJSON»).
const registros = readFileSync("cadena.ndjson", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

// El ancla es opcional: un seq y su huella (ultima_huella) guardados FUERA de la base.
// const r = await verificarCadena(registros, { nif: "89890001K", ancla: { seq: 14, huella: "<64 hexadecimales>" } });
const r = await verificarCadena(registros, { nif: "89890001K" });
if (r.ok) console.log(`ok: ${r.revisados} registros`);
else console.log(`roto en el ${r.seq}: ${r.motivo} (${r.detalle})`);
```

El helper es **estricto**: no recorta ni redondea nada. Así no puede divergir del SQL por un recorte distinto; el `trim()` de JS, por ejemplo, quita también el espacio duro y el de Java no.

- `cadenaAlta`, `cadenaAnulacion` y `huellaRegistro` **lanzan** `ErrorFormato` si un campo no tiene la forma exacta que escribe la base (`12.3`, un espacio al final, la hora con `Z`, `f1`...). El error nombra el campo en `e.campo`.
- `verificarCadena` **no lanza** por los datos: devuelve `{ ok: false, motivo: "formato" }` en el primer registro mal formado. Solo lanza `ErrorFormato` si están mal las opciones (`nif`, `ancla`, `ahora`).

`verificarCadena` da los mismos motivos, en el mismo orden, que `verificar_cadena`, con dos diferencias a propósito:

- No ve `cola`, porque no conoce el cursor del emisor.
- Cuenta `revisados` (hasta la rotura) donde el SQL da `registros` (el total).

Tienes un ejemplo completo en [`ejemplos/03-verificar-exportacion.mjs`](ejemplos/03-verificar-exportacion.mjs).

### Motivos de verificación

La última columna relaciona cada motivo con el tipo de anomalía más cercano de la lista L1E del anexo de la Orden HAC/1177/2024 (la del registro de eventos, que en VERI\*FACTU no se exige). Es una correspondencia orientativa, no un código que la librería emita.

| Motivo | Qué detecta | L1E |
|---|---|---|
| `secuencia` | falta un registro, o la cadena no empieza en 1 | 04 |
| `encadenamiento` | la huella anterior de un registro no es la del registro previo | 07–09 |
| `emisor` | un registro con otro NIF | — |
| `formato` | (solo JS) un campo sin la forma exacta | — |
| `huella` | la huella guardada no es la que sale de los datos | 01 |
| `fecha_hora_retrocede` | la hora es anterior a la del registro previo | 11 |
| `fecha_hora_futura` | la hora va más de un minuto por delante del reloj | 13 |
| `regla_apertura` | anulación o subsanación sin alta vigente, o alta repetida | — |
| `cola` | (solo SQL) falta el final de la cadena | 05 |
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

Las tablas dicen **qué hace el código** y dónde. No dicen que un sistema que lo use cumpla la normativa: eso lo declara quien lo produce (ver el [aviso legal](#aviso-legal)).

**La huella** (especificación v0.1.2):

| Regla | Qué hace la librería |
|---|---|
| Orden de los campos del alta (8) y de la anulación (5), §3 | `verifactu.cadena_alta`, `verifactu.cadena_anulacion`; `cadenaAlta`, `cadenaAnulacion` en JS |
| `campo=valor` unidos por `&`, sin codificar | las mismas |
| Sin espacios al principio ni al final de cada valor | `tg_sellar` recorta `NumSerieFactura`; el CHECK `registro_num_serie` lo exige |
| Campo vacío: `nombre=` sin valor (el primer registro lleva `Huella=`) | `huella_anterior = ''` cuando `seq = 1` (CHECK `registro_primero`) |
| SHA-256 sobre los bytes UTF-8, hexadecimal, mayúsculas, 64 caracteres; `TipoHuella` 01 | `verifactu.sha256_hex`; CHECK `registro_huella_forma` |
| Importes: uno o dos decimales valen igual; aquí siempre dos, sin `+` | `verifactu.formato_importe`; CHECK `registro_campos` |
| `FechaExpedicionFactura` en dd-mm-aaaa | `verifactu.formato_fecha` |
| `FechaHoraHusoGenRegistro` en ISO 8601 con huso | `verifactu.formato_fecha_hora`; CHECK `registro_fecha_hora` |

**El encadenamiento** (Orden HAC/1177/2024, art. 7):

| Regla | Qué hace la librería |
|---|---|
| Cada registro lleva NIF, serie, fecha y huella del anterior (7.a) | `RegistroAnterior` en `exportar_cadena` |
| El primer registro se identifica como tal (7.b) | `seq = 1`; `"PrimerRegistro":"S"` en la exportación |
| Una cadena por sistema y obligado, con altas y anulaciones mezcladas (7.c y 7.d) | tabla `verifactu.emisor`; `UNIQUE (emisor_id, seq)` |
| Fecha y hora exactas del momento de generación, según el territorio de expedición (7.e) | el reloj del servidor al sellar, en la zona del emisor (una por NIF: ver «No hace») |
| La hora incluye el huso aplicado (7.g) | `±hh:mm` en `FechaHoraHusoGenRegistro` |

En modalidad VERI\*FACTU, el art. 3 de la Orden deja fuera los arts. 6.b a 6.f, 7.f, 7.h, 7.i, 7.j, 8 y 9. Aun así, la librería hace algunas de esas cosas porque protegen la cadena, no porque se las exija la norma en esa modalidad: comprueba la cola antes de encadenar (VF007) y no deja que la hora retroceda (VF006). Lo que no hace:

- 7.f: que el reloj sea exacto, con un minuto de error como mucho, es obligación del usuario del sistema. Sincroniza el servidor (NTP).
- 7.h: el seguimiento de la cadena hacia delante y hacia atrás es cosa de la interfaz de tu sistema. La librería da la exportación en orden de `seq`.

Sobre la inalterabilidad, el art. 8.2.a del Reglamento aprobado por el RD 1007/2023 (RRSIF) pide que un registro no se pueda alterar sin que el sistema lo detecte. En VERI\*FACTU, el art. 16.2 del mismo Reglamento presume que eso se cumple por diseño. La librería añade sus propias capas: privilegios, el disparador `registro_inalterable` y el CHECK que recalcula la huella.

**El `&` en `NumSerieFactura`.** Las validaciones de la AEAT prohíben `"`, `'`, `<`, `>` y `=`, pero no `&`. Aquí se rechaza **por prudencia**. No es que rompa la huella: como el `=` está prohibido, el primer `=` que sigue a `NumSerieFactura=` es el de `&FechaExpedicionFactura=`, y la cadena se puede seguir leyendo sin ambigüedad. El motivo es que no se ha comprobado contra la AEAT que un `&` en el valor dé allí la misma huella. Si algún día se admite, las cadenas ya emitidas siguen valiendo. Al revés no pasaría: prohibirlo después dejaría cadenas con registros que ya no se aceptan.

## Errores

Las funciones fallan con una excepción, nunca con un resultado a medias: la transacción de quien integra cae entera.

| SQLSTATE | Significa |
|---|---|
| `VF001` | inalterable: no se modifica ni se borra |
| `VF002` | emisor desconocido o desactivado |
| `VF003` | formato o valor no admitido; el mensaje nombra el campo (`NumSerieFactura`, `CuotaTotal`, `FechaExpedicionFactura`...) |
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
| Meter una rama, o una fecha de expedición futura, con los disparadores apagados | — | 23505 / 23514 | igual |
| `DISABLE TRIGGER`, `DROP CONSTRAINT`, reemplazar funciones | — | **puede** | **puede** |
| Reescribir la cadena desde un punto, o restaurar una copia vieja | — | **puede**: solo lo ve un [ancla](#uso) | **puede** |
| Tocar los ficheros de datos | — | — | **puede** |

El rol de la aplicación solo llega a las cuatro funciones que le concedas, y esas funciones no resuelven nombres de tipo en su esquema temporal (ver [Instalación](#postgresql)).

Se detecta al verificar:

- Una edición en medio: `encadenamiento` o `huella`.
- Un borrado en medio: `secuencia`.
- Un borrado al final: `cola`. Además, tras un borrado la emisión se bloquea con VF007.

`pg_dump` y `pg_restore` dejan la cadena idéntica y no vuelven a sellar nada, porque los disparadores se crean después de cargar los datos.

## La hora

- `FechaHoraHusoGenRegistro` es el reloj del servidor **en el instante de sellar**: `clock_timestamp()`, tomado después del candado y truncado a segundos. No se usa `now()`, que es la hora del `BEGIN`: una transacción que espera el candado sellaría con una hora anterior a la del registro que la precede.
- Se escribe en la zona del emisor, con `±hh:mm` y sin `Z` ni fracciones. Los cambios de hora salen bien: `2024-10-27T02:59:59+02:00` va seguido de `2024-10-27T02:00:00+01:00`.
- **Nunca retrocede.** Si el reloj va hasta un minuto por detrás del último registro, se sella con la hora de ese registro. Si va más de un minuto por detrás, VF006 y no se emite nada.
- La fecha de expedición se compara con el día del sellado **en la zona del emisor**: a las 00:30 del día 2 en Madrid todavía es el día 1 en Canarias.
- El servidor tiene que tener el reloj sincronizado (NTP). La AEAT avisa de horas futuras, y `verificar_cadena` las marca a partir de un minuto.
- Las emisiones de un mismo emisor van en serie por diseño (el candado es la fila del emisor). Las de emisores distintos no se esperan.

## Actualizar

La 0.1.0 es la primera versión: no hay nada que actualizar. Reinstalar no es la vía, porque la instalación aborta si el esquema ya existe, para no tocar la cadena. Cuando haya una versión nueva, traerá su propio script de actualización y el [CHANGELOG](CHANGELOG.md) dirá cómo aplicarlo.

## Pruebas y sabotajes

```bash
PG_BIN="$(pg_config --bindir)" node test/run.mjs              # pasada normal
PG_BIN="$(pg_config --bindir)" node test/run.mjs --sabotajes  # cada sabotaje pone en rojo SU prueba
node test/js-solo.mjs                                         # solo el helper JS, sin PostgreSQL
```

Si `pg_config` no está en el `PATH`, pon la carpeta a mano: con Postgres.app, `PG_BIN=/Applications/Postgres.app/Contents/Versions/17/bin`; con Homebrew, `PG_BIN=/opt/homebrew/opt/postgresql@17/bin`.

Sin dependencias. `node test/run.mjs` crea un clúster **desechable** y lo borra al terminar:

- `initdb` en un directorio temporal, con un puerto libre al azar.
- Solo escucha por socket Unix.
- Quita del entorno las variables `PG*` heredadas: no puede apuntar a una base que ya exista.

Cada prueba recibe una base recién instalada. El resumen cuenta aparte las notas NO MIRADO: lo que una prueba no ha podido comprobar se dice, aunque no la ponga en rojo.

| Prueba | Qué comprueba |
|---|---|
| 01 | Los ejemplos oficiales por SQL, cadena carácter a carácter |
| 02 | Los ejemplos oficiales por `emitir_*` con el reloj fijado; la exportación, byte a byte con el fixture |
| 03 | El helper JS en Node (WebCrypto y el respaldo `node:crypto`) y en Deno, con el barrido de todos los puntos de código en `NumSerieFactura` |
| 04 | Cadena rica con dos emisores y toda la puntuación admitida; paridad SQL–JS fila a fila |
| 05–07 | Concurrencia: READ COMMITTED, REPEATABLE READ (40001), dos emisores |
| 08 | Con los disparadores apagados: una rama correcta da 23505; un campo cambiado o una fecha futura, 23514 |
| 09 | Inalterabilidad para la app, el propietario y el superusuario |
| 10 | Hora del sellado, husos, cambios de hora, tope, VF006 y la fecha de expedición según la zona |
| 11 | Detección en SQL y JS: encadenamiento, huella, cola y ancla (copia vieja) |
| 12 | Validaciones: cada entrada mala, su código y su campo; barrido de todos los puntos de código en `NumSerieFactura` |
| 13 | ROLLBACK, SAVEPOINT y varias filas en una sentencia |
| 14 | Permisos, SECURITY DEFINER, `search_path = pg_catalog, pg_temp` y el caso Supabase simulado |
| 15 | `pg_dump` + `pg_restore` |
| 16 | Instalación por psql, reinstalar, LATIN1 y los ejemplos |
| 17 | Que ni los ficheros ni el **historial de git** (autor, committer y mensaje de cada commit, y cada fichero de cada commit) lleven NIF, rutas, correos (salvo los noreply) ni claves |

La prueba 17 pasa además una lista negra propia si se le da con `VF_LISTA_NEGRA=/ruta/a/lista.txt`: un término por línea, sin distinguir mayúsculas, `re:` delante para una expresión regular. La lista vive **fuera** del repositorio y el informe nunca imprime sus términos, solo su número de línea. Sin ella, la prueba lo anota como NO MIRADO.

Cada **sabotaje** rompe a propósito una guarda en una copia (quita el candado, el disparador, la UNIQUE, el tope de la hora, la regla de ASCII, el `search_path`...) y exige que su prueba caiga con su causa. Antes de creerse un rojo se comprueba que el sabotaje se aplicó: el ancla casa una vez, el texto cambió y el ancla ya no está. Cuando un mismo defecto lo ven dos pruebas (un orden de campos cambiado lo ven los ejemplos oficiales y la paridad SQL–JS), se declara en [`test/sabotajes.mjs`](test/sabotajes.mjs). Un rojo que no esté declarado cuenta como fallo.

## Comparativa

Hay librerías que calculan la huella VERI\*FACTU en la aplicación, en varios lenguajes. La comparativa proyecto a proyecto queda pendiente: no la publico sin haber comprobado cada fila.

## Aviso legal

`verifactu-postgres` es un componente, no un Sistema Informático de Facturación (SIF) ni un sistema VERI\*FACTU completo. No genera el XML, **no envía nada a la AEAT**, no genera el código QR ni el registro de eventos.

**El autor no emite declaración responsable de este componente.** Quien lo integra en su programa de facturación es el **productor** de ese sistema y es quien la suscribe. Según la [FAQ oficial de la AEAT](https://sede.agenciatributaria.gob.es/Sede/iva/sistemas-informaticos-facturacion-verifactu/preguntas-frecuentes/certificacion-sistemas-informaticos-declaracion-responsable.html) sobre software de código abierto, la hace quien programa o integra partes de otro software, sea o no de código abierto. En esa declaración indica qué componentes usa, y responde de su funcionamiento, incluidos los sistemas de seguridad. La misma página trata el caso de un sistema con varios componentes de empresas distintas: léela si es el tuyo.

- No se ha probado contra el entorno de preproducción de la AEAT.
- Se ofrece «tal cual», sin garantía (licencia MIT). **No es asesoramiento fiscal ni jurídico.**
- Es un proyecto independiente, sin relación con la AEAT.
- VERI\*FACTU, PostgreSQL, Supabase y GitHub son marcas de sus titulares. Aquí solo se nombran para decir con qué funciona la librería.

## Licencia y patrocinio

[MIT](LICENSE) © 2026 Samy Haggag.

Si te ahorra trabajo, puedes apoyar su mantenimiento en [GitHub Sponsors](https://github.com/sponsors/mrwolf99). El patrocinio no compra soporte, certificación ni garantía de cumplimiento.

Para avisar de un fallo de seguridad, mira [SECURITY.md](SECURITY.md).

## English summary

`verifactu-postgres` keeps the Spanish VERI\*FACTU invoice-record hash chain **inside PostgreSQL**:

- **Official spec:** SHA-256 hashes computed exactly as in AEAT specification v0.1.2, reproducing its three official examples.
- **Sealing:** one chain per issuer (tax ID), sealed by a trigger with the server clock, which never goes backwards.
- **Validation:** invoice numbers limited to printable ASCII (32–126) as the tax agency requires; no invoice date after the sealing day.
- **Concurrency:** no forks under concurrency, in READ COMMITTED or REPEATABLE READ.
- **Append-only:** `UPDATE`, `DELETE` and `TRUNCATE` fail even for the owner and the superuser. The database cannot defend itself from its administrator, though: deliberate DDL (disabling triggers, dropping constraints, replacing functions, restoring an old backup) can still alter the chain. The checks make that visible when verifying, and an external anchor catches a restored old backup.
- **Export and verify:** records export as JSON with the AEAT field names, and are verified in SQL or with a dependency-free JS helper (Node, Deno, browsers in a secure context).

It needs no extensions (PostgreSQL 14+, UTF8 database). Tested on PostgreSQL 17.11, Node 24 and Deno 2.9; the CI matrix is configured but has not run yet. It is a component, **not** a complete invoicing system (SIF): it does not build the XML, send anything to the tax agency, or generate the QR code. Its author issues no *declaración responsable* for it: whoever integrates it is the producer of their system and is responsible for that declaration.

Run the tests with `PG_BIN="$(pg_config --bindir)" node test/run.mjs`: they use a throwaway cluster. MIT licensed.
