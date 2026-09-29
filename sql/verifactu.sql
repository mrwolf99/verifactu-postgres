-- verifactu-postgres 0.1.0
--
-- Cadena de huellas VERI*FACTU (SHA-256) dentro de PostgreSQL: una cadena por emisor, sellada por la propia
-- base, inalterable y verificable. Huella según la especificación de la AEAT v0.1.2 (27/08/2024).
--
-- Instalación: una sola transacción. Si algo no cuadra, aborta y no deja nada a medias.
--   psql -X -v ON_ERROR_STOP=1 -d <base> -f sql/verifactu.sql
--
-- Esto es un componente, no un Sistema Informático de Facturación: lee el aviso legal del README.
-- Licencia MIT.

begin;

-- ── 0. Comprobaciones previas ────────────────────────────────────────────────────────────────────────────
do $comprobar$
declare
  v_codificacion text;
begin
  if current_setting('server_version_num')::integer < 140000 then
    raise exception 'verifactu: hace falta PostgreSQL 14 o posterior; este servidor es el %',
      current_setting('server_version');
  end if;
  select pg_encoding_to_char(d.encoding) into v_codificacion
    from pg_database d
   where d.datname = current_database();
  if v_codificacion <> 'UTF8' then
    raise exception 'verifactu: la base tiene que estar en UTF8 (la huella se calcula sobre los bytes UTF-8) y esta está en %',
      v_codificacion;
  end if;
  if exists (select 1 from pg_namespace n where n.nspname = 'verifactu') then
    raise exception 'verifactu: el esquema verifactu ya existe; la instalación no pisa nada'
      using hint = 'Reinstalar no es la vía para actualizar. La 0.1.0 no trae actualización; una versión nueva traerá la suya y su CHANGELOG dirá cómo aplicarla.';
  end if;
end
$comprobar$;

create schema verifactu;
comment on schema verifactu is
  'verifactu-postgres 0.1.0: cadena de huellas VERI*FACTU. No se expone en ninguna API.';

-- ── 1. Formatos y huella: funciones puras ────────────────────────────────────────────────────────────────

create function verifactu.version() returns text
  language sql immutable parallel safe set search_path = pg_catalog, pg_temp
  as $$ select '0.1.0' $$;

-- FechaExpedicionFactura: dd-mm-aaaa (anexo de la Orden HAC/1177/2024 y XSD de la AEAT).
create function verifactu.formato_fecha(p date) returns text
  language sql immutable strict parallel safe set search_path = pg_catalog, pg_temp
  as $$ select lpad(extract(day from p)::integer::text, 2, '0') || '-'
            || lpad(extract(month from p)::integer::text, 2, '0') || '-'
            || lpad(extract(year from p)::integer::text, 4, '0') $$;

-- CuotaTotal e ImporteTotal: siempre dos decimales y punto, sin «+». La especificación v0.1.2 (§3) da por
-- iguales uno y dos decimales; aquí se escribe siempre el mismo texto, en la huella y en la exportación.
-- Nunca redondea: con más de dos decimales significativos, o con más de 12 cifras enteras, da VF003.
create function verifactu.formato_importe(p numeric) returns text
  language plpgsql immutable strict parallel safe set search_path = pg_catalog, pg_temp
as $$
begin
  if not (abs(p) < 1000000000000) then   -- también NaN e infinito
    raise exception using errcode = 'VF003',
      message = format('verifactu: importe fuera de rango (%s): como mucho 12 cifras enteras', p);
  end if;
  if scale(trim_scale(p)) > 2 then
    raise exception using errcode = 'VF003',
      message = format('verifactu: importe con más de dos decimales (%s); la base no redondea', p);
  end if;
  return round(p, 2)::text;
end
$$;

-- FechaHoraHusoGenRegistro: AAAA-MM-DDThh:mm:ss±hh:mm (ISO 8601), en la zona del emisor, sin «Z» ni fracciones.
create function verifactu.formato_fecha_hora(p timestamptz, p_zona text) returns text
  language plpgsql stable strict parallel safe set search_path = pg_catalog, pg_temp
as $$
declare
  v_local timestamp := p at time zone p_zona;
  v_min   integer   := (extract(epoch from (v_local - (p at time zone 'UTC'))) / 60)::integer;
begin
  return to_char(v_local, 'YYYY-MM-DD"T"HH24:MI:SS')
      || case when v_min < 0 then '-' else '+' end
      || lpad((abs(v_min) / 60)::text, 2, '0') || ':' || lpad((abs(v_min) % 60)::text, 2, '0');
end
$$;

-- NumSerieFactura: de 1 a 60 caracteres, sin espacios al principio ni al final (la huella se calcula sin ellos),
-- solo ASCII imprimible (del 32 al 126, como exigen las validaciones de la AEAT) y sin & = < > " '.
-- El «&» no lo prohíbe la AEAT: se rechaza por prudencia (ver README). Una sola definición: la usan el CHECK de
-- la tabla y el sellado.
create function verifactu.num_serie_valido(p text) returns boolean
  language sql immutable parallel safe set search_path = pg_catalog, pg_temp
  as $$ select p is not null
           and char_length(p) between 1 and 60
           and p = btrim(p, ' ')
           and p ~ '^[ -~]+$'
           and p !~ '[&=<>"'']' $$;

