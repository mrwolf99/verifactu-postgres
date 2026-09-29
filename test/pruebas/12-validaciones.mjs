// Cada entrada mala da su código y el mensaje nombra su campo. Y nada de lo que falla deja rastro en la cadena.
import { lit } from "../lib/contexto.mjs";

export const descripcion = "Validaciones: cada entrada mala da su código y nombra el campo; nada deja rastro";

const alta = (num, o = {}) => `select seq, num_serie_factura, cuota_total::text as cuota from verifactu.emitir_alta(`
  + `${o.nif ?? "'89890001K'"}, ${num}, ${o.fecha ?? "date '2024-01-01'"}, ${o.tipo ?? "'F1'"}, ${o.cuota ?? "1.00"}, `
  + `${o.total ?? "2.00"}, ${o.subs ?? "false"})`;
const anular = (num, o = {}) => `select seq, num_serie_factura, null as cuota from verifactu.emitir_anulacion(`
  + `${o.nif ?? "'89890001K'"}, ${num}, ${o.fecha ?? "date '2024-01-01'"})`;
const directo = (tipo, num, extraCols = "", extraVals = "") => `insert into verifactu.registro (emisor_id, tipo_registro,
    num_serie_factura, fecha_expedicion_factura, tipo_factura, cuota_total, importe_total${extraCols})
  select id, ${lit(tipo)}, ${lit(num)}, date '2024-01-01', 'F1', 1.00, 2.00${extraVals} from verifactu.emisor where nif = '89890001K'`;

