// La hora: la del servidor al sellar (no la del BEGIN), en la zona del emisor, con los cambios de hora bien
// escritos, y nunca hacia atrás (hasta un minuto se sella con la del anterior; más, VF006).
import { lit } from "../lib/contexto.mjs";

export const descripcion = "Hora del sellado (no del BEGIN), husos, cambios de hora, tope, VF006 y fecha de expedición por zona";

export default async function (t) {
  const db = await t.base();
  await t.q(db, `insert into verifactu.emisor (nif, zona_horaria) values
    ('89890001K', 'Europe/Madrid'), ('A00000000', 'Atlantic/Canary'), ('B00000000', 'Africa/Ceuta')`);

  // 1. Con el reloj real: una transacción que espera sella con la hora del sellado, no con la del BEGIN. (Con otro
  //    emisor que el del tope: el tope usa horas fijadas en el pasado y, con el mismo emisor, daría VF006.)
  const c = await t.conexion(db);
  await c.consulta("begin");
  const [[inicio]] = await c.filas("select extract(epoch from now())");
  await c.consulta("select pg_sleep(1.3)");
  const [[antes]] = await c.filas("select extract(epoch from clock_timestamp())");
  const [[sellada]] = await c.filas(`select extract(epoch from fecha_hora_gen)
    from verifactu.emitir_alta('B00000000', 'RELOJ-1', date '2024-01-01', 'F1', 1.00, 2.00)`);
  await c.consulta("commit");
  const [i, a, s] = [Number(inicio), Number(antes), Number(sellada)];
  if (!(s >= Math.floor(a))) {
    t.ok(false, s === Math.floor(i)
      ? `la hora sellada (${s}) es la hora del BEGIN (${i}) y no la del sellado (>= ${Math.floor(a)})`
      : `la hora sellada (${s}) es anterior al sellado (${a})`);
  }
  t.ok(s > i, `la hora sellada (${s}) tiene que ser posterior al BEGIN (${i})`);

  // 2. Husos y cambios de hora.
  const casos = [
    ["2024-01-01 18:20:30+00", "Europe/Madrid", "2024-01-01T19:20:30+01:00"],
    ["2024-03-31 00:59:59+00", "Europe/Madrid", "2024-03-31T01:59:59+01:00"],
    ["2024-03-31 01:00:00+00", "Europe/Madrid", "2024-03-31T03:00:00+02:00"],
    ["2024-10-27 00:59:59+00", "Europe/Madrid", "2024-10-27T02:59:59+02:00"],
    ["2024-10-27 01:00:00+00", "Europe/Madrid", "2024-10-27T02:00:00+01:00"],
    ["2024-01-15 12:00:00+00", "Atlantic/Canary", "2024-01-15T12:00:00+00:00"],
    ["2024-07-15 12:00:00+00", "Atlantic/Canary", "2024-07-15T13:00:00+01:00"],
    ["2024-07-15 12:00:00+00", "Africa/Ceuta", "2024-07-15T14:00:00+02:00"],
  ];
  for (const [instante, zona, esperado] of casos) {
    t.igual(await t.uno(db, `select verifactu.formato_fecha_hora(${lit(instante)}::timestamptz, ${lit(zona)})`), esperado,
      `${instante} en ${zona}`);
  }

  // 3. El tope, con el reloj fijado.
  await t.q(db, `create or replace function verifactu._reloj() returns timestamptz language sql volatile set search_path = pg_catalog, pg_temp
                 as $$ select current_setting('vfprueba.reloj')::timestamptz $$`);
  const emitir = async (nif, num, reloj) => {
    await t.q(db, `set vfprueba.reloj = ${lit(reloj)}`);
    return (await t.objetos(db, `select seq, fecha_hora_huso_gen_registro as hora, extract(epoch from fecha_hora_gen) as t
      from verifactu.emitir_alta(${lit(nif)}, ${lit(num)}, date '2024-06-01', 'F1', 1.00, 2.00)`))[0];
  };
  const r1 = await emitir("89890001K", "TOPE-1", "2026-06-01T12:00:00Z");
  const r2 = await emitir("89890001K", "TOPE-2", "2026-06-01T11:59:30Z");
  if (Number(r2.t) < Number(r1.t)) {
    const [ver] = await t.objetos(db, "select * from verifactu.verificar_cadena('89890001K')");
    t.ok(false, `la hora del ${r2.seq} (${r2.hora}) es anterior a la del registro previo (${r1.hora}); `
      + `verificar_cadena da ${ver.ok === "t" ? "ok" : `${ver.motivo} en el ${ver.seq}`}`);
  }
  t.igual(r2.hora, r1.hora, "30 s atrás: se sella con la hora del registro anterior");
  await t.q(db, "set vfprueba.reloj = '2026-06-01T11:58:00Z'");
  await t.falla(db, "select * from verifactu.emitir_alta('89890001K', 'TOPE-3', date '2024-06-01', 'F1', 1.00, 2.00)", "VF006",
    "2 min atrás: no se emite");
  t.igual(await t.uno(db, "select ultimo_seq from verifactu.emisor where nif = '89890001K'"), r2.seq, "el VF006 no dejó nada");
  const r3 = await emitir("89890001K", "TOPE-3", "2026-06-01T12:00:10Z");
  t.igual(r3.hora, "2026-06-01T14:00:10+02:00", "con el reloj bien, la hora vuelve a ser la del reloj");

  // El tope es por emisor: otro emisor no depende de la hora de este.
  const b1 = await emitir("A00000000", "CANARIAS-1", "2026-06-01T11:50:00Z");
  t.igual(b1.hora, "2026-06-01T12:50:00+01:00", "Canarias en verano, y sin tope heredado de otro emisor");

  // La fecha de expedición no va por delante del día del sellado EN LA ZONA DEL EMISOR. A las 22:30 UTC de un día
  // de verano, en Madrid ya es el día siguiente (00:30) y en Canarias todavía no (23:30).
  await t.q(db, "set vfprueba.reloj = '2026-06-01T22:30:00Z'");
  const emitirFecha = (nif, num, fecha) => `select seq, fecha_hora_huso_gen_registro as hora
    from verifactu.emitir_alta(${lit(nif)}, ${lit(num)}, date ${lit(fecha)}, 'F1', 1.00, 2.00)`;
  const [m2] = await t.objetos(db, emitirFecha("89890001K", "DIA-2", "2026-06-02"));
  t.igual(m2.hora, "2026-06-02T00:30:00+02:00", "Madrid: el 2 de junio ya es hoy");
  await t.falla(db, emitirFecha("A00000000", "DIA-2", "2026-06-02"), "VF003", "Canarias: el 2 de junio todavía es mañana",
    { contiene: "posterior al día del sellado (01-06-2026 en Atlantic/Canary)" });
  const [c1] = await t.objetos(db, emitirFecha("A00000000", "DIA-1", "2026-06-01"));
  t.igual(c1.hora, "2026-06-01T23:30:00+01:00", "Canarias: el 1 de junio vale");
  await t.falla(db, emitirFecha("89890001K", "ERRATA-2062", "2062-01-01"), "VF003", "una errata de año (2062) no se sella",
    { contiene: "FechaExpedicionFactura: 01-01-2062" });

  for (const nif of ["89890001K", "A00000000", "B00000000"]) {
    const [ver] = await t.objetos(db, `select * from verifactu.verificar_cadena(${lit(nif)})`);
    t.igual(ver.ok, "t", `${nif}: verificar_cadena ${ver.motivo ?? ""} ${ver.detalle ?? ""}`);
  }
  t.igual(await t.uno(db, "select count(*) from verifactu.registro where fecha_hora_huso_gen_registro::timestamptz <> fecha_hora_gen"),
    "0", "texto sellado e instante coinciden");
}
