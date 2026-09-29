// Los tres ejemplos oficiales de la AEAT por SQL: la cadena, carácter a carácter, y la huella.
import fs from "node:fs";
import path from "node:path";
import { lit } from "../lib/contexto.mjs";

export const descripcion = "Ejemplos oficiales por SQL: cadena carácter a carácter y huella";

const iso = (ddmmaaaa) => ddmmaaaa.split("-").reverse().join("-");

function primeraDiferencia(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

export default async function (t) {
  const vectores = JSON.parse(fs.readFileSync(path.join(t.raiz, "test/vectores/aeat-huella-v0.1.2.json"), "utf8"));
  const db = await t.base();
  for (const caso of vectores.casos) {
    const e = caso.entrada;
    const sqlCadena = caso.tipo === "alta"
      ? `select verifactu.cadena_alta(${lit(e.IDEmisorFactura)}, ${lit(e.NumSerieFactura)}, date ${lit(iso(e.FechaExpedicionFactura))}, `
        + `${lit(e.TipoFactura)}, ${lit(e.CuotaTotal)}::numeric, ${lit(e.ImporteTotal)}::numeric, ${lit(e.Huella)}, `
        + `${lit(e.FechaHoraHusoGenRegistro)})`
      : `select verifactu.cadena_anulacion(${lit(e.IDEmisorFacturaAnulada)}, ${lit(e.NumSerieFacturaAnulada)}, `
        + `date ${lit(iso(e.FechaExpedicionFacturaAnulada))}, ${lit(e.Huella)}, ${lit(e.FechaHoraHusoGenRegistro)})`;
    const cadena = (await t.uno(db, sqlCadena)) ?? "(nulo)";
    const i = primeraDiferencia(cadena, caso.cadena);
    t.ok(cadena === caso.cadena, `${caso.nombre}: la cadena es distinta en la posición ${i}: se esperaba `
      + `«…${caso.cadena.slice(i, i + 30)}» y salió «…${cadena.slice(i, i + 30)}»`);
    t.igual(await t.uno(db, `select verifactu.sha256_hex(${lit(cadena)})`), caso.huella, `${caso.nombre}: sha256_hex`);
    const sqlHuella = caso.tipo === "alta"
      ? `select verifactu.huella_registro('alta', ${lit(e.IDEmisorFactura)}, ${lit(e.NumSerieFactura)}, `
        + `date ${lit(iso(e.FechaExpedicionFactura))}, ${lit(e.TipoFactura)}, ${lit(e.CuotaTotal)}::numeric, `
        + `${lit(e.ImporteTotal)}::numeric, ${lit(e.Huella)}, ${lit(e.FechaHoraHusoGenRegistro)})`
      : `select verifactu.huella_registro('anulacion', ${lit(e.IDEmisorFacturaAnulada)}, ${lit(e.NumSerieFacturaAnulada)}, `
        + `date ${lit(iso(e.FechaExpedicionFacturaAnulada))}, null, null, null, ${lit(e.Huella)}, ${lit(e.FechaHoraHusoGenRegistro)})`;
    t.igual(await t.uno(db, sqlHuella), caso.huella, `${caso.nombre}: huella_registro`);
  }

  // La huella sabe fallar: variantes de la cadena del caso 1 que no pueden dar su huella.
  const c1 = vectores.casos[0];
  const variantes = {
    "123.450 en vez de 123.45": c1.cadena.replace("ImporteTotal=123.45", "ImporteTotal=123.450"),
    "sin &Huella=": c1.cadena.replace("&Huella=", ""),
    "fecha 2024-01-01": c1.cadena.replace("FechaExpedicionFactura=01-01-2024", "FechaExpedicionFactura=2024-01-01"),
    "Z en vez de +01:00": c1.cadena.replace("19:20:30+01:00", "18:20:30Z"),
  };
  for (const [nombre, variante] of Object.entries(variantes)) {
    t.ok(variante !== c1.cadena, `variante «${nombre}»: la sustitución no se aplicó`);
    t.ok((await t.uno(db, `select verifactu.sha256_hex(${lit(variante)})`)) !== c1.huella, `variante «${nombre}» da la huella oficial`);
  }

  // Formatos (especificación v0.1.2: 123.1 y 123.10 valen lo mismo; aquí se escribe siempre 123.10).
  const importes = [["123.1", "123.10"], ["-5", "-5.00"], ["0", "0.00"], ["-0.00", "0.00"], ["12.300", "12.30"],
    ["999999999999.99", "999999999999.99"]];
  for (const [entrada, salida] of importes) {
    t.igual(await t.uno(db, `select verifactu.formato_importe(${lit(entrada)}::numeric)`), salida, `formato_importe(${entrada})`);
  }
  for (const malo of ["12.345", "1000000000000", "NaN", "Infinity"]) {
    await t.falla(db, `select verifactu.formato_importe(${lit(malo)}::numeric)`, "VF003", `formato_importe(${malo}) no se redondea ni se acepta`);
  }
  t.igual(await t.uno(db, "select verifactu.formato_fecha(date '2024-01-01')"), "01-01-2024", "formato_fecha");
  t.igual(await t.uno(db, "select verifactu.formato_fecha(date '1000-12-31')"), "31-12-1000", "formato_fecha con año de 4 cifras");
  t.igual(await t.uno(db, "select verifactu.version()"), "0.1.0", "version()");
}
