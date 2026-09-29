// Los ejemplos oficiales por la vía REAL de emisión (emitir_* y el disparador de sellado), con el reloj fijado,
// y la exportación comparada byte a byte con el fixture que usan las pruebas del JS.
import fs from "node:fs";
import path from "node:path";
import { lit } from "../lib/contexto.mjs";

export const descripcion = "Ejemplos oficiales por emitir_* con el reloj fijado; exportación = fixture byte a byte";

// 60 caracteres con toda la puntuación que admite NumSerieFactura (ASCII del 32 al 126, sin & = < > " ').
const SESENTA = "!#$%()*+,-./:;?@[\\]^_`{|}~".repeat(2) + "01234567";

// [reloj, tipo, NumSerieFactura (tal como entra), fecha, TipoFactura, CuotaTotal, ImporteTotal, subsanacion, hora sellada esperada]
const REGISTROS = [
  ["2024-01-01T19:20:30+01:00", "alta", "12345678/G33", "2024-01-01", "F1", "12.35", "123.45", false, "2024-01-01T19:20:30+01:00"],
  ["2024-01-01T19:20:35+01:00", "alta", "12345679/G34", "2024-01-01", "F1", "12.35", "123.45", false, "2024-01-01T19:20:35+01:00"],
  ["2024-01-01T19:20:40+01:00", "anulacion", "12345679/G34", "2024-01-01", null, null, null, false, "2024-01-01T19:20:40+01:00"],
  ["2024-01-02T10:00:00+01:00", "alta", "  FAC/0004 ", "2024-01-02", "F1", "21.00", "121.00", false, "2024-01-02T10:00:00+01:00"],
  ["2024-01-02T10:00:05+01:00", "alta", "TICKET #5 (A+B)", "2024-01-02", "F2", "0.00", "0.00", false, "2024-01-02T10:00:05+01:00"],
  ["2024-01-02T10:00:10+01:00", "alta", "R-2024\\6", "2024-01-02", "R1", "-2.10", "-12.10", false, "2024-01-02T10:00:10+01:00"],
  ["2024-01-02T10:00:15+01:00", "alta", "FAC/0004", "2024-01-02", "F1", "21.00", "121.00", true, "2024-01-02T10:00:15+01:00"],
  ["2024-01-02T10:00:20+01:00", "anulacion", "TICKET #5 (A+B)", "2024-01-02", null, null, null, false, "2024-01-02T10:00:20+01:00"],
  ["2024-01-02T10:00:25+01:00", "alta", "TICKET #5 (A+B)", "2024-01-02", "F2", "1.05", "6.05", false, "2024-01-02T10:00:25+01:00"],
  ["2024-03-31T00:59:59Z", "alta", "CAMBIO-HORA-1", "2024-03-31", "F3", "100.00", "600.00", false, "2024-03-31T01:59:59+01:00"],
  ["2024-03-31T01:00:00Z", "alta", "CAMBIO-HORA-2", "2024-03-31", "R5", "-0.50", "-3.00", false, "2024-03-31T03:00:00+02:00"],
  ["2024-10-27T00:59:59Z", "alta", "CAMBIO-HORA-3", "2024-10-27", "R3", "7", "42", false, "2024-10-27T02:59:59+02:00"],
  ["2024-10-27T01:00:00Z", "alta", "SERIE  DOBLE 13", "2024-10-27", "R2", "0.1", "0.6", false, "2024-10-27T02:00:00+01:00"],
  ["2024-10-27T01:00:05Z", "alta", SESENTA, "2024-10-27", "R4", "3.00", "18.00", false, "2024-10-27T02:00:05+01:00"],
];

export default async function (t) {
  const vectores = JSON.parse(fs.readFileSync(path.join(t.raiz, "test/vectores/aeat-huella-v0.1.2.json"), "utf8"));
  const rutaFixture = path.join(t.raiz, "test/vectores/cadena-ejemplo.ndjson");
  const db = await t.base();
  await t.q(db, "insert into verifactu.emisor (nif) values ('89890001K')");
  await t.q(db, `create or replace function verifactu._reloj() returns timestamptz language sql volatile set search_path = pg_catalog, pg_temp
                 as $$ select current_setting('vfprueba.reloj')::timestamptz $$`);
  for (const [k, [reloj, tipo, num, fecha, tf, cuota, total, subs, hora]] of REGISTROS.entries()) {
    await t.q(db, `set vfprueba.reloj = ${lit(reloj)}`);
    const sql = tipo === "alta"
      ? `select * from verifactu.emitir_alta('89890001K', ${lit(num)}, date ${lit(fecha)}, ${lit(tf)}, ${lit(cuota)}::numeric, ${lit(total)}::numeric, ${subs})`
      : `select * from verifactu.emitir_anulacion('89890001K', ${lit(num)}, date ${lit(fecha)})`;
    const [r] = await t.objetos(db, sql);
    t.igual(r.seq, String(k + 1), `registro ${k + 1}: seq`);
    t.igual(r.fecha_hora_huso_gen_registro, hora, `registro ${k + 1}: hora sellada con el reloj en ${reloj}`);
    if (k < 3) t.igual(r.huella, vectores.casos[k].huella, `${vectores.casos[k].nombre}: huella por emisión`);
  }
  const [ver] = await t.objetos(db, "select * from verifactu.verificar_cadena('89890001K')");
  t.igual(ver.ok, "t", `verificar_cadena: ${ver.motivo} ${ver.detalle}`);

  const exportado = (await t.q(db, "select verifactu.exportar_cadena('89890001K')")).map(([l]) => l).join("\n") + "\n";
  if (process.env.VF_REGENERAR_FIXTURE === "1") {
    fs.writeFileSync(rutaFixture, exportado);
    t.noMirado("fixture REGENERADO a partir de esta base: revisa el diff antes de darlo por bueno", { grave: true });
    return;
  }
  const guardado = fs.existsSync(rutaFixture) ? fs.readFileSync(rutaFixture, "utf8") : "(no existe)";
  let i = 0;
  while (i < guardado.length && i < exportado.length && guardado[i] === exportado[i]) i++;
  t.ok(exportado === guardado, `la exportación no es el fixture byte a byte: difiere en la posición ${i} `
    + `(fixture «…${guardado.slice(i, i + 40)}», exportado «…${exportado.slice(i, i + 40)}»)`);
}
