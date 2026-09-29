-- verifactu-postgres · ejemplo 1: empezar
--
-- Con la librería ya instalada en esta base (sql/verifactu.sql):
--   psql -X -v ON_ERROR_STOP=1 -d <base> -f ejemplos/01-empezar.sql
--
-- 89890001K es el NIF ficticio de los ejemplos de la AEAT. La hora la pone el reloj del servidor, así que estas
-- huellas no son las del ejemplo oficial (esas se reproducen con el reloj fijado en test/pruebas/02).

-- 1. Alta del emisor, una vez. La zona decide el huso de FechaHoraHusoGenRegistro.
insert into verifactu.emisor (nif, zona_horaria) values ('89890001K', 'Europe/Madrid');

-- 2. Emitir. Devuelve la fila sellada entera (seq, huella, hora...). Úsala con «select ... from»: con la forma
--    «select (verifactu.emitir_alta(...)).*», PostgreSQL llama a la función una vez por columna.
select seq, huella, fecha_hora_huso_gen_registro
  from verifactu.emitir_alta('89890001K', '12345678/G33', date '2024-01-01', 'F1', 12.35, 123.45);

select seq, huella, fecha_hora_huso_gen_registro
  from verifactu.emitir_alta('89890001K', '12345679/G34', date '2024-01-01', 'F1', 12.35, 123.45);

-- 3. Corregir o retirar: nunca con UPDATE ni DELETE (dan VF001). Una subsanación es un alta nueva de la misma
--    factura; retirarla es un registro de anulación.
select seq, huella
  from verifactu.emitir_alta('89890001K', '12345679/G34', date '2024-01-01', 'F1', 12.60, 123.70, true);

select seq, huella
  from verifactu.emitir_anulacion('89890001K', '12345679/G34', date '2024-01-01');

-- 4. Exportar: una línea JSON por registro, con los nombres de la AEAT. Para un fichero NDJSON:
--      psql -XAt -d <base> -c "select verifactu.exportar_cadena('89890001K')" > cadena.ndjson
--    (con COPY no: su formato de texto duplica las barras invertidas y el JSON deja de ser el mismo).
select verifactu.exportar_cadena('89890001K');

-- 5. Verificar. Guarda FUERA de la base el último seq y su huella (ultima_huella): pasados como ancla, una copia
--    vieja restaurada deja de dar ok.
select * from verifactu.verificar_cadena('89890001K');