-- Huella: SHA-256 de los bytes UTF-8, en hexadecimal y en mayúsculas (especificación v0.1.2, §2 y §5).
-- sha256() y convert_to() son del núcleo (PostgreSQL 11+): ni pgcrypto ni ninguna otra extensión.
-- convert_to() figura como stable en el catálogo; aquí es determinista porque la instalación exige una base UTF8
-- y convertir UTF8 a UTF8 no toca ningún byte. Por eso esta función se declara immutable.
create function verifactu.sha256_hex(p text) returns text
  language sql immutable strict parallel safe set search_path = pg_catalog, pg_temp
  as $$ select upper(encode(sha256(convert_to(p, 'UTF8')), 'hex')) $$;

-- Cadena de un alta (especificación v0.1.2, §3): campo=valor unidos por «&», en este orden, sin codificar.
create function verifactu.cadena_alta(p_nif text, p_num text, p_fecha date, p_tipo text, p_cuota numeric,
                                      p_total numeric, p_huella_anterior text, p_fecha_hora text) returns text
  language sql immutable strict parallel safe set search_path = pg_catalog, pg_temp
  as $$ select 'IDEmisorFactura=' || p_nif
            || '&NumSerieFactura=' || p_num
            || '&FechaExpedicionFactura=' || verifactu.formato_fecha(p_fecha)
            || '&TipoFactura=' || p_tipo
            || '&CuotaTotal=' || verifactu.formato_importe(p_cuota)
            || '&ImporteTotal=' || verifactu.formato_importe(p_total)
            || '&Huella=' || p_huella_anterior
            || '&FechaHoraHusoGenRegistro=' || p_fecha_hora $$;

-- Cadena de una anulación (especificación v0.1.2, §3).
create function verifactu.cadena_anulacion(p_nif text, p_num text, p_fecha date, p_huella_anterior text,
                                           p_fecha_hora text) returns text
  language sql immutable strict parallel safe set search_path = pg_catalog, pg_temp
  as $$ select 'IDEmisorFacturaAnulada=' || p_nif
            || '&NumSerieFacturaAnulada=' || p_num
            || '&FechaExpedicionFacturaAnulada=' || verifactu.formato_fecha(p_fecha)
            || '&Huella=' || p_huella_anterior
            || '&FechaHoraHusoGenRegistro=' || p_fecha_hora $$;

create function verifactu.huella_registro(p_tipo_registro text, p_nif text, p_num text, p_fecha date, p_tipo text,
                                          p_cuota numeric, p_total numeric, p_huella_anterior text,
                                          p_fecha_hora text) returns text
  language sql immutable parallel safe set search_path = pg_catalog, pg_temp
  as $$ select verifactu.sha256_hex(case p_tipo_registro
              when 'alta' then verifactu.cadena_alta(p_nif, p_num, p_fecha, p_tipo, p_cuota, p_total,
                                                     p_huella_anterior, p_fecha_hora)
              when 'anulacion' then verifactu.cadena_anulacion(p_nif, p_num, p_fecha, p_huella_anterior, p_fecha_hora)
            end) $$;

-- La hora del sellado. Va aparte para poder fijarla en las pruebas. En producción es el reloj del servidor en
-- el instante de sellar, no el del BEGIN (eso sería now()).
create function verifactu._reloj() returns timestamptz
  language sql volatile set search_path = pg_catalog, pg_temp
  as $$ select clock_timestamp() $$;

-- ── 2. Tablas ────────────────────────────────────────────────────────────────────────────────────────────

-- Configuración del emisor, candado de su cadena y cursor (ultimo_seq).
create table verifactu.emisor (
  id            integer generated always as identity primary key,
  nif           text not null unique
                constraint emisor_nif check (nif ~ '^[0-9A-Z][0-9]{7}[0-9A-Z]$'),
  zona_horaria  text not null default 'Europe/Madrid'
                constraint emisor_zona check (zona_horaria in ('Europe/Madrid', 'Atlantic/Canary', 'Africa/Ceuta')),
  activo        boolean not null default true,
  ultimo_seq    bigint not null default 0 constraint emisor_ultimo_seq check (ultimo_seq >= 0),
  creado        timestamptz not null default now()
);
comment on table verifactu.emisor is
  'Un emisor (obligado tributario) por NIF, con su propia cadena. El NIF no cambia nunca.';

