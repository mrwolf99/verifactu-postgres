// Aunque el propietario apague los disparadores (DDL deliberado), las restricciones impiden bifurcar la cadena o
// cambiar un campo sin rehacer su huella.
export const descripcion = "Disparadores apagados: una rama con huella correcta da 23505; un campo cambiado o una fecha futura, 23514";

const emitir = (num) => `select seq from verifactu.emitir_alta('89890001K', '${num}', date '2024-01-01', 'F1', 1.00, 2.00)`;

// Un registro «a mano» colgado de otro, con TODO correcto (huella incluida): lo único que lo delata es la rama.
const colgarDe = (seqPadre, seqNuevo, num) => `
  insert into verifactu.registro (emisor_id, seq, tipo_registro, id_emisor_factura, num_serie_factura,
                                  fecha_expedicion_factura, tipo_factura, cuota_total, importe_total, subsanacion,
                                  huella_anterior, fecha_hora_huso_gen_registro, fecha_hora_gen, huella)
  select r.emisor_id, ${seqNuevo}, 'alta', r.id_emisor_factura, '${num}', date '2024-01-01', 'F1', 1.00, 2.00, false,
         r.huella, r.fecha_hora_huso_gen_registro, r.fecha_hora_gen,
         verifactu.huella_registro('alta', r.id_emisor_factura, '${num}', date '2024-01-01', 'F1', 1.00, 2.00, r.huella,
                                   r.fecha_hora_huso_gen_registro)
    from verifactu.registro r where r.seq = ${seqPadre}`;

export default async function (t) {
  const db = await t.base();
  await t.q(db, "insert into verifactu.emisor (nif) values ('89890001K')");
  for (let i = 1; i <= 13; i++) await t.q(db, emitir(`F-${i}`));
  await t.q(db, "alter table verifactu.registro disable trigger user");

  let error = null;
  try {
    await t.q(db, colgarDe(12, 99, "RAMA-1"));
  } catch (e) {
    error = e;
  }
  if (!error) {
    const hijos = await t.uno(db, "select count(*) from verifactu.registro where huella_anterior = (select huella from verifactu.registro where seq = 12)");
    t.ok(false, `rama aceptada: el registro 12 tiene ${hijos} hijos`);
  }
  t.ok(error.codigo === "23505" && error.restriccion === "registro_sin_bifurcacion",
    `la rama falló, pero no por registro_sin_bifurcacion: ${error.codigo} ${error.restriccion}: ${error.mensaje}`);

  // Un segundo «primer registro», y un seq repetido.
  await t.falla(db, `insert into verifactu.registro (emisor_id, seq, tipo_registro, id_emisor_factura, num_serie_factura,
      fecha_expedicion_factura, tipo_factura, cuota_total, importe_total, subsanacion, huella_anterior,
      fecha_hora_huso_gen_registro, fecha_hora_gen, huella)
    select emisor_id, 100, 'alta', id_emisor_factura, 'OTRO-PRIMERO', fecha_expedicion_factura, 'F1', 1.00, 2.00, false, '',
           fecha_hora_huso_gen_registro, fecha_hora_gen,
           verifactu.huella_registro('alta', id_emisor_factura, 'OTRO-PRIMERO', fecha_expedicion_factura, 'F1', 1.00, 2.00, '',
                                     fecha_hora_huso_gen_registro)
      from verifactu.registro where seq = 1`, "23514", "un seq 100 sin huella anterior", { restriccion: "registro_primero" });
  await t.falla(db, colgarDe(13, 5, "SEQ-REPETIDO"), "23505", "un seq ya usado", { restriccion: "registro_seq_unico" });
  // Un registro colgado del último, con todo correcto (huella incluida) salvo la fecha de expedición, que va por
  // delante del día en que se selló: solo lo para el CHECK registro_fecha_no_futura.
  await t.falla(db, `insert into verifactu.registro (emisor_id, seq, tipo_registro, id_emisor_factura, num_serie_factura,
      fecha_expedicion_factura, tipo_factura, cuota_total, importe_total, subsanacion, huella_anterior,
      fecha_hora_huso_gen_registro, fecha_hora_gen, huella)
    select r.emisor_id, 14, 'alta', r.id_emisor_factura, 'FUTURA-14', date '2999-01-01', 'F1', 1.00, 2.00, false, r.huella,
           r.fecha_hora_huso_gen_registro, r.fecha_hora_gen,
           verifactu.huella_registro('alta', r.id_emisor_factura, 'FUTURA-14', date '2999-01-01', 'F1', 1.00, 2.00, r.huella,
                                     r.fecha_hora_huso_gen_registro)
      from verifactu.registro r where r.seq = 13`, "23514", "una fecha de expedición posterior al día del sellado",
    { restriccion: "registro_fecha_no_futura" });

  // Cambiar un campo sin rehacer la huella: el CHECK recalcula la huella.
  await t.falla(db, "update verifactu.registro set cuota_total = 9.99 where seq = 5", "23514", "cuota cambiada sin rehacer la huella",
    { restriccion: "registro_huella_correcta" });
  await t.falla(db, "update verifactu.registro set fecha_hora_gen = fecha_hora_gen - interval '1 hour' where seq = 5", "23514",
    "instante cambiado sin cambiar el texto sellado", { restriccion: "registro_fecha_hora" });
  // En minúsculas la cazan dos CHECK; PostgreSQL los evalúa por orden de nombre, así que salta antes el de la huella
  // correcta. Vale cualquiera de los dos, pero tiene que ser uno de ellos.
  const minusculas = await t.falla(db, "update verifactu.registro set huella = lower(huella) where seq = 5", "23514", "huella en minúsculas");
  t.ok(["registro_huella_correcta", "registro_huella_forma"].includes(minusculas.restriccion),
    `huella en minúsculas: 23514, pero por ${minusculas.restriccion}`);

  await t.q(db, "alter table verifactu.registro enable trigger user");
  const [ver] = await t.objetos(db, "select * from verifactu.verificar_cadena('89890001K')");
  t.igual(ver.ok + "|" + ver.registros, "t|13", `nada de lo anterior entró: ${ver.motivo} ${ver.detalle}`);
}
