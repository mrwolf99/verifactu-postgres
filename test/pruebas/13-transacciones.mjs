// ROLLBACK y SAVEPOINT no dejan huecos; varias filas en una sola sentencia quedan en cadena lineal; una sentencia
// que falla en su tercera fila no deja ninguna.
export const descripcion = "ROLLBACK y SAVEPOINT sin huecos; varias filas en una sentencia, en cadena lineal";

const emitir = (num) => `select seq, huella, huella_anterior from verifactu.emitir_alta('89890001K', '${num}', date '2024-01-01', 'F1', 1.00, 2.00)`;

export default async function (t) {
  const db = await t.base();
  await t.q(db, "insert into verifactu.emisor (nif) values ('89890001K')");
  const c = await t.conexion(db);

  const [r1] = await c.objetos(emitir("TX-1"));
  await c.consulta("begin");
  const [descartado] = await c.objetos(emitir("TX-DESCARTADO"));
  t.igual(descartado.seq, "2", "dentro de la transacción se sella el 2");
  await c.consulta("rollback");
  const [r2] = await c.objetos(emitir("TX-2"));
  t.igual(r2.seq, "2", "tras un ROLLBACK no queda hueco");
  t.igual(r2.huella_anterior, r1.huella, "y el 2 apunta al 1");

  await c.consulta("begin");
  const [r3] = await c.objetos(emitir("TX-3"));
  await c.consulta("savepoint s");
  await c.objetos(emitir("TX-DESCARTADO-2"));
  await c.consulta("rollback to savepoint s");
  const [r4] = await c.objetos(emitir("TX-4"));
  await c.consulta("commit");
  t.igual(r4.seq, "4", "tras un ROLLBACK TO SAVEPOINT no queda hueco");
  t.igual(r4.huella_anterior, r3.huella, "y el 4 apunta al 3");

  const filas = await c.objetos(`insert into verifactu.registro (emisor_id, tipo_registro, num_serie_factura,
      fecha_expedicion_factura, tipo_factura, cuota_total, importe_total)
    select e.id, 'alta', 'MULTI-' || g, date '2024-01-01', 'F1', 1.00, 2.00
      from verifactu.emisor e, generate_series(1, 3) g where e.nif = '89890001K' order by g
    returning seq, huella, huella_anterior`);
  t.igual(filas.map((f) => f.seq).join(","), "5,6,7", "tres filas en una sentencia: 5, 6 y 7");
  t.igual(filas[0].huella_anterior, r4.huella, "la primera apunta al 4");
  t.igual(filas[1].huella_anterior, filas[0].huella, "la segunda apunta a la primera");
  t.igual(filas[2].huella_anterior, filas[1].huella, "la tercera apunta a la segunda");

  await t.falla(db, `insert into verifactu.registro (emisor_id, tipo_registro, num_serie_factura, fecha_expedicion_factura,
      tipo_factura, cuota_total, importe_total)
    select e.id, 'alta', 'MALA-' || g, date '2024-01-01', case when g = 3 then 'F9' else 'F1' end, 1.00, 2.00
      from verifactu.emisor e, generate_series(1, 3) g where e.nif = '89890001K' order by g`,
    "VF003", "una sentencia de tres filas con la tercera mala", { contiene: "TipoFactura" });
  t.igual(await t.uno(db, "select ultimo_seq from verifactu.emisor where nif = '89890001K'"), "7", "la sentencia fallida no dejó nada");

  const [ver] = await t.objetos(db, "select * from verifactu.verificar_cadena('89890001K')");
  t.igual(`${ver.ok}|${ver.registros}`, "t|7", `verificar_cadena: ${ver.motivo ?? ""} ${ver.detalle ?? ""}`);
}