-- Registros de alta y de anulación, en una sola cadena por emisor (Orden HAC/1177/2024, art. 7.c y 7.d).
create table verifactu.registro (
  id                           bigint generated always as identity primary key,
  emisor_id                    integer not null references verifactu.emisor (id),
  seq                          bigint  not null,
  tipo_registro                text    not null,
  id_emisor_factura            text    not null,
  num_serie_factura            text    not null,
  fecha_expedicion_factura     date    not null,
  tipo_factura                 text,
  cuota_total                  numeric,
  importe_total                numeric,
  subsanacion                  boolean not null default false,
  huella_anterior              text    not null,
  fecha_hora_huso_gen_registro text    not null,
  fecha_hora_gen               timestamptz not null,
  huella                       text    not null,
  constraint registro_seq_unico       unique (emisor_id, seq),
  constraint registro_sin_bifurcacion unique (emisor_id, huella_anterior),
  constraint registro_seq             check (seq >= 1),
  constraint registro_primero         check ((seq = 1) = (huella_anterior = '')),
  constraint registro_tipo_registro   check (tipo_registro in ('alta', 'anulacion')),
  constraint registro_nif             check (id_emisor_factura ~ '^[0-9A-Z][0-9]{7}[0-9A-Z]$'),
  constraint registro_num_serie       check (verifactu.num_serie_valido(num_serie_factura)),
  constraint registro_fecha           check (fecha_expedicion_factura between date '1000-01-01' and date '9999-12-31'),
  -- La fecha de expedición no va por delante del día del sellado en la zona del emisor (los 10 primeros
  -- caracteres de FechaHoraHusoGenRegistro, que ya van en esa zona).
  constraint registro_fecha_no_futura check (fecha_expedicion_factura <= substr(fecha_hora_huso_gen_registro, 1, 10)::date),
  constraint registro_campos          check (coalesce(case tipo_registro
      when 'alta' then tipo_factura in ('F1', 'F2', 'F3', 'R1', 'R2', 'R3', 'R4', 'R5')
                   and scale(cuota_total) = 2 and scale(importe_total) = 2
                   and abs(cuota_total) < 1000000000000 and abs(importe_total) < 1000000000000
      else tipo_factura is null and cuota_total is null and importe_total is null and not subsanacion end, false)),
  constraint registro_fecha_hora      check (case
      when fecha_hora_huso_gen_registro ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[+-][0-9]{2}:[0-9]{2}$'
      then fecha_hora_huso_gen_registro::timestamptz = fecha_hora_gen else false end),
  constraint registro_huella_forma    check (huella ~ '^[0-9A-F]{64}$'
                                             and (huella_anterior = '' or huella_anterior ~ '^[0-9A-F]{64}$')),
  constraint registro_huella_correcta check (coalesce(huella = verifactu.huella_registro(tipo_registro,
      id_emisor_factura, num_serie_factura, fecha_expedicion_factura, tipo_factura, cuota_total, importe_total,
      huella_anterior, fecha_hora_huso_gen_registro), false))
);
comment on table verifactu.registro is
  'Registros de facturación (altas y anulaciones) encadenados por huella. Solo se añaden: nunca se modifican ni se borran.';
comment on column verifactu.registro.seq is
  'Posición en la cadena del emisor, desde 1. No es un campo de la AEAT: seq = 1 equivale a PrimerRegistro = S.';
comment on column verifactu.registro.fecha_hora_huso_gen_registro is
  'El texto EXACTO de FechaHoraHusoGenRegistro que entró en la huella.';
comment on column verifactu.registro.fecha_hora_gen is
  'El mismo instante que fecha_hora_huso_gen_registro, como timestamptz, para poder comparar.';

create index registro_factura on verifactu.registro (emisor_id, num_serie_factura, fecha_expedicion_factura, seq);

-- Sin políticas: si un GRANT despistado llegara a dar SELECT a otro rol, seguiría sin ver ninguna fila.
alter table verifactu.emisor   enable row level security;
alter table verifactu.registro enable row level security;

-- ── 3. Disparadores ──────────────────────────────────────────────────────────────────────────────────────

-- El sellado: el único sitio donde nace un eslabón. Cualquier INSERT pasa por aquí (emitir_*, un INSERT directo
-- del propietario, varias filas en una sentencia): quien inserta no fija ni el seq, ni la huella, ni la hora,
-- ni el NIF.
create function verifactu.tg_sellar() returns trigger
  language plpgsql set search_path = pg_catalog, pg_temp
as $$
declare
  e       verifactu.emisor;
  u       verifactu.registro;
  v_pen   text;
  v_ult   text;
  v_ahora timestamptz;
