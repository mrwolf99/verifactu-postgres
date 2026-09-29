// pg_dump y pg_restore dejan la cadena idéntica: misma exportación, mismos disparadores y restricciones, nada
// se vuelve a sellar, y la cadena sigue desde donde estaba.
import crypto from "node:crypto";
import path from "node:path";
import { NIF_A, NIF_B, exportar, sembrar } from "../lib/cadena.mjs";

export const descripcion = "pg_dump + pg_restore: exportación idéntica, disparadores presentes, la cadena sigue";

const huellaDe = (cadena) => crypto.createHash("sha256").update(cadena.map((r) => JSON.stringify(r)).join("\n")).digest("hex");
const DISPARADORES = `select string_agg(tgname || ':' || tgenabled::text, ',' order by tgname) from pg_trigger
  where not tgisinternal and tgrelid in ('verifactu.registro'::regclass, 'verifactu.emisor'::regclass)`;
const RESTRICCIONES = `select string_agg(conname || ':' || md5(pg_get_constraintdef(oid)), ',' order by conname) from pg_constraint
  where connamespace = 'verifactu'::regnamespace`;

export default async function (t) {
  const db = await t.base();
  await sembrar(t, db);
  await t.q(db, `select * from verifactu.emitir_alta('${NIF_A}', 'COPIA-14', date '2024-02-01', 'F1', 1.00, 2.00)`);
  await t.q(db, `select * from verifactu.emitir_alta('${NIF_A}', 'COPIA-15', date '2024-02-01', 'F1', 1.00, 2.00)`);
  const antes = { a: await exportar(t, db, NIF_A), b: await exportar(t, db, NIF_B) };
  const disparadores = await t.uno(db, DISPARADORES);
  const restricciones = await t.uno(db, RESTRICCIONES);

  const volcado = path.join(t.tmp, "copia.dump");
  const d1 = await t.ejecutar(t.bin("pg_dump"), ["-Fc", "-f", volcado, "-d", db]);
  t.ok(d1.codigo === 0, `pg_dump: ${d1.error}`);
  const nueva = await t.baseVacia();
  const d2 = await t.ejecutar(t.bin("pg_restore"), ["-d", nueva, volcado]);
  t.ok(d2.codigo === 0 && d2.error === "", `pg_restore: ${d2.error}`);

  const despues = { a: await exportar(t, nueva, NIF_A), b: await exportar(t, nueva, NIF_B) };
  t.igual(huellaDe(despues.a), huellaDe(antes.a), `${NIF_A}: la exportación restaurada es idéntica`);
  t.igual(huellaDe(despues.b), huellaDe(antes.b), `${NIF_B}: la exportación restaurada es idéntica`);
  t.igual(await t.uno(nueva, DISPARADORES), disparadores, "los mismos disparadores, con el mismo modo (ENABLE ALWAYS incluido)");
  t.igual(await t.uno(nueva, RESTRICCIONES), restricciones, "las mismas restricciones");
  for (const nif of [NIF_A, NIF_B]) {
    const [ver] = await t.objetos(nueva, `select * from verifactu.verificar_cadena('${nif}')`);
    t.igual(ver.ok, "t", `${nif}: verificar_cadena tras restaurar: ${ver.motivo ?? ""} ${ver.detalle ?? ""}`);
  }
  const ultimo = antes.a[antes.a.length - 1];
  const [sigue] = await t.objetos(nueva,
    `select seq, huella_anterior from verifactu.emitir_alta('${NIF_A}', 'TRAS-RESTAURAR', date '2024-02-02', 'F1', 1.00, 2.00)`);
  t.igual(sigue.seq, String(ultimo.seq + 1), "la cadena sigue en el siguiente seq");
  t.igual(sigue.huella_anterior, ultimo.Huella, "y apunta al último de antes de la copia");
}
