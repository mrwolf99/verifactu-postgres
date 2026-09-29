// Lo que verifica la cadena, en SQL y en JS, y en qué eslabón: una edición en medio, un cambio sin rehacer la
// huella, un borrado al final y la vuelta a una copia vieja (esta, solo con ancla).
import path from "node:path";
import { NIF_A, exportar, sembrar } from "../lib/cadena.mjs";
import { lit } from "../lib/contexto.mjs";

export const descripcion = "Detección en SQL y JS: encadenamiento, huella, cola y ancla (copia vieja restaurada)";

const VERIFICAR = `select * from verifactu.verificar_cadena('${NIF_A}')`;
const EXPORTAR = `select verifactu.exportar_cadena('${NIF_A}')`;
const describir = (r) => (r.ok === true || r.ok === "t" ? "ok" : `${r.motivo} en el ${r.seq}`);

async function dentroDe(c, ordenes) {
  await c.consulta("begin");
  try {
    for (const o of ordenes) await c.consulta(o);
    const [ver] = await c.objetos(VERIFICAR);
    const cadena = (await c.filas(EXPORTAR)).map(([l]) => JSON.parse(l));
    return { ver, cadena };
  } finally {
    await c.consulta("rollback");
  }
}

export default async function (t) {
  const v = await t.js();
  const db = await t.base();
  await sembrar(t, db);
  const c = await t.conexion(db);

  const [sano] = await t.objetos(db, VERIFICAR);
  t.igual(sano.ok, "t", `la cadena sana da ok en SQL: ${describir(sano)}`);
  const cadenaSana = await exportar(t, db, NIF_A);
  const jsSano = await v.verificarCadena(cadenaSana);
  t.ok(jsSano.ok, `la cadena sana da ok en JS: ${describir(jsSano)} (${jsSano.detalle})`);
  const ultimo = cadenaSana[cadenaSana.length - 1];

  // (a) El 2 alterado y su huella rehecha: el 3 deja de apuntarle.
  const a = await dentroDe(c, ["alter table verifactu.registro disable trigger user",
    `update verifactu.registro r set cuota_total = 99.99, importe_total = 199.99,
            huella = verifactu.huella_registro(r.tipo_registro, r.id_emisor_factura, r.num_serie_factura,
              r.fecha_expedicion_factura, r.tipo_factura, 99.99, 199.99, r.huella_anterior, r.fecha_hora_huso_gen_registro)
       from verifactu.emisor e where e.id = r.emisor_id and e.nif = '${NIF_A}' and r.seq = 2`]);
  t.igual(describir(a.ver), "encadenamiento en el 3", "SQL, seq 2 alterado con su huella rehecha");
  const ja = await v.verificarCadena(a.cadena);
  t.igual(describir(ja), "encadenamiento en el 3", "JS, seq 2 alterado con su huella rehecha");

  // (b) Sin el CHECK de la huella, la cuota del 5 cambiada.
  const b = await dentroDe(c, ["alter table verifactu.registro disable trigger user",
    "alter table verifactu.registro drop constraint registro_huella_correcta",
    `update verifactu.registro r set cuota_total = cuota_total + 1 from verifactu.emisor e
      where e.id = r.emisor_id and e.nif = '${NIF_A}' and r.seq = 5`]);
  t.igual(describir(b.ver), "huella en el 5", "SQL, cuota del 5 cambiada sin rehacer la huella (y sin el CHECK)");
  t.igual(describir(await v.verificarCadena(b.cadena)), "huella en el 5", "JS, cuota del 5 cambiada sin rehacer la huella");

  // (c) El último, borrado: SQL lo ve por la cola; el JS solo con ancla. Y la emisión se bloquea.
  const ultimoSeq = ultimo.seq;
  await c.consulta("begin");
  let emisionTrasBorrado = null;
  let c3;
  try {
    await c.consulta("alter table verifactu.registro disable trigger user");
    await c.consulta(`delete from verifactu.registro r using verifactu.emisor e
      where e.id = r.emisor_id and e.nif = '${NIF_A}' and r.seq = ${ultimoSeq}`);
    [c3] = await c.objetos(VERIFICAR);
    c3.cadena = (await c.filas(EXPORTAR)).map(([l]) => JSON.parse(l));
    await c.consulta("alter table verifactu.registro enable trigger user");
    try {
      await c.consulta(`select * from verifactu.emitir_alta('${NIF_A}', 'TRAS-BORRADO', date '2024-02-01', 'F1', 1.00, 2.00)`);
    } catch (e) {
      emisionTrasBorrado = e;
    }
  } finally {
    await c.consulta("rollback");
  }
  t.igual(describir(c3), `cola en el ${ultimoSeq}`, "SQL, último registro borrado");
  t.igual(describir(await v.verificarCadena(c3.cadena)), "ok", "JS sin ancla no puede ver un borrado al final (limitación declarada)");
  t.igual(describir(await v.verificarCadena(c3.cadena, { ancla: { seq: ultimo.seq, huella: ultimo.Huella } })),
    `ancla en el ${ultimoSeq}`, "JS con ancla, último registro borrado");
  t.ok(emisionTrasBorrado && emisionTrasBorrado.codigo === "VF007",
    `tras el borrado, emitir tenía que dar VF007 y ${emisionTrasBorrado ? `dio ${emisionTrasBorrado.codigo}` : "emitió"}`);

  // (d) La vuelta a una copia vieja: coherente por dentro. Solo el ancla la delata.
  const volcado = path.join(t.tmp, "vieja.dump");
  const d1 = await t.ejecutar(t.bin("pg_dump"), ["-Fc", "-f", volcado, "-d", db]);
  t.ok(d1.codigo === 0, `pg_dump: ${d1.error}`);
  await t.q(db, `select * from verifactu.emitir_alta('${NIF_A}', 'NUEVA-14', date '2024-02-01', 'F1', 1.00, 2.00)`);
  const [[seqAncla, huellaAncla]] = await t.q(db,
    `select seq, huella from verifactu.emitir_alta('${NIF_A}', 'NUEVA-15', date '2024-02-01', 'F1', 1.00, 2.00)`);
  const ancla = `, ${seqAncla}, ${lit(huellaAncla)}`;
  const [actual] = await t.objetos(db, `select * from verifactu.verificar_cadena('${NIF_A}'${ancla})`);
  t.igual(describir(actual), "ok", "la base de verdad cumple su propia ancla");

  const vieja = await t.baseVacia();
  const d2 = await t.ejecutar(t.bin("pg_restore"), ["-d", vieja, volcado]);
  t.ok(d2.codigo === 0 && d2.error === "", `pg_restore: ${d2.error}`);
  const [viejaSinAncla] = await t.objetos(vieja, VERIFICAR);
  t.igual(describir(viejaSinAncla), "ok", "la copia vieja, sin ancla, da ok (no se puede ver desde dentro)");
  const [viejaConAncla] = await t.objetos(vieja, `select * from verifactu.verificar_cadena('${NIF_A}'${ancla})`);
  t.igual(describir(viejaConAncla), `ancla en el ${seqAncla}`, "SQL, copia vieja con ancla");
  const cadenaVieja = await exportar(t, vieja, NIF_A);
  t.igual(describir(await v.verificarCadena(cadenaVieja)), "ok", "JS, copia vieja sin ancla");
  t.igual(describir(await v.verificarCadena(cadenaVieja, { ancla: { seq: Number(seqAncla), huella: huellaAncla } })),
    `ancla en el ${seqAncla}`, "JS, copia vieja con ancla");
}
