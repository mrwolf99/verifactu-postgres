// Una cadena rica con dos emisores intercalados: verificación SQL y JS en ok, y la cadena y la huella del JS
// iguales a las del SQL, fila a fila.
import { CADENA_RICA, NIF_A, NIF_B, exportar, sembrar } from "../lib/cadena.mjs";
import { lit } from "../lib/contexto.mjs";

export const descripcion = "Cadena rica, dos emisores: verificación SQL y JS en ok; cadena y huella JS = SQL fila a fila";

export default async function (t) {
  const v = await t.js();
  const db = await t.base();
  const selladas = await sembrar(t, db);

  // Cada emisor lleva su propia cadena: los seq de cada uno van de 1 en 1 aunque se intercalen.
  for (const nif of [NIF_A, NIF_B]) {
    const propias = selladas.filter((s) => s.nif === nif).map((s) => Number(s.seq));
    t.igual(propias.join(","), propias.map((_, i) => i + 1).join(","), `${nif}: seq propios y seguidos`);
  }

  for (const nif of [NIF_A, NIF_B]) {
    const [ver] = await t.objetos(db, `select * from verifactu.verificar_cadena(${lit(nif)})`);
    t.igual(ver.ok, "t", `${nif}: verificar_cadena (SQL) → ${ver.motivo} en ${ver.seq}: ${ver.detalle}`);
    const esperados = CADENA_RICA.filter((r) => r[0] === nif).length;
    t.igual(ver.registros, String(esperados), `${nif}: registros`);

    const cadena = await exportar(t, db, nif);
    t.igual(cadena.length, esperados, `${nif}: líneas exportadas`);
    const res = await v.verificarCadena(cadena, { nif });
    t.ok(res.ok, `${nif}: verificarCadena (JS) no da ok: ${res.motivo} en ${res.seq}: ${res.detalle}`);
    t.igual(res.ultimaHuella, ver.ultima_huella, `${nif}: última huella JS = SQL`);

    const filas = await t.objetos(db, `
      select r.seq, r.huella,
             case r.tipo_registro
               when 'alta' then verifactu.cadena_alta(r.id_emisor_factura, r.num_serie_factura, r.fecha_expedicion_factura,
                                  r.tipo_factura, r.cuota_total, r.importe_total, r.huella_anterior, r.fecha_hora_huso_gen_registro)
               else verifactu.cadena_anulacion(r.id_emisor_factura, r.num_serie_factura, r.fecha_expedicion_factura,
                                  r.huella_anterior, r.fecha_hora_huso_gen_registro)
             end as cadena
        from verifactu.registro r join verifactu.emisor e on e.id = r.emisor_id
       where e.nif = ${lit(nif)} order by r.seq`);
    for (const [i, reg] of cadena.entries()) {
      const anterior = reg.Encadenamiento.RegistroAnterior?.Huella ?? "";
      const cadenaJs = reg.TipoRegistro === "alta"
        ? v.cadenaAlta({ ...reg, HuellaAnterior: anterior })
        : v.cadenaAnulacion({ IDEmisorFactura: reg.IDEmisorFacturaAnulada, NumSerieFactura: reg.NumSerieFacturaAnulada,
          FechaExpedicionFactura: reg.FechaExpedicionFacturaAnulada, HuellaAnterior: anterior,
          FechaHoraHusoGenRegistro: reg.FechaHoraHusoGenRegistro });
      t.igual(cadenaJs, filas[i].cadena, `${nif} seq ${reg.seq}: cadena JS = cadena SQL`);
      t.igual(await v.huellaRegistro(reg), filas[i].huella, `${nif} seq ${reg.seq}: huella JS = huella SQL`);
    }
  }

  // Lo que la base normaliza al sellar, y lo que conserva.
  const a = await exportar(t, db, NIF_A);
  t.igual(a[7].NumSerieFactura, "12345678 / G34", "los espacios exteriores se recortan y los interiores se quedan");
  t.igual(a[10].CuotaTotal + "|" + a[10].ImporteTotal, "7.00|42.00", "7 y 42 se escriben con dos decimales");
  t.igual(a[11].CuotaTotal + "|" + a[11].ImporteTotal, "0.10|0.60", "0.1 y 0.6 se escriben con dos decimales");
  t.igual(a[3].NumSerieFactura, "R-2024\\4", "la barra invertida viaja intacta por el JSON");
  t.igual(a[8].NumSerieFactura, "X".repeat(59) + "\u{1F600}", "60 puntos de código");
  t.igual(a[4].Subsanacion, "S", "la subsanación se exporta como S");
}
