// READ COMMITTED: A emite y se queda abierta; B emite para el mismo emisor y ESPERA (se ve en pg_locks, no se
// supone por tiempos); A confirma; B se encadena detrás de A, sin bifurcar.
export const descripcion = "READ COMMITTED: B espera el candado de A y se encadena detrás, sin bifurcar";

const emitir = (num) => `select seq, huella, huella_anterior from verifactu.emitir_alta('89890001K', '${num}', date '2024-01-01', 'F1', 1.00, 2.00)`;

export default async function (t) {
  const db = await t.base();
  await t.q(db, "insert into verifactu.emisor (nif) values ('89890001K')");
  await t.q(db, emitir("PREVIO-1"));
  const a = await t.conexion(db);
  const b = await t.conexion(db);

  await a.consulta("begin");
  const [ra] = await a.objetos(emitir("CONC-A"));
  t.igual(ra.seq, "2", "A sella el 2");

  await b.consulta("begin");
  const pendienteB = b.objetos(emitir("CONC-B")).then((f) => ({ filas: f }), (e) => ({ error: e }));
  await t.esperar(async () => (await t.uno(db, `select count(*) from pg_locks where pid = ${b.pid} and not granted`)) !== "0",
    "B no llegó a esperar un candado");
  const bloqueadores = await t.uno(db, `select pg_blocking_pids(${b.pid})::text`);
  t.ok(bloqueadores.includes(String(a.pid)), `B espera, pero no a A: la bloquean ${bloqueadores}`);

  await a.consulta("commit");
  const rb = await pendienteB;
  if (rb.error) {
    t.ok(false, `B falló con ${rb.error.codigo} (${rb.error.restriccion ?? "sin restricción"}): ${rb.error.mensaje}`);
  }
  await b.consulta("commit");
  const [fb] = rb.filas;
  t.igual(fb.seq, "3", "B queda en el 3");
  t.igual(fb.huella_anterior, ra.huella, "B apunta a la huella de A");
  const [ver] = await t.objetos(db, "select * from verifactu.verificar_cadena('89890001K')");
  t.igual(ver.ok + "|" + ver.registros, "t|3", `verificar_cadena: ${ver.motivo} ${ver.detalle}`);
  t.igual(await t.uno(db, "select count(*) from verifactu.registro r1 join verifactu.registro r2 on r1.emisor_id = r2.emisor_id "
    + "and r1.huella_anterior = r2.huella_anterior and r1.id < r2.id"), "0", "ningún eslabón con dos hijos");
}
