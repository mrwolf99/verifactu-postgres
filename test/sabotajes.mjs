// Los sabotajes: cada uno rompe a propósito UNA guarda, en una COPIA del fichero (nunca en el original), y
// exige que SU prueba caiga en rojo con SU causa. Si la prueba sigue en verde, la guarda no protege nada; si cae
// por otro motivo, el rojo no es suyo y no demuestra nada.
//
// Antes de creerse un rojo se comprueba que el sabotaje SE APLICÓ: el ancla casa exactamente una vez, el texto
// de la copia cambió y el ancla ya no está. Una sustitución que no casa no falla: no se aplica, y la batería
// correría contra código sano.
//
// «tambien»: otras pruebas que cubren el MISMO defecto por otro lado y tienen que caer también (por ejemplo, un
// orden de campos cambiado lo ven la prueba de los ejemplos oficiales y la de paridad SQL-JS). Se declaran aquí
// una a una: un rojo que no esté declarado hace que el sabotaje cuente como NO CAZADO.

import fs from "node:fs";
import path from "node:path";

const SQL = "sql/verifactu.sql";
const JS = "js/verifactu.mjs";

export const SABOTAJES = [
  {
    id: "sab-candado",
    fichero: SQL,
    que: "quitar el FOR UPDATE del candado del emisor",
    ancla: "  select * into e from verifactu.emisor where id = new.emisor_id for update;\n",
    reemplazo: "  select * into e from verifactu.emisor where id = new.emisor_id;\n",
    prueba: "05",
    causa: /23505.*registro_seq_unico/,
  },
  {
    id: "sab-inalterable",
    fichero: SQL,
    que: "quitar el disparador de inalterabilidad de verifactu.registro",
    ancla: "create trigger registro_inalterable before update or delete or truncate on verifactu.registro\n"
      + "  for each statement execute function verifactu.tg_inalterable();\n"
      + "alter table verifactu.registro enable always trigger registro_inalterable;\n",
    reemplazo: "-- (sabotaje: sin disparador de inalterabilidad)\n",
    prueba: "09",
    causa: /dueño.*NO FALLÓ/,
  },
  {
    id: "sab-orden-sql",
    fichero: SQL,
    que: "cambiar de orden CuotaTotal e ImporteTotal en la cadena SQL",
    ancla: "            || '&CuotaTotal=' || verifactu.formato_importe(p_cuota)\n"
      + "            || '&ImporteTotal=' || verifactu.formato_importe(p_total)\n",
    reemplazo: "            || '&ImporteTotal=' || verifactu.formato_importe(p_total)\n"
      + "            || '&CuotaTotal=' || verifactu.formato_importe(p_cuota)\n",
    prueba: "01",
    causa: /caso 1.*cadena es distinta/,
    tambien: ["02", "04", "11", "16"],
  },
  {
    id: "sab-sin-bifurcacion",
    fichero: SQL,
    que: "quitar la UNIQUE (emisor_id, huella_anterior)",
    ancla: "  constraint registro_sin_bifurcacion unique (emisor_id, huella_anterior),\n",
    reemplazo: "",
    prueba: "08",
    causa: /rama aceptada/,
  },
  {
    id: "sab-reloj-now",
    fichero: SQL,
    que: "sellar con now() (la hora del BEGIN) en vez de clock_timestamp()",
    ancla: "  as $$ select clock_timestamp() $$;\n",
    reemplazo: "  as $$ select now() $$;\n",
    prueba: "10",
    causa: /hora del BEGIN/,
  },
  {
    id: "sab-sin-tope",
    fichero: SQL,
    que: "quitar el tope que impide que la hora retroceda",
    desde: "  if u.fecha_hora_gen is not null and v_ahora < u.fecha_hora_gen then\n",
    hasta: "    v_ahora := u.fecha_hora_gen;\n  end if;\n",
    reemplazo: "",
    prueba: "10",
    causa: /anterior a la del registro previo.*fecha_hora_retrocede/,
  },
  {
    id: "sab-verificar-sin-huella",
    fichero: SQL,
    que: "quitar de verificar_cadena la comprobación de la huella",
    ancla: "             when x.huella is distinct from x.huella_calculada then 'huella'\n",
    reemplazo: "",
    prueba: "11",
    causa: /SQL.*cuota del 5 cambiada.*ok/,
  },
  {
    id: "sab-orden-js",
    fichero: JS,
    que: "cambiar de orden CuotaTotal e ImporteTotal en la cadena JS",
    ancla: "    + \"&CuotaTotal=\" + importe(\"CuotaTotal\", c.CuotaTotal)\n"
      + "    + \"&ImporteTotal=\" + importe(\"ImporteTotal\", c.ImporteTotal)\n",
    reemplazo: "    + \"&ImporteTotal=\" + importe(\"ImporteTotal\", c.ImporteTotal)\n"
      + "    + \"&CuotaTotal=\" + importe(\"CuotaTotal\", c.CuotaTotal)\n",
    prueba: "03",
    causa: /caso 1.*cadena es distinta/,
    tambien: ["04", "11"],
  },
  {
    id: "sab-js-sin-enlace",
    fichero: JS,
    que: "quitar de verificarCadena (JS) la comprobación de que cada registro apunta al anterior",
    ancla: "      if (anterior !== previo.huella) return fallo(seq, \"encadenamiento\", `el registro ${seq} no apunta al ${previo.seq}`);\n",
    reemplazo: "",
    prueba: "11",
    causa: /JS.*seq 2 alterado.*ok/,
    tambien: ["03"],
  },
  {
    id: "sab-sin-revoke",
    fichero: SQL,
    que: "quitar el bloque de permisos (los REVOKE)",
    desde: "-- ── 6. Permisos",
    hasta: "-- ── fin de permisos\n",
    reemplazo: "",
    prueba: "14",
    causa: /PUBLIC.*EXECUTE/,
  },
];