begin
  -- 0. Los campos que pone la base.
  if new.seq is not null or new.id_emisor_factura is not null or new.huella is not null
     or new.huella_anterior is not null or new.fecha_hora_gen is not null
     or new.fecha_hora_huso_gen_registro is not null then
    raise exception using errcode = 'VF008',
      message = 'verifactu: seq, id_emisor_factura, huella, huella_anterior y la fecha-hora los pone la base, no quien inserta';
  end if;

  -- 1. La forma, antes de tomar el candado.
  if new.emisor_id is null then
    raise exception using errcode = 'VF002', message = 'verifactu: falta el emisor (emisor_id)';
  end if;
  if new.tipo_registro is null or new.tipo_registro not in ('alta', 'anulacion') then
    raise exception using errcode = 'VF003',
      message = format('verifactu: TipoRegistro: %s no vale; es alta o anulacion', coalesce(quote_literal(new.tipo_registro), 'nulo'));
  end if;
  new.num_serie_factura := btrim(new.num_serie_factura, ' ');
  if not verifactu.num_serie_valido(new.num_serie_factura) then
    raise exception using errcode = 'VF003', message = 'verifactu: NumSerieFactura: ' || case
      when new.num_serie_factura is null then 'falta'
      when new.num_serie_factura = '' then 'está vacío'
      when char_length(new.num_serie_factura) > 60
        then format('tiene %s caracteres y el máximo es 60', char_length(new.num_serie_factura))
      when new.num_serie_factura !~ '^[ -~]+$'
        then format('lleva U+%s en la posición %s: solo admite ASCII imprimible (del 32 al 126)',
                    upper(lpad(to_hex(ascii(substring(new.num_serie_factura from '[^ -~]'))),
                               greatest(4, length(to_hex(ascii(substring(new.num_serie_factura from '[^ -~]'))))), '0')),
                    position(substring(new.num_serie_factura from '[^ -~]') in new.num_serie_factura))
      else 'lleva un carácter no admitido (& = < > " o '')' end;
  end if;
  if new.fecha_expedicion_factura is null
     or new.fecha_expedicion_factura not between date '1000-01-01' and date '9999-12-31' then
    raise exception using errcode = 'VF003',
      message = format('verifactu: FechaExpedicionFactura: %s no vale', coalesce(new.fecha_expedicion_factura::text, 'falta'));
  end if;
  if new.subsanacion is null then
    raise exception using errcode = 'VF003', message = 'verifactu: Subsanacion: no puede ser nulo';
  end if;
  if new.tipo_registro = 'alta' then
    if new.tipo_factura is null or new.tipo_factura not in ('F1', 'F2', 'F3', 'R1', 'R2', 'R3', 'R4', 'R5') then
      raise exception using errcode = 'VF003',
        message = format('verifactu: TipoFactura: %s no vale (lista L2: F1, F2, F3, R1, R2, R3, R4, R5)',
                         coalesce(quote_literal(new.tipo_factura), 'falta'));
    end if;
    if new.cuota_total is null then
      raise exception using errcode = 'VF003', message = 'verifactu: CuotaTotal: falta (un alta la lleva siempre)';
    end if;
    if new.importe_total is null then
      raise exception using errcode = 'VF003', message = 'verifactu: ImporteTotal: falta (un alta la lleva siempre)';
    end if;
    if not (abs(new.cuota_total) < 1000000000000) then
      raise exception using errcode = 'VF003',
        message = format('verifactu: CuotaTotal: %s fuera de rango (como mucho 12 cifras enteras)', new.cuota_total);
    end if;
    if not (abs(new.importe_total) < 1000000000000) then
      raise exception using errcode = 'VF003',
        message = format('verifactu: ImporteTotal: %s fuera de rango (como mucho 12 cifras enteras)', new.importe_total);
    end if;
    if scale(trim_scale(new.cuota_total)) > 2 then
      raise exception using errcode = 'VF003',
        message = format('verifactu: CuotaTotal: %s lleva más de dos decimales; la base no redondea', new.cuota_total);
    end if;
    if scale(trim_scale(new.importe_total)) > 2 then
      raise exception using errcode = 'VF003',
        message = format('verifactu: ImporteTotal: %s lleva más de dos decimales; la base no redondea', new.importe_total);
    end if;
    new.cuota_total   := round(new.cuota_total, 2);
    new.importe_total := round(new.importe_total, 2);
  else
    if new.tipo_factura is not null or new.cuota_total is not null or new.importe_total is not null or new.subsanacion then
      raise exception using errcode = 'VF003',
        message = 'verifactu: una anulación no lleva TipoFactura, CuotaTotal, ImporteTotal ni Subsanacion';
    end if;
  end if;

  -- 2. El candado: la fila del emisor. Dos emisiones del mismo emisor van en serie; de emisores distintos, no.
  select * into e from verifactu.emisor where id = new.emisor_id for update;
  if not found then
    raise exception using errcode = 'VF002', message = format('verifactu: el emisor %s no existe', new.emisor_id);
  end if;
  if not e.activo then
    raise exception using errcode = 'VF002', message = format('verifactu: el emisor %s está desactivado', e.nif);
  end if;

  -- 3. La cola, comprobada antes de encadenar (Orden HAC/1177/2024, art. 7.i).
  select * into u from verifactu.registro r where r.emisor_id = e.id order by r.seq desc limit 1;
  if coalesce(u.seq, 0) <> e.ultimo_seq then
    raise exception using errcode = 'VF007',
      message = format('verifactu: la cola de %s no cuadra: el emisor lleva %s y el último registro es el %s',
                       e.nif, e.ultimo_seq, coalesce(u.seq, 0));
  end if;
  if u.seq > 1 then
    select r.huella into v_pen from verifactu.registro r where r.emisor_id = e.id and r.seq = u.seq - 1;
    if v_pen is distinct from u.huella_anterior then
      raise exception using errcode = 'VF007',
        message = format('verifactu: el registro %s de %s no apunta al %s', u.seq, e.nif, u.seq - 1);
    end if;
  end if;

  -- 4. La regla de apertura, por factura (NIF + NumSerieFactura + FechaExpedicionFactura).
  select r.tipo_registro into v_ult
    from verifactu.registro r
   where r.emisor_id = e.id
     and r.num_serie_factura = new.num_serie_factura
     and r.fecha_expedicion_factura = new.fecha_expedicion_factura
   order by r.seq desc
   limit 1;
  if new.tipo_registro = 'alta' and not new.subsanacion and v_ult = 'alta' then
    raise exception using errcode = 'VF004',
      message = format('verifactu: la factura %s de %s ya tiene un alta vigente', new.num_serie_factura,
                       verifactu.formato_fecha(new.fecha_expedicion_factura)),
      hint = 'Para corregirla, alta con subsanacion; para retirarla, anulacion.';
  elsif (new.tipo_registro = 'anulacion' or new.subsanacion) and v_ult is distinct from 'alta' then
    raise exception using errcode = 'VF005',
      message = format('verifactu: la factura %s de %s no tiene un alta vigente', new.num_serie_factura,
                       verifactu.formato_fecha(new.fecha_expedicion_factura));
  end if;

  -- 5. La hora: la del servidor AL SELLAR, truncada a segundos.
  v_ahora := date_trunc('second', verifactu._reloj());
  -- Nunca hacia atrás (Orden HAC/1177/2024, art. 7.e y 7.i): hasta un minuto por detrás del registro anterior se
  -- sella con la hora de ese registro; más de un minuto, VF006 y no se emite nada.
  if u.fecha_hora_gen is not null and v_ahora < u.fecha_hora_gen then
    if u.fecha_hora_gen - v_ahora > interval '1 minute' then
      raise exception using errcode = 'VF006',
        message = format('verifactu: el reloj del servidor va %s por detrás del último registro de %s',
                         u.fecha_hora_gen - v_ahora, e.nif);
    end if;
    v_ahora := u.fecha_hora_gen;
  end if;
  -- La fecha de expedición no puede ir por delante del día de hoy en la zona del emisor (la AEAT rechaza el
  -- registro). Lo vigila también el CHECK registro_fecha_no_futura.
  if new.fecha_expedicion_factura > (v_ahora at time zone e.zona_horaria)::date then
    raise exception using errcode = 'VF003',
      message = format('verifactu: FechaExpedicionFactura: %s es posterior al día del sellado (%s en %s)',
                       verifactu.formato_fecha(new.fecha_expedicion_factura),
                       verifactu.formato_fecha((v_ahora at time zone e.zona_horaria)::date), e.zona_horaria);
  end if;

  -- 6. Sellar.
  new.id_emisor_factura            := e.nif;
  new.seq                          := coalesce(u.seq, 0) + 1;
  new.huella_anterior              := coalesce(u.huella, '');
  new.fecha_hora_gen               := v_ahora;
  new.fecha_hora_huso_gen_registro := verifactu.formato_fecha_hora(v_ahora, e.zona_horaria);
  new.huella := verifactu.huella_registro(new.tipo_registro, new.id_emisor_factura, new.num_serie_factura,
                                          new.fecha_expedicion_factura, new.tipo_factura, new.cuota_total,
                                          new.importe_total, new.huella_anterior, new.fecha_hora_huso_gen_registro);
  update verifactu.emisor set ultimo_seq = new.seq where id = e.id;
  return new;
