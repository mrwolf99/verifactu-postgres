-- verifactu-postgres · ejemplo 2: un envoltorio para Supabase
--
-- El esquema verifactu NO se expone en la API (no lo añadas a «Exposed schemas»). La app llama a una función de
-- public por PostgREST, supabase.rpc('verifactu_emitir_alta', {...}), y esa función decide quién emite y con qué
-- NIF. Aquí lo decide una marca en app_metadata, que solo escribe el servidor (service_role); nunca
-- user_metadata, que el propio usuario puede cambiar.
--
-- PostgREST abre una transacción READ COMMITTED por llamada: dos emisiones a la vez se encadenan en serie.
--
-- Probado en un PostgreSQL corriente, simulando auth.jwt() y los roles anon y authenticated (test/pruebas/16).
-- Contra un proyecto de Supabase real: sin probar.

create or replace function public.verifactu_emitir_alta(
  p_num_serie_factura text, p_fecha_expedicion_factura date, p_tipo_factura text,
  p_cuota_total numeric, p_importe_total numeric, p_subsanacion boolean default false)
returns json
language plpgsql security definer set search_path = ''
as $$
declare
  v_nif text := (select auth.jwt()) -> 'app_metadata' ->> 'verifactu_nif';
  r     verifactu.registro;
begin
  if v_nif is null then
    raise exception using errcode = '42501', message = 'verifactu: esta cuenta no puede emitir registros';
  end if;
  select * into r
    from verifactu.emitir_alta(v_nif, p_num_serie_factura, p_fecha_expedicion_factura, p_tipo_factura,
                               p_cuota_total, p_importe_total, p_subsanacion);
  return json_build_object('seq', r.seq, 'huella', r.huella, 'fecha_hora', r.fecha_hora_huso_gen_registro);
end
$$;

revoke all on function public.verifactu_emitir_alta(text, date, text, numeric, numeric, boolean) from public, anon;
grant execute on function public.verifactu_emitir_alta(text, date, text, numeric, numeric, boolean) to authenticated;
