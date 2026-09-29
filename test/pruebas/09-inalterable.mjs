// Inalterabilidad en dos capas: privilegios (la app no toca las tablas) y disparador (el propietario y el
// superusuario tampoco pueden hacer UPDATE, DELETE ni TRUNCATE, ni siquiera con session_replication_role).
import { ident } from "../lib/contexto.mjs";

export const descripcion = "App: 42501. Propietario y superusuario: VF001 en UPDATE, DELETE y TRUNCATE";

const EMITIR = "select seq from verifactu.emitir_alta('89890001K', 'APP-1', date '2024-01-01', 'F1', 1.00, 2.00)";

export default async function (t) {
  const dueno = await t.rol("dueno");
  const app = await t.rol("app");
  const db = await t.base({ usuario: dueno });
  const comoDueno = { usuario: dueno };
  const comoApp = { usuario: app };
  await t.q(db, "insert into verifactu.emisor (nif) values ('89890001K')", comoDueno);
  await t.q(db, `grant usage on schema verifactu to ${ident(app)};
    grant execute on function verifactu.emitir_alta(text, text, date, text, numeric, numeric, boolean),
                              verifactu.emitir_anulacion(text, text, date) to ${ident(app)}`, comoDueno);

  // La app emite por la función (SECURITY DEFINER) y no toca las tablas.
  t.igual(await t.uno(db, EMITIR, comoApp), "1", "la app emite con emitir_alta");
  const prohibidas = [
    ["UPDATE", "update verifactu.registro set cuota_total = cuota_total"],
    ["DELETE", "delete from verifactu.registro"],
    ["TRUNCATE", "truncate verifactu.registro"],
    ["INSERT", "insert into verifactu.registro (emisor_id, tipo_registro, num_serie_factura, fecha_expedicion_factura, tipo_factura, cuota_total, importe_total) values (1, 'alta', 'X-1', date '2024-01-01', 'F1', 1.00, 2.00)"],
    ["SELECT", "select * from verifactu.registro"],
    ["UPDATE del emisor", "update verifactu.emisor set activo = false"],
  ];
  for (const [que, sql] of prohibidas) await t.falla(db, sql, "42501", `app: ${que}`, comoApp);

  // El propietario: el disparador lo para.
  const inalterables = [
    ["UPDATE", "update verifactu.registro set cuota_total = cuota_total"],
    ["UPDATE de 0 filas", "update verifactu.registro set cuota_total = cuota_total where false"],
    ["DELETE", "delete from verifactu.registro"],
    ["TRUNCATE", "truncate verifactu.registro"],
    ["TRUNCATE del emisor en cascada", "truncate verifactu.emisor cascade"],
  ];
  for (const [que, sql] of inalterables) await t.falla(db, sql, "VF001", `dueño: ${que}`, comoDueno);

  // INSERT directo del propietario: se sella igual; si intenta fijar un campo del sistema, VF008.
  await t.falla(db, `insert into verifactu.registro (emisor_id, tipo_registro, num_serie_factura, fecha_expedicion_factura,
      tipo_factura, cuota_total, importe_total, huella) values (1, 'alta', 'X-2', date '2024-01-01', 'F1', 1.00, 2.00, '${"A".repeat(64)}')`,
    "VF008", "dueño: INSERT fijando la huella", comoDueno);
  t.igual(await t.uno(db, `insert into verifactu.registro (emisor_id, tipo_registro, num_serie_factura, fecha_expedicion_factura,
      tipo_factura, cuota_total, importe_total) select id, 'alta', 'DIRECTO-2', date '2024-01-01', 'F1', 1.00, 2.00
      from verifactu.emisor returning seq`, comoDueno), "2", "dueño: un INSERT directo se sella igual");

  // El emisor.
  await t.falla(db, "update verifactu.emisor set nif = 'A00000000'", "VF001", "dueño: cambiar el NIF", comoDueno);
  await t.falla(db, "update verifactu.emisor set ultimo_seq = 0", "VF001", "dueño: mover ultimo_seq", comoDueno);
  await t.falla(db, "delete from verifactu.emisor", "23503", "dueño: borrar un emisor con registros", comoDueno);
  await t.q(db, "update verifactu.emisor set activo = false", comoDueno);
  await t.falla(db, EMITIR.replace("APP-1", "APP-3"), "VF002", "emitir con el emisor desactivado", comoApp);
  await t.q(db, "update verifactu.emisor set activo = true", comoDueno);
  t.igual(await t.uno(db, EMITIR.replace("APP-1", "APP-3"), comoApp), "3", "activo se puede cambiar, y se vuelve a emitir");

  // El superusuario, también; y session_replication_role no lo salta (el disparador es ENABLE ALWAYS).
  for (const [que, sql] of inalterables.slice(0, 4)) await t.falla(db, sql, "VF001", `superusuario: ${que}`);
  await t.q(db, "set session_replication_role = replica");
  await t.falla(db, "delete from verifactu.registro", "VF001", "superusuario con session_replication_role = replica: DELETE");
  await t.falla(db, "truncate verifactu.registro", "VF001", "superusuario con session_replication_role = replica: TRUNCATE");
  await t.q(db, "reset session_replication_role");

  const [ver] = await t.objetos(db, "select * from verifactu.verificar_cadena('89890001K')");
  t.igual(ver.ok + "|" + ver.registros, "t|3", `la cadena sigue intacta: ${ver.motivo} ${ver.detalle}`);
}