export default async function (t) {
  const db = await t.base();
  await t.q(db, "insert into verifactu.emisor (nif) values ('89890001K'); insert into verifactu.emisor (nif, activo) values ('B00000000', false)");
  let emitidos = 0;
  const bien = async (sql, texto) => {
    const [r] = await t.objetos(db, sql);
    emitidos++;
    t.igual(r.seq, String(emitidos), texto);
    return r;
  };

  // NumSerieFactura
  const nums = [
    ["vacío", "''"], ["solo espacios", "'   '"], ["de 61 caracteres", lit("X".repeat(61))], ["con &", "'A&B'"],
    ["con =", "'A=B'"], ["con comilla simple", "'A''B'"], ["con comilla doble", "'A\"B'"], ["con <", "'A<B'"],
    ["con >", "'A>B'"], ["con tabulador", "'A' || chr(9) || 'B'"], ["con U+0085", "'A' || chr(133) || 'B'"],
    ["con U+007F", "'A' || chr(127) || 'B'"], ["con salto de línea", "'A' || chr(10) || 'B'"], ["nulo", "null"],
  ];
  for (const [que, num] of nums) await t.falla(db, alta(num), "VF003", `NumSerieFactura ${que}`, { contiene: "NumSerieFactura" });

  // Fuera del ASCII imprimible (validaciones de la AEAT: solo del 32 al 126). Cada uno, con su U+ en el mensaje:
  // letras que la AEAT rechaza y caracteres que se ven iguales que otros y harían pasar por distintas dos facturas
  // que se leen igual.
  const fueraAscii = [
    ["Ñ", 0xd1], ["º", 0xba], ["É", 0xc9], ["un acento combinante (NFD)", 0x301], ["un espacio duro", 0xa0],
    ["un espacio de anchura cero", 0x200b], ["un guion que no corta (U+2011)", 0x2011], ["un BOM", 0xfeff],
    ["U+2028", 0x2028], ["un emoji", 0x1f600],
  ];
  for (const [que, cp] of fueraAscii) {
    const hex = cp.toString(16).toUpperCase().padStart(4, "0");
    await t.falla(db, alta(`'FAC-' || chr(${cp}) || '1'`), "VF003", `NumSerieFactura con ${que}`, { contiene: `U+${hex} en la posición 5` });
  }
  await bien(alta(lit("X".repeat(60))), "60 caracteres valen");
  await bien(alta(lit(" !#$%()*+,-./:;?@[\\]^_`{|}~".trim())), "toda la puntuación admitida vale");

  // Barrido: todos los puntos de código, en medio de un número. Solo quedan los 89 del ASCII imprimible que no son
  // & = < > " ' (la misma lista que exige js-solo al helper JS).
  const esperados = [];
  for (let c = 32; c <= 126; c++) if (!"&=<>\"'".includes(String.fromCharCode(c))) esperados.push(c);
  const admitidos = await t.uno(db, `select string_agg(i::text, ',' order by i) from generate_series(1, 1114111) i
    where (i < 55296 or i > 57343) and verifactu.num_serie_valido('A' || chr(i) || 'B')`);
  t.igual(admitidos, esperados.join(","), "puntos de código que admite num_serie_valido en medio de un número");
  const esp = await bien(alta("'  ESP-1  '"), "espacios exteriores");
  t.igual(esp.num_serie_factura, "ESP-1", "los espacios exteriores se recortan");

  // TipoFactura
  for (const [que, tipo] of [["f1", "'f1'"], ["F4", "'F4'"], ["nulo", "null"]]) {
    await t.falla(db, alta("'TIPO-X'", { tipo }), "VF003", `TipoFactura ${que}`, { contiene: "TipoFactura" });
  }

  // Importes
  const importes = [
    ["CuotaTotal con 3 decimales", { cuota: "12.345" }, "CuotaTotal"],
    ["ImporteTotal con 3 decimales", { total: "12.345" }, "ImporteTotal"],
    ["ImporteTotal de 13 cifras", { total: "1000000000000.00" }, "ImporteTotal"],
    ["CuotaTotal nula", { cuota: "null" }, "CuotaTotal"],
    ["ImporteTotal nulo", { total: "null" }, "ImporteTotal"],
    ["ImporteTotal NaN", { total: "'NaN'::numeric" }, "ImporteTotal"],
    ["CuotaTotal infinita", { cuota: "'Infinity'::numeric" }, "CuotaTotal"],
  ];
  for (const [que, o, campo] of importes) await t.falla(db, alta("'IMP-1'", o), "VF003", que, { contiene: campo });
  const imp = await bien(alta("'IMP-1'", { cuota: "12.300", total: "999999999999.99" }), "12.300 y 999999999999.99 valen");
  t.igual(imp.cuota, "12.30", "12.300 se guarda como 12.30: solo se quitan ceros, nunca se redondea");

  // Fecha de expedición por delante del día del sellado (validaciones de la AEAT: no puede ser posterior a hoy).
  const hoyMadrid = "(now() at time zone 'Europe/Madrid')::date";
  await t.falla(db, alta("'FUT-1'", { fecha: `${hoyMadrid} + 2` }), "VF003", "fecha de expedición pasado mañana",
    { contiene: "FechaExpedicionFactura" });
  await t.falla(db, alta("'FUT-1'", { fecha: "date '9999-12-31'" }), "VF003", "fecha de expedición en 9999",
    { contiene: "posterior al día del sellado" });
  await bien(alta("'FUT-1'", { fecha: hoyMadrid }), "la fecha de hoy vale");

  // Fecha y subsanación
  await t.falla(db, alta("'FEC-1'", { fecha: "date '2024-02-31'" }), "22008", "31 de febrero: lo para el tipo date");
  await t.falla(db, alta("'FEC-1'", { fecha: "date '0999-12-31'" }), "VF003", "año de 3 cifras", { contiene: "FechaExpedicionFactura" });
  await t.falla(db, alta("'FEC-1'", { fecha: "null" }), "VF003", "fecha nula", { contiene: "FechaExpedicionFactura" });
  await t.falla(db, alta("'SUB-1'", { subs: "null" }), "VF003", "subsanación nula", { contiene: "Subsanacion" });

  // Emisor
  await t.falla(db, alta("'EMI-1'", { nif: "'A00000000'" }), "VF002", "emisor que no está dado de alta");
  await t.falla(db, alta("'EMI-1'", { nif: "'89890001k'" }), "VF002", "NIF en minúsculas: no se normaliza");
  await t.falla(db, alta("'EMI-1'", { nif: "'B00000000'" }), "VF002", "emisor desactivado", { contiene: "desactivado" });
  await t.falla(db, alta("'EMI-1'", { nif: "null" }), "VF002", "NIF nulo");

  // Regla de apertura, por factura (NIF + número + fecha)
  await t.falla(db, anular("'REG-1'"), "VF005", "anular sin alta");
  await t.falla(db, alta("'REG-1'", { subs: "true" }), "VF005", "subsanar sin alta");
  await bien(alta("'REG-1'"), "alta de REG-1");
  await t.falla(db, alta("'REG-1'"), "VF004", "alta repetida", { contiene: "ya tiene un alta vigente" });
  await t.falla(db, anular("'REG-1'", { fecha: "date '2024-01-02'" }), "VF005", "anular con otra fecha");
  await bien(alta("'REG-1'", { fecha: "date '2024-01-02'" }), "el mismo número con otra fecha es otra factura");
  await bien(alta("'REG-1'", { subs: "true", cuota: "1.50", total: "2.50" }), "subsanación de REG-1");
  await bien(anular("'REG-1'"), "anulación de REG-1");
  await t.falla(db, anular("'REG-1'"), "VF005", "anular dos veces");
  await t.falla(db, alta("'REG-1'", { subs: "true" }), "VF005", "subsanar una factura anulada");
  await bien(alta("'REG-1'"), "nueva alta tras la anulación");

  // Campos que pone la base (VF008) y forma del registro, por INSERT directo del propietario.
  const sistema = [["seq", "99"], ["huella", lit("A".repeat(64))], ["huella_anterior", "''"],
    ["id_emisor_factura", "'89890001K'"], ["fecha_hora_gen", "now()"], ["fecha_hora_huso_gen_registro", "'2024-01-01T00:00:00+01:00'"]];
  for (const [col, val] of sistema) await t.falla(db, directo("alta", "DIR-1", `, ${col}`, `, ${val}`), "VF008", `INSERT fijando ${col}`);
  await t.falla(db, directo("baja", "DIR-1"), "VF003", "TipoRegistro baja", { contiene: "TipoRegistro" });
  await t.falla(db, `insert into verifactu.registro (emisor_id, tipo_registro, num_serie_factura, fecha_expedicion_factura, cuota_total)
    select id, 'anulacion', 'REG-1', date '2024-01-01', 1.00 from verifactu.emisor where nif = '89890001K'`, "VF003",
    "anulación con importes", { contiene: "anulación no lleva" });

  // Alta del emisor
  await t.falla(db, "insert into verifactu.emisor (nif) values ('89890001k')", "23514", "emisor con NIF en minúsculas", { restriccion: "emisor_nif" });
  await t.falla(db, "insert into verifactu.emisor (nif) values ('8989 001K')", "23514", "emisor con un espacio en el NIF", { restriccion: "emisor_nif" });
  await t.falla(db, "insert into verifactu.emisor (nif, zona_horaria) values ('A00000000', 'UTC')", "23514", "zona UTC", { restriccion: "emisor_zona" });

  // Nada de lo que falló dejó rastro.
  const [ver] = await t.objetos(db, "select * from verifactu.verificar_cadena('89890001K')");
  t.igual(`${ver.ok}|${ver.registros}`, `t|${emitidos}`, `la cadena solo tiene lo emitido: ${ver.motivo ?? ""} ${ver.detalle ?? ""}`);
  t.igual(await t.uno(db, "select ultimo_seq from verifactu.emisor where nif = '89890001K'"), String(emitidos), "ultimo_seq cuadra");
}
