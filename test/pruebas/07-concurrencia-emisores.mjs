// Dos emisores no se esperan: el candado es la fila de cada emisor, no algo global.
export const descripcion = "Dos emisores no se esperan entre sí";

export default async function (t) {
  const db = await t.base();
  await t.q(db, "insert into verifactu.emisor (nif) values ('89890001K'), ('A00000000')");
  const a = await t.conexion(db);
  const b = await t.conexion(db);
  await a.consulta("begin");
  await a.consulta("select * from verifactu.emitir_alta('89890001K', 'A-1', date '2024-01-01', 'F1', 1.00, 2.00)");

  await b.consulta("begin");
  let terminada = false;
  const pendienteB = b.objetos("select seq from verifactu.emitir_alta('A00000000', 'B-1', date '2024-01-01', 'F1', 1.00, 2.00)")
    .finally(() => { terminada = true; });
  // Si B esperase a A, aparecería en pg_locks sin conceder; si termina, no. Se mira lo que pasa, con un tope de
  // seguridad para no colgar la batería.
  const r = await t.esperar(async () => {
    const esperando = await t.uno(db, `select count(*) from pg_locks where pid = ${b.pid} and not granted`);
    if (esperando !== "0") return { espera: true };
    return terminada ? { espera: false } : null;
  }, "B no terminó ni se quedó esperando");
  t.ok(!r.espera, "B (otro emisor) se quedó esperando a A");
  const [fb] = await pendienteB;
  t.igual(fb.seq, "1", "B sella el 1 de su propia cadena");
  t.igual(a.estado, "T", "A sigue abierta mientras B termina");
  await b.consulta("commit");
  await a.consulta("commit");
  t.igual(await t.uno(db, "select string_agg(e.nif || ':' || e.ultimo_seq, ',' order by e.nif) from verifactu.emisor e"),
    "89890001K:1,A00000000:1", "cada emisor, su cursor");
}
