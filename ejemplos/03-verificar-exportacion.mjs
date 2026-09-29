// verifactu-postgres · ejemplo 3: verificar una exportación con el helper JS, fuera de la base.
//
//   PGCLIENTENCODING=UTF8 psql -XAt -d <base> -c "select verifactu.exportar_cadena('89890001K')" > cadena.ndjson
//   node ejemplos/03-verificar-exportacion.mjs cadena.ndjson 89890001K [seq-del-ancla huella-del-ancla]
//
// Sale con 0 si la cadena está bien y con 1 si no, diciendo el primer eslabón roto y por qué.

import { readFileSync } from "node:fs";
import { verificarCadena } from "../js/verifactu.mjs";

const [fichero, nif, seqAncla, huellaAncla] = process.argv.slice(2);
if (!fichero) {
  console.error("uso: node ejemplos/03-verificar-exportacion.mjs cadena.ndjson [NIF] [seq huella]");
  process.exit(2);
}
const registros = readFileSync(fichero, "utf8")
  .split("\n")
  .filter((linea) => linea.trim() !== "")
  .map((linea) => JSON.parse(linea));
const opciones = {};
if (nif) opciones.nif = nif;
if (seqAncla) opciones.ancla = { seq: Number(seqAncla), huella: huellaAncla };

const r = await verificarCadena(registros, opciones);
if (r.ok) console.log(`ok: ${r.revisados} registros; última huella ${r.ultimaHuella}`);
else console.log(`ROTA en el registro ${r.seq}: ${r.motivo} (${r.detalle})`);
process.exit(r.ok ? 0 : 1);