end
$$;

create function verifactu.tg_inalterable() returns trigger
  language plpgsql set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception using errcode = 'VF001',
    message = format('verifactu: %s no admite %s: los registros de facturación no se modifican ni se borran',
                     tg_table_name, tg_op),
    hint = case when tg_table_name = 'registro'
                then 'Para corregir una factura, alta con subsanacion; para retirarla, anulacion.'
                else 'Para dejar de emitir con un emisor: activo = false.' end;
end
$$;

create function verifactu.tg_emisor_guarda() returns trigger
  language plpgsql set search_path = pg_catalog, pg_temp
as $$
begin
  if new.id is distinct from old.id or new.nif is distinct from old.nif then
    raise exception using errcode = 'VF001',
      message = format('verifactu: el NIF de un emisor no cambia (%s): un NIF nuevo es un emisor nuevo, con su propia cadena',
                       old.nif);
  end if;
  -- Solo el sellado (un UPDATE lanzado desde tg_sellar, a profundidad 2) mueve ultimo_seq.
  if new.ultimo_seq is distinct from old.ultimo_seq and pg_trigger_depth() < 2 then
    raise exception using errcode = 'VF001',
      message = format('verifactu: ultimo_seq de %s solo lo mueve el sellado', old.nif);
  end if;
  return new;
