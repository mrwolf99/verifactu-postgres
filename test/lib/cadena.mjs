// Una cadena «rica» con dos emisores intercalados, para las pruebas que necesitan algo más que el caso normal:
// Ñ, emoji, barra invertida, espacio duro, espacios exteriores que se recortan, una rectificativa negativa, una
// F2 a cero, una subsanación, una anulación, una nueva alta tras la anulación, importes con un decimal que se
// escriben con dos, y un número de serie de 60 puntos de código (61 unidades UTF-16).
//
// NIF: 89890001K es el ficticio de los ejemplos oficiales de la AEAT; A00000000 es ficticio a propósito.

import { lit } from "./pg.mjs";

export const NIF_A = "89890001K";
export const NIF_B = "A00000000";
export const SESENTA = "X".repeat(59) + "\u{1F600}";

// [nif, tipo, NumSerieFactura, fecha (aaaa-mm-dd), TipoFactura, CuotaTotal, ImporteTotal, subsanacion]
export const CADENA_RICA = [
  [NIF_A, "alta", "12345678/G33", "2024-01-01", "F1", "12.35", "123.45", false],        // A1
  [NIF_B, "alta", "B-1", "2024-01-01", "F1", "1.00", "5.00", false],                     //   B1
  [NIF_A, "alta", "FAC-Ñ/0002", "2024-01-02", "F1", "21.00", "121.00", false],     // A2
  [NIF_A, "alta", "TICKET \u{1F600} 3", "2024-01-02", "F2", "0.00", "0.00", false],     // A3
  [NIF_A, "alta", "R-2024\\4", "2024-01-03", "R1", "-2.10", "-12.10", false],            // A4
  [NIF_B, "alta", "B-2", "2024-01-03", "F2", "0.21", "1.21", false],                     //   B2
  [NIF_A, "alta", "FAC-Ñ/0002", "2024-01-02", "F1", "21.00", "121.00", true],      // A5 subsanación del A2
  [NIF_A, "anulacion", "TICKET \u{1F600} 3", "2024-01-02"],                              // A6 anula el A3
  [NIF_A, "alta", "TICKET \u{1F600} 3", "2024-01-02", "F2", "1.05", "6.05", false],     // A7 nueva alta del A3
  [NIF_A, "alta", "  12345678 / G34  ", "2024-01-04", "F3", "100.00", "600.00", false], // A8 se guarda sin los exteriores
  [NIF_A, "alta", SESENTA, "2024-01-05", "R5", "-0.50", "-3.00", false],                 // A9
  [NIF_B, "anulacion", "B-1", "2024-01-01"],                                             //   B3
  [NIF_A, "alta", "SERIE NB", "2024-01-06", "R2", "3.00", "18.00", false],         // A10 espacio duro interior
  [NIF_A, "alta", "R3-11", "2024-01-07", "R3", "7", "42", false],                        // A11 → 7.00 y 42.00
  [NIF_A, "alta", "R4-12", "2024-01-08", "R4", "0.1", "0.6", false],                     // A12 → 0.10 y 0.60
  [NIF_A, "alta", "ULTIMA-13", "2024-01-09", "F1", "2.00", "12.00", false],              // A13
];

export function sqlEmitir([nif, tipo, num, fecha, tipoFactura, cuota, total, subsanacion]) {
  if (tipo === "alta") {
    return `select seq, huella, huella_anterior, fecha_hora_huso_gen_registro from verifactu.emitir_alta(${lit(nif)}, `
      + `${lit(num)}, date ${lit(fecha)}, ${lit(tipoFactura)}, ${lit(cuota)}::numeric, ${lit(total)}::numeric, ${subsanacion})`;
  }
  return `select seq, huella, huella_anterior, fecha_hora_huso_gen_registro from verifactu.emitir_anulacion(${lit(nif)}, `
    + `${lit(num)}, date ${lit(fecha)})`;
}

/** Da de alta los dos emisores y emite la cadena rica. Devuelve las filas selladas, en orden de emisión. */
export async function sembrar(t, base, registros = CADENA_RICA) {
  await t.q(base, `insert into verifactu.emisor (nif) values (${lit(NIF_A)}), (${lit(NIF_B)})`);
  const selladas = [];
  for (const r of registros) selladas.push({ nif: r[0], ...(await t.objetos(base, sqlEmitir(r)))[0] });
  return selladas;
}

/** La exportación de un emisor, ya como objetos. */
export async function exportar(t, base, nif, { conexion = null } = {}) {
  const sql = `select verifactu.exportar_cadena(${lit(nif)})`;
  const filas = conexion ? await conexion.filas(sql) : await t.q(base, sql);
  return filas.map(([linea]) => JSON.parse(linea));
}
