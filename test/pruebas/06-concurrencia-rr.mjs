// REPEATABLE READ: B no puede leer una cola vieja. Falla con 40001 (reintentable) y, al reintentar, se encadena.
export const descripcion = "REPEATABLE READ: B da 40001 y al reintentar se encadena";

const emitir = (num) => `select seq, huella, huella_anterior from verifactu.emitir_alta('89890001K', '${num}', date '2024-01-01', 'F1', 1.00, 2.00)`;

export default async function (t) {
  const db = await t.base();
  await t.q(db, "insert into verifactu.emisor (nif) values ('89890001K')");
  await t.q(db, emitir("PREVIO-1"));
  await t.q(db, emitir("PREVIO-2"));
  const a = await t.conexion(db);
  const b = await t.conexion(db);

  await a.consulta("begin isolation level repeatable read");
  const [ra] = await a.objetos(emitir("CONC-A"));
  t.igual(ra.seq, "3", "A sella el 3");

  await b.consulta("begin isolation level repeatable read");
  const pendienteB = b.objetos(emitir("CONC-B")).then((f) => ({ filas: f }), (e) => ({ error: e }));
  await t.esperar(async () => (await t.uno(db, `select count(*) from pg_locks where pid = ${b.pid} and not granted`)) !== "0",
    "B no llegó a esperar un candado");
  await a.consulta("commit");
  const rb = await pendienteB;
  t.ok(rb.error && rb.error.codigo === "40001",
    `B tenía que fallar con 40001 y ${rb.error ? `falló con ${rb.error.codigo}: ${rb.error.mensaje}` : `selló el ${rb.filas[0].seq}`}`);
  await b.consulta("rollback");

  await b.consulta("begin isolation level repeatable read");
  const [reintento] = await b.objetos(emitir("CONC-B"));
  await b.consulta("commit");
  t.igual(reintento.seq, "4", "el reintento queda en el 4");
  t.igual(reintento.huella_anterior, ra.huella, "el reintento apunta a la huella de A");
  const [ver] = await t.objetos(db, "select * from verifactu.verificar_cadena('89890001K')");
  t.igual(ver.ok + "|" + ver.registros, "t|4", `verificar_cadena: ${ver.motivo} ${ver.detalle}`);
}