end
$$;

create trigger registro_sellar before insert on verifactu.registro
  for each row execute function verifactu.tg_sellar();
create trigger registro_inalterable before update or delete or truncate on verifactu.registro
  for each statement execute function verifactu.tg_inalterable();
alter table verifactu.registro enable always trigger registro_inalterable;
create trigger emisor_guarda before update on verifactu.emisor
  for each row execute function verifactu.tg_emisor_guarda();
create trigger emisor_sin_truncate before truncate on verifactu.emisor
  for each statement execute function verifactu.tg_inalterable();
alter table verifactu.emisor enable always trigger emisor_sin_truncate;

-- ── 4. API ───────────────────────────────────────────────────────────────────────────────────────────────

create function verifactu.emitir_alta(p_nif text, p_num_serie_factura text, p_fecha_expedicion_factura date,
                                      p_tipo_factura text, p_cuota_total numeric, p_importe_total numeric,
                                      p_subsanacion boolean default false)
  returns verifactu.registro
  language plpgsql security definer set search_path = pg_catalog, pg_temp
as $$
declare
  v_emisor integer;
  r        verifactu.registro;
begin
  select e.id into v_emisor from verifactu.emisor e where e.nif = p_nif;
  if not found then
    raise exception using errcode = 'VF002', message = format('verifactu: el emisor %s no existe', coalesce(p_nif, 'nulo'));
  end if;
  insert into verifactu.registro (emisor_id, tipo_registro, num_serie_factura, fecha_expedicion_factura,
                                  tipo_factura, cuota_total, importe_total, subsanacion)
  values (v_emisor, 'alta', p_num_serie_factura, p_fecha_expedicion_factura,
          p_tipo_factura, p_cuota_total, p_importe_total, p_subsanacion)
  returning * into r;
  return r;
end
$$;

create function verifactu.emitir_anulacion(p_nif text, p_num_serie_factura text, p_fecha_expedicion_factura date)
  returns verifactu.registro
  language plpgsql security definer set search_path = pg_catalog, pg_temp
as $$
declare
  v_emisor integer;
  r        verifactu.registro;
begin
  select e.id into v_emisor from verifactu.emisor e where e.nif = p_nif;
  if not found then
    raise exception using errcode = 'VF002', message = format('verifactu: el emisor %s no existe', coalesce(p_nif, 'nulo'));
  end if;
  insert into verifactu.registro (emisor_id, tipo_registro, num_serie_factura, fecha_expedicion_factura)
  values (v_emisor, 'anulacion', p_num_serie_factura, p_fecha_expedicion_factura)
  returning * into r;
  return r;
end
$$;

-- Una línea JSON por registro, con los nombres de la AEAT y en orden de seq. RegistroAnterior lleva NIF, serie,
-- fecha y huella del registro anterior (Orden HAC/1177/2024, art. 7.a); la huella es la que entró en ESTE
-- registro. Para NDJSON: PGCLIENTENCODING=UTF8 psql -XAt -c "select verifactu.exportar_cadena('…')" (COPY no:
-- duplica las «\»).
create function verifactu.exportar_cadena(p_nif text, p_desde_seq bigint default 1)
  returns setof json
  language plpgsql stable security definer set search_path = pg_catalog, pg_temp
as $$
declare
  v_emisor integer;
begin
  select e.id into v_emisor from verifactu.emisor e where e.nif = p_nif;
  if not found then
    raise exception using errcode = 'VF002', message = format('verifactu: el emisor %s no existe', coalesce(p_nif, 'nulo'));
  end if;
  return query
  select ('{"seq":' || r.seq
       || ',"TipoRegistro":' || to_json(r.tipo_registro)::text
       || case r.tipo_registro
            when 'alta' then
                 ',"IDEmisorFactura":' || to_json(r.id_emisor_factura)::text
              || ',"NumSerieFactura":' || to_json(r.num_serie_factura)::text
              || ',"FechaExpedicionFactura":' || to_json(verifactu.formato_fecha(r.fecha_expedicion_factura))::text
              || ',"TipoFactura":' || to_json(r.tipo_factura)::text
              || ',"CuotaTotal":' || to_json(verifactu.formato_importe(r.cuota_total))::text
              || ',"ImporteTotal":' || to_json(verifactu.formato_importe(r.importe_total))::text
              || ',"Subsanacion":' || case when r.subsanacion then '"S"' else '"N"' end
            else
                 ',"IDEmisorFacturaAnulada":' || to_json(r.id_emisor_factura)::text
              || ',"NumSerieFacturaAnulada":' || to_json(r.num_serie_factura)::text
              || ',"FechaExpedicionFacturaAnulada":' || to_json(verifactu.formato_fecha(r.fecha_expedicion_factura))::text
          end
       || ',"Encadenamiento":' || case when r.seq = 1 then '{"PrimerRegistro":"S"}' else
               '{"RegistroAnterior":{"IDEmisorFactura":' || coalesce(to_json(a.id_emisor_factura)::text, 'null')
            || ',"NumSerieFactura":' || coalesce(to_json(a.num_serie_factura)::text, 'null')
            || ',"FechaExpedicionFactura":' || coalesce(to_json(verifactu.formato_fecha(a.fecha_expedicion_factura))::text, 'null')
            || ',"Huella":' || to_json(r.huella_anterior)::text || '}}' end
       || ',"FechaHoraHusoGenRegistro":' || to_json(r.fecha_hora_huso_gen_registro)::text
       || ',"TipoHuella":"01","Huella":' || to_json(r.huella)::text
       || '}')::json
    from verifactu.registro r
    left join verifactu.registro a on a.emisor_id = r.emisor_id and a.seq = r.seq - 1
   where r.emisor_id = v_emisor and r.seq >= coalesce(p_desde_seq, 1)
   order by r.seq;