function contar(texto, trozo) {
  return trozo === "" ? 0 : texto.split(trozo).length - 1;
}

/** Aplica el sabotaje a la copia que hay en «destino». Devuelve si se aplicó de verdad y cómo. */
export function aplicarSabotaje(s, { raiz, destino }) {
  const antes = fs.readFileSync(path.join(raiz, s.fichero), "utf8");
  let ancla = s.ancla;
  if (s.desde !== undefined) {
    const nd = contar(antes, s.desde);
    const nh = contar(antes, s.hasta);
    if (nd !== 1 || nh !== 1) {
      return { aplicado: false, motivo: `el ancla de inicio casa ${nd} veces y la de fin ${nh} (tiene que ser 1 y 1)` };
    }
    const i = antes.indexOf(s.desde);
    const j = antes.indexOf(s.hasta) + s.hasta.length;
    if (j <= i) return { aplicado: false, motivo: "el ancla de fin va antes que la de inicio" };
    ancla = antes.slice(i, j);
  }
  const coincidencias = contar(antes, ancla);
  if (coincidencias !== 1) return { aplicado: false, motivo: `el ancla casa ${coincidencias} veces (tiene que ser exactamente 1)` };
  const despues = antes.replace(ancla, () => s.reemplazo);
  const ruta = path.join(destino, path.basename(s.fichero));
  fs.writeFileSync(ruta, despues);
  const releido = fs.readFileSync(ruta, "utf8");
  if (releido === antes) return { aplicado: false, motivo: "el texto de la copia no cambió" };
  if (releido !== despues) return { aplicado: false, motivo: "la copia no quedó como se escribió" };
  const anclaAusente = !releido.includes(ancla);
  if (!anclaAusente) return { aplicado: false, motivo: "el ancla sigue en la copia" };
  return { aplicado: true, coincidencias, antes, despues: releido, anclaAusente, bytes: [Buffer.byteLength(antes), Buffer.byteLength(releido)] };
}
