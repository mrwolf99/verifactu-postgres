// Permisos de serie: nadie salvo el propietario; solo cuatro SECURITY DEFINER; search_path = pg_catalog, pg_temp en
// todas. Con search_path vacío, pg_temp se consulta ANTES que pg_catalog para los nombres de tipo, y un tipo del
// esquema temporal de quien llama se resolvería dentro de una función SECURITY DEFINER; con pg_temp explícito y al
// final, los tipos salen siempre de pg_catalog (es la pauta de la documentación de PostgreSQL para estas funciones).
// Y el peor caso de Supabase simulado: roles con privilegios por defecto globales creados ANTES de instalar.
import { ident, lit } from "../lib/contexto.mjs";

export const descripcion = "Nadie salvo el propietario; 4 SECURITY DEFINER; search_path pg_catalog, pg_temp; Supabase simulado";

const AJENOS = `
  select 'esquema verifactu' as objeto, a.grantee, a.privilege_type
    from pg_namespace n, aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
   where n.nspname = 'verifactu' and a.grantee <> n.nspowner
  union all
  select 'tabla verifactu.' || c.relname, a.grantee, a.privilege_type
    from pg_class c, aclexplode(coalesce(c.relacl, acldefault((case c.relkind when 'S' then 's' else 'r' end)::"char", c.relowner))) a
   where c.relnamespace = 'verifactu'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'S') and a.grantee <> c.relowner
  union all
  select 'función ' || p.oid::regprocedure::text, a.grantee, a.privilege_type
    from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
   where p.pronamespace = 'verifactu'::regnamespace and a.grantee <> p.proowner`;

const describir = (f) => `${f.quien} con ${f.privilege_type} en ${f.objeto}`;

async function ajenos(t, db) {
  return t.objetos(db, `select x.objeto, x.privilege_type,
      case when x.grantee = 0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end as quien from (${AJENOS}) x order by 1, 2`);
}

export default async function (t) {
  const db = await t.base();
  const fuera = await ajenos(t, db);
  t.ok(fuera.length === 0, `hay privilegios fuera del propietario (${fuera.length}): ${fuera.slice(0, 4).map(describir).join("; ")}`);

  t.igual(await t.uno(db, `select string_agg(proname, ',' order by proname) from pg_proc
                          where pronamespace = 'verifactu'::regnamespace and prosecdef`),
    "emitir_alta,emitir_anulacion,exportar_cadena,verificar_cadena", "las únicas SECURITY DEFINER");
  t.igual(await t.uno(db, `select coalesce(string_agg(proname, ',' order by proname), '') from pg_proc
                          where pronamespace = 'verifactu'::regnamespace
                            and not coalesce('search_path=pg_catalog, pg_temp' = any(proconfig), false)`),
    "", "funciones sin search_path = pg_catalog, pg_temp (pg_temp tiene que ir explícito y al final)");
  t.igual(await t.uno(db, "select has_schema_privilege('public', 'verifactu', 'usage')::text"), "false", "PUBLIC no usa el esquema");
  t.igual(await t.uno(db, "select relrowsecurity::text from pg_class where oid = 'verifactu.registro'::regclass"), "true",
    "RLS activada, sin políticas");

  // Lo que concede el integrador (README): la app emite y nada más; la auditoría exporta y verifica.
  const app = await t.rol("app");
  const auditoria = await t.rol("auditoria");
  await t.q(db, `insert into verifactu.emisor (nif) values ('89890001K');
    grant usage on schema verifactu to ${ident(app)}, ${ident(auditoria)};
    grant execute on function verifactu.emitir_alta(text, text, date, text, numeric, numeric, boolean),
                              verifactu.emitir_anulacion(text, text, date) to ${ident(app)};
    grant execute on function verifactu.exportar_cadena(text, bigint),
                              verifactu.verificar_cadena(text, bigint, text) to ${ident(auditoria)}`);
  t.igual(await t.uno(db, "select seq from verifactu.emitir_alta('89890001K', 'PERM-1', date '2024-01-01', 'F1', 1.00, 2.00)",
    { usuario: app }), "1", "la app emite");
  await t.falla(db, "select * from verifactu.verificar_cadena('89890001K')", "42501", "la app no verifica sin que se le conceda",
    { usuario: app });
  await t.falla(db, "select verifactu.exportar_cadena('89890001K')", "42501", "la app no exporta sin que se le conceda",
    { usuario: app });
  await t.falla(db, "select verifactu.sha256_hex('x')", "42501", "la app no llama a funciones internas", { usuario: app });
  t.igual(await t.uno(db, "select ok::text from verifactu.verificar_cadena('89890001K')", { usuario: auditoria }), "true",
    "la auditoría verifica");
  await t.falla(db, "select * from verifactu.emitir_alta('89890001K', 'PERM-2', date '2024-01-01', 'F1', 1.00, 2.00)", "42501",
    "la auditoría no emite", { usuario: auditoria });
  await t.falla(db, "select * from verifactu.registro", "42501", "la auditoría no lee la tabla directamente", { usuario: auditoria });

  // Supabase, el peor caso: privilegios por defecto globales para anon, authenticated y service_role.
  const db2 = await t.baseVacia();
  const roles = ["anon", "authenticated", "service_role"];
  for (const r of roles) await t.rolFijo(r);
  await t.q(db2, `alter default privileges grant all on tables to anon, authenticated, service_role;
    alter default privileges grant all on sequences to anon, authenticated, service_role;
    alter default privileges grant all on functions to anon, authenticated, service_role;
    alter default privileges grant usage, create on schemas to anon, authenticated, service_role`);
  // El simulacro tiene dientes: una tabla nueva cualquiera sí queda abierta a esos roles.
  await t.q(db2, "create table public.testigo (x integer)");
  t.igual(await t.uno(db2, "select has_table_privilege('anon', 'public.testigo', 'select')::text"), "true",
    "el simulacro de Supabase no da privilegios por defecto (no probaría nada)");
  await t.instalar(db2);
  const fuera2 = await ajenos(t, db2);
  t.ok(fuera2.length === 0, `con privilegios por defecto globales quedan (${fuera2.length}): ${fuera2.slice(0, 4).map(describir).join("; ")}`);
  for (const r of roles) {
    t.igual(await t.uno(db2, `select has_schema_privilege(${lit(r)}, 'verifactu', 'usage')::text`), "false", `${r}: esquema`);
    t.igual(await t.uno(db2, `select has_table_privilege(${lit(r)}, 'verifactu.registro', 'select')::text`), "false", `${r}: tabla`);
    t.igual(await t.uno(db2, `select has_function_privilege(${lit(r)},
        'verifactu.emitir_alta(text, text, date, text, numeric, numeric, boolean)', 'execute')::text`), "false", `${r}: emitir_alta`);
  }
}