end
$$;

-- Recorre la cadena entera de un emisor y devuelve el primer eslabón roto y su motivo, o ok. Con ancla (un seq y
-- su huella anotados FUERA de la base), detecta también la vuelta a una copia vieja.
create function verifactu.verificar_cadena(p_nif text, p_ancla_seq bigint default null, p_ancla_huella text default null)
  returns table (ok boolean, registros bigint, seq bigint, motivo text, detalle text, ultima_huella text)
  language plpgsql stable security definer set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  v_emisor verifactu.emisor;
  v_total  bigint;
  v_ultimo bigint;
  v_ultima text;
  v_fallo  record;
  v_ancla  text;
begin
  if (p_ancla_seq is null) <> (p_ancla_huella is null) then
    raise exception using errcode = 'VF003', message = 'verifactu: el ancla lleva las dos cosas: el seq y su huella';
  end if;
  if p_ancla_huella !~ '^[0-9A-F]{64}$' then
    raise exception using errcode = 'VF003', message = 'verifactu: la huella del ancla son 64 caracteres hexadecimales en mayúsculas';
  end if;
  select * into v_emisor from verifactu.emisor e where e.nif = p_nif;
  if not found then
    raise exception using errcode = 'VF002', message = format('verifactu: el emisor %s no existe', coalesce(p_nif, 'nulo'));
  end if;
  select count(*), max(r.seq) into v_total, v_ultimo from verifactu.registro r where r.emisor_id = v_emisor.id;
  select r.huella into v_ultima from verifactu.registro r where r.emisor_id = v_emisor.id order by r.seq desc limit 1;

  select x.seq, m.motivo, case m.motivo
           when 'secuencia' then format('se esperaba el registro %s y aparece el %s', x.pos, x.seq)
           when 'encadenamiento' then format('el registro %s no apunta al %s: su huella anterior es %s y la del %s es %s',
                                             x.seq, x.seq - 1, coalesce(nullif(x.huella_anterior, ''), 'vacía'),
                                             x.seq - 1, coalesce(x.huella_previa, 'ninguna'))
           when 'emisor' then format('el registro %s lleva el NIF %s y el emisor es %s', x.seq, x.id_emisor_factura, v_emisor.nif)
           when 'huella' then format('la huella guardada del registro %s no es la que sale de sus datos', x.seq)
           when 'fecha_hora_retrocede' then format('el registro %s (%s) es anterior al %s', x.seq,
                                                   x.fecha_hora_huso_gen_registro, x.seq - 1)
           when 'fecha_hora_futura' then format('el registro %s (%s) va más de un minuto por delante del reloj del servidor',
                                                x.seq, x.fecha_hora_huso_gen_registro)
           when 'regla_apertura' then format('registro %s: la factura %s de %s %s', x.seq, x.num_serie_factura,
                                             verifactu.formato_fecha(x.fecha_expedicion_factura),
                                             case when x.tipo_registro = 'alta' and not x.subsanacion
                                                  then 'ya tenía un alta vigente' else 'no tenía un alta vigente' end)
         end as detalle
    into v_fallo
    from (select r.*,
                 row_number() over w as pos,
                 lag(r.huella) over w as huella_previa,
                 lag(r.fecha_hora_gen) over w as hora_previa,
                 lag(r.tipo_registro) over (partition by r.num_serie_factura, r.fecha_expedicion_factura order by r.seq)
                   as tipo_previo_factura,
                 case when r.tipo_registro = 'alta'
                       and not coalesce(scale(trim_scale(r.cuota_total)) <= 2 and abs(r.cuota_total) < 1000000000000
                                    and scale(trim_scale(r.importe_total)) <= 2 and abs(r.importe_total) < 1000000000000, false)
                      then null
                      else verifactu.huella_registro(r.tipo_registro, r.id_emisor_factura, r.num_serie_factura,
                                                     r.fecha_expedicion_factura, r.tipo_factura, r.cuota_total,
                                                     r.importe_total, r.huella_anterior, r.fecha_hora_huso_gen_registro)
                 end as huella_calculada
            from verifactu.registro r
           where r.emisor_id = v_emisor.id
          window w as (order by r.seq)) x
    cross join lateral (select case
             when x.seq is distinct from x.pos then 'secuencia'
             when x.huella_anterior is distinct from coalesce(x.huella_previa, '') then 'encadenamiento'
             when x.id_emisor_factura is distinct from v_emisor.nif then 'emisor'
             when x.huella is distinct from x.huella_calculada then 'huella'
             when x.fecha_hora_gen < x.hora_previa then 'fecha_hora_retrocede'
             when x.fecha_hora_gen > now() + interval '1 minute' then 'fecha_hora_futura'
             when x.tipo_registro = 'alta' and not x.subsanacion and x.tipo_previo_factura = 'alta' then 'regla_apertura'
             when (x.tipo_registro = 'anulacion' or x.subsanacion)
                  and x.tipo_previo_factura is distinct from 'alta' then 'regla_apertura'
           end as motivo) m
   where m.motivo is not null
   order by x.seq
   limit 1;
  if found then
    return query select false, v_total, v_fallo.seq::bigint, v_fallo.motivo::text, v_fallo.detalle::text, v_ultima;
    return;
  end if;

  if coalesce(v_ultimo, 0) <> v_emisor.ultimo_seq then
    return query select false, v_total, least(coalesce(v_ultimo, 0), v_emisor.ultimo_seq) + 1, 'cola'::text,
      format('el emisor dice que la cadena termina en el %s y el último registro que hay es el %s',
             v_emisor.ultimo_seq, coalesce(v_ultimo, 0)), v_ultima;
    return;
  end if;

  if p_ancla_seq is not null then
    select r.huella into v_ancla from verifactu.registro r where r.emisor_id = v_emisor.id and r.seq = p_ancla_seq;
    if not found then
      return query select false, v_total, p_ancla_seq, 'ancla'::text,
        format('no existe el registro %s del ancla: la cadena termina en el %s', p_ancla_seq, coalesce(v_ultimo, 0)),
        v_ultima;
      return;
    end if;
    if v_ancla <> p_ancla_huella then
      return query select false, v_total, p_ancla_seq, 'ancla'::text,
        format('la huella del registro %s no es la anclada', p_ancla_seq), v_ultima;
      return;
    end if;
  end if;

  return query select true, v_total, null::bigint, null::text, null::text, v_ultima;
