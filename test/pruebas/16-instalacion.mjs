// La instalación: por psql, una transacción que aborta entera si ya está instalada o si la base no es UTF8. Y
// los ejemplos de ejemplos/ corren de verdad en una base limpia.
import fs from "node:fs";
import path from "node:path";

export const descripcion = "Instalación por psql; reinstalar y LATIN1 abortan sin dejar nada; los ejemplos corren";

export default async function (t) {
  const psql = t.bin("psql");
  const instalarConPsql = (db) => t.ejecutar(psql, ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", db, "-f", t.sqlPath]);
  const contarObjetos = (db) => t.uno(db, `select count(*) from pg_proc where pronamespace =
    (select oid from pg_namespace where nspname = 'verifactu')`);

  const db = await t.baseVacia();
  const i1 = await instalarConPsql(db);
  t.ok(i1.codigo === 0 && i1.error === "", `instalar con psql: código ${i1.codigo}: ${i1.error}`);
  const funciones = await contarObjetos(db);
  t.ok(Number(funciones) >= 15, `funciones instaladas: ${funciones}`);

  const i2 = await instalarConPsql(db);
  t.ok(i2.codigo !== 0 && /ya existe/.test(i2.error), `reinstalar tenía que abortar diciendo que ya existe: código ${i2.codigo}: ${i2.error}`);
  t.igual(await contarObjetos(db), funciones, "reinstalar no tocó nada");

  const latin1 = await t.baseVacia({ codificacion: "LATIN1" });
  const i3 = await instalarConPsql(latin1);
  t.ok(i3.codigo !== 0 && /UTF8/.test(i3.error), `instalar en LATIN1 tenía que abortar por UTF8: código ${i3.codigo}: ${i3.error}`);
  t.igual(await t.uno(latin1, "select count(*) from pg_namespace where nspname = 'verifactu'"), "0", "en LATIN1 no quedó nada");
  t.noMirado("la comprobación de «PostgreSQL 14 o posterior»: solo hay un servidor a mano");

  // Ejemplo 1, y su exportación verificada con el ejemplo 3 (helper JS).
  const e1 = await t.base();
  const r1 = await t.ejecutar(psql, ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", e1, "-f", path.join(t.raiz, "ejemplos/01-empezar.sql")]);
  t.ok(r1.codigo === 0 && r1.error === "", `ejemplos/01-empezar.sql: código ${r1.codigo}: ${r1.error}`);
  t.ok(/^t\|4\|/m.test(r1.salida.replace(/ /g, "")),
    `ejemplos/01: la verificación final no dice ok con 4 registros:\n${r1.salida.split("\n").slice(-6).join("\n")}`);
  const ndjson = path.join(t.tmp, "cadena.ndjson");
  // Como dice el README: con PGCLIENTENCODING=UTF8, para que psql no convierta la salida a la página de códigos del
  // terminal (el caso de serie en Windows).
  const r2 = await t.ejecutar(psql, ["-X", "-A", "-t", "-d", e1, "-o", ndjson, "-c", "select verifactu.exportar_cadena('89890001K')"],
    { env: { PGCLIENTENCODING: "UTF8" } });
  t.ok(r2.codigo === 0, `exportar con psql -At: ${r2.error}`);
  const ejemplo3 = path.join(t.raiz, "ejemplos/03-verificar-exportacion.mjs");
  const r3 = await t.ejecutar(process.execPath, [ejemplo3, ndjson, "89890001K"]);
  t.ok(r3.codigo === 0 && r3.salida.startsWith("ok: 4 registros"), `ejemplos/03 con la exportación del 01: ${r3.salida}${r3.error}`);
  const lineas = fs.readFileSync(ndjson, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  lineas[0].ImporteTotal = "999.99";
  fs.writeFileSync(ndjson, lineas.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const r4 = await t.ejecutar(process.execPath, [ejemplo3, ndjson, "89890001K"]);
  t.ok(r4.codigo === 1 && /ROTA en el registro 1: huella/.test(r4.salida), `ejemplos/03 con el importe del 1 cambiado: ${r4.salida}${r4.error}`);

  // Ejemplo 2: el envoltorio de Supabase, con auth.jwt() y los roles simulados.
  const e2 = await t.base();
  await t.rolFijo("anon");
  await t.rolFijo("authenticated");
  await t.q(e2, `create schema auth;
    create function auth.jwt() returns jsonb language sql stable
      as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
    grant usage on schema auth to anon, authenticated;
    insert into verifactu.emisor (nif) values ('89890001K')`);
  const r5 = await t.ejecutar(psql, ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", e2, "-f", path.join(t.raiz, "ejemplos/02-supabase-envoltorio.sql")]);
  t.ok(r5.codigo === 0 && r5.error === "", `ejemplos/02-supabase-envoltorio.sql: código ${r5.codigo}: ${r5.error}`);
  const llamada = "select public.verifactu_emitir_alta('SB-1', date '2024-01-01', 'F1', 1.00, 2.00)";
  const [[json]] = await t.q(e2, `set role authenticated;
    set request.jwt.claims = '{"app_metadata": {"verifactu_nif": "89890001K"}}';
    ${llamada};`);
  await t.q(e2, "reset role; reset request.jwt.claims");
  t.igual(JSON.parse(json).seq, 1, "authenticated con la marca en app_metadata emite");
  await t.falla(e2, `set role authenticated; set request.jwt.claims = '{"user_metadata": {"verifactu_nif": "89890001K"}}'; ${llamada}`,
    "42501", "authenticated sin la marca en app_metadata (user_metadata no vale)");
  await t.falla(e2, `set role anon; ${llamada}`, "42501", "anon no puede llamar al envoltorio");
  await t.falla(e2, "set role authenticated; select * from verifactu.emitir_alta('89890001K', 'SB-2', date '2024-01-01', 'F1', 1.00, 2.00)",
    "42501", "authenticated no llega al esquema verifactu por su cuenta");
}