end
$$;

-- ── 5. Comentarios de la API ─────────────────────────────────────────────────────────────────────────────
comment on function verifactu.emitir_alta(text, text, date, text, numeric, numeric, boolean) is
  'Sella un registro de alta en la cadena del emisor y devuelve la fila completa (seq, huella, hora...).';
comment on function verifactu.emitir_anulacion(text, text, date) is
  'Sella un registro de anulación de una factura con alta vigente y devuelve la fila completa.';
comment on function verifactu.exportar_cadena(text, bigint) is
  'Una línea JSON por registro, con los nombres de campo de la AEAT, en orden de seq.';
comment on function verifactu.verificar_cadena(text, bigint, text) is
  'Primer eslabón roto y su motivo, u ok. Con ancla externa (seq, huella) detecta también una copia vieja restaurada.';

-- ── 6. Permisos ──────────────────────────────────────────────────────────────────────────────────────────
-- De serie, nadie salvo el propietario. Primero PUBLIC, de forma explícita; después, cualquier otro rol que haya
-- recibido algo por privilegios por defecto (por ejemplo anon, authenticated o service_role en Supabase).
revoke all on schema verifactu from public;
revoke all on all tables in schema verifactu from public;
revoke all on all sequences in schema verifactu from public;
revoke all on all functions in schema verifactu from public;

do $permisos$
declare
  v_objeto record;
begin
  for v_objeto in
    select format('schema %I', n.nspname) as objeto, a.grantee
      from pg_namespace n
      cross join lateral aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
     where n.nspname = 'verifactu' and a.grantee <> n.nspowner
    union
    select format('%s %I.%I', case c.relkind when 'S' then 'sequence' else 'table' end, 'verifactu', c.relname),
           a.grantee
      from pg_class c
      cross join lateral aclexplode(coalesce(c.relacl,
                   acldefault((case c.relkind when 'S' then 's' else 'r' end)::"char", c.relowner))) a
     where c.relnamespace = 'verifactu'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'S')
       and a.grantee <> c.relowner
    union
    select format('function %s', p.oid::regprocedure), a.grantee
      from pg_proc p
      cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
     where p.pronamespace = 'verifactu'::regnamespace and a.grantee <> p.proowner
  loop
    execute format('revoke all on %s from %s', v_objeto.objeto,
                   case when v_objeto.grantee = 0 then 'public' else quote_ident(pg_get_userbyid(v_objeto.grantee)) end);
  end loop;
end
$permisos$;
-- ── fin de permisos

commit;
