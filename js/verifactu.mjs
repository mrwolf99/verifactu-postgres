// verifactu-postgres 0.1.0 · helper JS sin dependencias ni compilación (Node >= 18, Deno y navegadores).
//
// Calcula la cadena y la huella de un registro VERI*FACTU (especificación de la AEAT v0.1.2, 27/08/2024) y
// verifica una cadena exportada con verifactu.exportar_cadena(). Es ESTRICTO: no normaliza nada. Valida y, si
// algo no tiene la forma exacta que escribe la base, lanza ErrorFormato. Así no puede divergir del SQL por un
// recorte o un redondeo distinto.
//
// Licencia MIT.

export const VERSION = "0.1.0";

const TIPOS_FACTURA = ["F1", "F2", "F3", "R1", "R2", "R3", "R4", "R5"];
const RE_NIF = /^[0-9A-Z][0-9]{7}[0-9A-Z]$/;
const RE_FECHA = /^([0-9]{2})-([0-9]{2})-([0-9]{4})$/;
const RE_IMPORTE = /^-?(?:0|[1-9][0-9]{0,11})\.[0-9]{2}$/;
const RE_FECHA_HORA = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})([+-])([0-9]{2}):([0-9]{2})$/;
const RE_HUELLA = /^[0-9A-F]{64}$/;
// El mismo juego que el SQL: & = < > " ' y los controles U+0000–U+001F y U+007F–U+009F.
const RE_PROHIBIDOS = /[\u0000-\u001f\u007f-\u009f&=<>"']/;
const RE_SURROGADO_SUELTO = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

export class ErrorFormato extends Error {
  constructor(campo, mensaje) {
    super(`verifactu: ${campo}: ${mensaje}`);
    this.name = "ErrorFormato";
    this.campo = campo;
  }
}

function describir(v) {
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  return typeof v;
}

function texto(campo, v) {
  if (typeof v !== "string") throw new ErrorFormato(campo, `tiene que ser texto y es ${describir(v)}`);
  return v;
}

function nif(campo, v) {
  texto(campo, v);
  if (!RE_NIF.test(v)) {
    throw new ErrorFormato(campo, `${describir(v)} no tiene forma de NIF (9 caracteres, mayúsculas y sin espacios)`);
  }
  return v;
}

function numSerie(campo, v) {
  texto(campo, v);
  const largo = [...v].length; // puntos de código, como char_length() en PostgreSQL
  if (largo === 0) throw new ErrorFormato(campo, "está vacío");
  if (largo > 60) throw new ErrorFormato(campo, `tiene ${largo} caracteres y el máximo es 60`);
  if (v.startsWith(" ") || v.endsWith(" ")) {
    throw new ErrorFormato(campo, "lleva espacios al principio o al final; la huella se calcula sin ellos y este helper no recorta");
  }
  if (RE_PROHIBIDOS.test(v)) {
    throw new ErrorFormato(campo, "lleva un carácter no admitido (& = < > \" ' o un carácter de control)");
  }
  if (RE_SURROGADO_SUELTO.test(v)) throw new ErrorFormato(campo, "lleva un carácter UTF-16 mal formado");
  return v;
}

function diasDelMes(anio, mes) {
  return new Date(Date.UTC(anio, mes, 0)).getUTCDate();
}

function fecha(campo, v) {
  texto(campo, v);
  const m = RE_FECHA.exec(v);
  if (!m) throw new ErrorFormato(campo, `${describir(v)} no es dd-mm-aaaa`);
  const dia = Number(m[1]), mes = Number(m[2]), anio = Number(m[3]);
  if (anio < 1000 || mes < 1 || mes > 12 || dia < 1 || dia > diasDelMes(anio, mes)) {
    throw new ErrorFormato(campo, `${describir(v)} no es una fecha que exista`);
  }
  return v;
}

function tipoFactura(campo, v) {
  texto(campo, v);
  if (!TIPOS_FACTURA.includes(v)) {
    throw new ErrorFormato(campo, `${describir(v)} no vale (lista L2: ${TIPOS_FACTURA.join(", ")})`);
  }
  return v;
}

function importe(campo, v) {
  texto(campo, v);
  if (!RE_IMPORTE.test(v) || v === "-0.00") {
    throw new ErrorFormato(campo, `${describir(v)} no es un importe con dos decimales y punto, sin «+» (como lo escribe la base)`);
  }
  return v;
}

function huella(campo, v, admiteVacia) {
  texto(campo, v);
  if (admiteVacia && v === "") return v;
  if (!RE_HUELLA.test(v)) throw new ErrorFormato(campo, "no son 64 caracteres hexadecimales en mayúsculas");
  return v;
}

function instante(campo, v) {
  texto(campo, v);
  const m = RE_FECHA_HORA.exec(v);
  if (!m) throw new ErrorFormato(campo, `${describir(v)} no es AAAA-MM-DDThh:mm:ss±hh:mm`);
  const [anio, mes, dia, h, min, s, , hh, mm] = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => Number(m[i]));
  if (anio < 1000 || mes < 1 || mes > 12 || dia < 1 || dia > diasDelMes(anio, mes) || h > 23 || min > 59 || s > 59
      || hh > 14 || mm > 59) {
    throw new ErrorFormato(campo, `${describir(v)} no es una fecha y hora que exista`);
  }
  return Date.parse(v);
}

function objeto(campo, v) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new ErrorFormato(campo, `tiene que ser un objeto y es ${describir(v)}`);
  }
  return v;
}

export function cadenaAlta(c) {
  objeto("registro", c);
  instante("FechaHoraHusoGenRegistro", c.FechaHoraHusoGenRegistro);
  return "IDEmisorFactura=" + nif("IDEmisorFactura", c.IDEmisorFactura)
    + "&NumSerieFactura=" + numSerie("NumSerieFactura", c.NumSerieFactura)
    + "&FechaExpedicionFactura=" + fecha("FechaExpedicionFactura", c.FechaExpedicionFactura)
    + "&TipoFactura=" + tipoFactura("TipoFactura", c.TipoFactura)
    + "&CuotaTotal=" + importe("CuotaTotal", c.CuotaTotal)
    + "&ImporteTotal=" + importe("ImporteTotal", c.ImporteTotal)
    + "&Huella=" + huella("HuellaAnterior", c.HuellaAnterior, true)
    + "&FechaHoraHusoGenRegistro=" + c.FechaHoraHusoGenRegistro;
}

export function cadenaAnulacion(c) {
  objeto("registro", c);
  instante("FechaHoraHusoGenRegistro", c.FechaHoraHusoGenRegistro);
  return "IDEmisorFacturaAnulada=" + nif("IDEmisorFactura", c.IDEmisorFactura)
    + "&NumSerieFacturaAnulada=" + numSerie("NumSerieFactura", c.NumSerieFactura)
    + "&FechaExpedicionFacturaAnulada=" + fecha("FechaExpedicionFactura", c.FechaExpedicionFactura)
    + "&Huella=" + huella("HuellaAnterior", c.HuellaAnterior, true)
    + "&FechaHoraHusoGenRegistro=" + c.FechaHoraHusoGenRegistro;
}

async function digestoSha256(bytes) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (subtle) return new Uint8Array(await subtle.digest("SHA-256", bytes));
  // Node 18 no tiene crypto global de serie: respaldo con node:crypto.
  const nodeCrypto = await import("node:crypto");
  return new Uint8Array(nodeCrypto.createHash("sha256").update(bytes).digest());
}

export async function sha256Hex(textoPlano) {
  texto("texto", textoPlano);
  if (RE_SURROGADO_SUELTO.test(textoPlano)) throw new ErrorFormato("texto", "lleva un carácter UTF-16 mal formado");
  const digesto = await digestoSha256(new TextEncoder().encode(textoPlano));
  let hex = "";
  for (const b of digesto) hex += b.toString(16).padStart(2, "0");
  return hex.toUpperCase();
}

// La huella anterior que entró en el registro: "" en el primero; si no, la de Encadenamiento.RegistroAnterior.
function huellaAnteriorDe(r) {
  const enc = objeto("Encadenamiento", r.Encadenamiento);
  const tienePrimero = Object.prototype.hasOwnProperty.call(enc, "PrimerRegistro");
  const tieneAnterior = Object.prototype.hasOwnProperty.call(enc, "RegistroAnterior");
  if (tienePrimero && !tieneAnterior && enc.PrimerRegistro === "S") return "";
  if (tieneAnterior && !tienePrimero) {
    const ra = objeto("RegistroAnterior", enc.RegistroAnterior);
    return huella("RegistroAnterior.Huella", ra.Huella, false);
  }
  throw new ErrorFormato("Encadenamiento", "lleva PrimerRegistro = \"S\" o RegistroAnterior, y solo uno de los dos");
}

// NIF, número y fecha de la factura del registro, sea alta o anulación.
function factura(r) {
  if (r.TipoRegistro === "alta") {
    return { nif: r.IDEmisorFactura, num: r.NumSerieFactura, fecha: r.FechaExpedicionFactura };
  }
  if (r.TipoRegistro === "anulacion") {
    return { nif: r.IDEmisorFacturaAnulada, num: r.NumSerieFacturaAnulada, fecha: r.FechaExpedicionFacturaAnulada };
  }
  throw new ErrorFormato("TipoRegistro", `${describir(r.TipoRegistro)} no vale; es alta o anulacion`);
}

function cadenaDeRegistro(r) {
  objeto("registro", r);
  const anterior = huellaAnteriorDe(r);
  const f = factura(r);
  if (r.TipoRegistro === "alta") {
    if (r.Subsanacion !== "S" && r.Subsanacion !== "N") {
      throw new ErrorFormato("Subsanacion", `${describir(r.Subsanacion)} no vale; es "S" o "N"`);
    }
    return cadenaAlta({
      IDEmisorFactura: f.nif, NumSerieFactura: f.num, FechaExpedicionFactura: f.fecha,
      TipoFactura: r.TipoFactura, CuotaTotal: r.CuotaTotal, ImporteTotal: r.ImporteTotal,
      HuellaAnterior: anterior, FechaHoraHusoGenRegistro: r.FechaHoraHusoGenRegistro,
    });
  }
  return cadenaAnulacion({
    IDEmisorFactura: f.nif, NumSerieFactura: f.num, FechaExpedicionFactura: f.fecha,
    HuellaAnterior: anterior, FechaHoraHusoGenRegistro: r.FechaHoraHusoGenRegistro,
  });
}

export async function huellaRegistro(r) {
  return sha256Hex(cadenaDeRegistro(r));
}

// Recorre una cadena exportada (en orden de seq, desde el 1) y devuelve el primer eslabón roto y su motivo, u ok.
// Mismo orden de motivos que verifactu.verificar_cadena(). No ve «cola» (no conoce el cursor del emisor); ve
// «ancla» si se le pasa una.
export async function verificarCadena(registros, opciones = {}) {
  const op = opciones ?? {};
  const nifEsperado = op.nif ?? null;
  if (nifEsperado !== null) nif("opciones.nif", nifEsperado);
  const ancla = op.ancla ?? null;
  if (ancla !== null) {
    objeto("opciones.ancla", ancla);
    if (!Number.isSafeInteger(ancla.seq) || ancla.seq < 1) throw new ErrorFormato("opciones.ancla.seq", "es un entero >= 1");
    huella("opciones.ancla.huella", ancla.huella, false);
  }
  const ahora = op.ahora ?? Date.now();
  if (!Number.isFinite(ahora)) throw new ErrorFormato("opciones.ahora", "son milisegundos desde 1970");

  let revisados = 0;
  let previo = null;
  let nifCadena = nifEsperado;
  let huellaAncla = null;
  let ultimaHuella = null;
  const vigentes = new Map();
  const fallo = (seq, motivo, detalle) => ({ ok: false, revisados, seq, motivo, detalle, ultimaHuella });
  const formato = (seq, e) => {
    if (e instanceof ErrorFormato) return fallo(seq, "formato", e.message);
    throw e;
  };

  for await (const r of registros) {
    revisados++;
    const esperado = previo === null ? 1 : previo.seq + 1;
    const seq = r !== null && typeof r === "object" ? r.seq : undefined;
    if (seq !== esperado) {
      return fallo(Number.isSafeInteger(seq) ? seq : null, "secuencia",
        `se esperaba el registro ${esperado} y llega ${describir(seq)}`);
    }

    let anterior;
    try {
      anterior = huellaAnteriorDe(r);
    } catch (e) {
      return formato(seq, e);
    }
    if (previo === null) {
      if (anterior !== "") return fallo(seq, "encadenamiento", "el primer registro no puede llevar RegistroAnterior");
    } else {
      if (anterior !== previo.huella) return fallo(seq, "encadenamiento", `el registro ${seq} no apunta al ${previo.seq}`);
      const ra = r.Encadenamiento.RegistroAnterior;
      if (ra.IDEmisorFactura !== previo.nif || ra.NumSerieFactura !== previo.num
          || ra.FechaExpedicionFactura !== previo.fecha) {
        return fallo(seq, "encadenamiento", `RegistroAnterior del ${seq} no identifica la factura del registro ${previo.seq}`);
      }
    }

    let f;
    try {
      f = factura(r);
    } catch (e) {
      return formato(seq, e);
    }
    if (nifCadena === null) nifCadena = f.nif;
    if (f.nif !== nifCadena) {
      return fallo(seq, "emisor", `el registro ${seq} lleva el NIF ${describir(f.nif)} y la cadena es de ${nifCadena}`);
    }

    let calculada, t;
    try {
      calculada = await huellaRegistro(r);
      huella("Huella", r.Huella, false);
      if (r.TipoHuella !== "01") throw new ErrorFormato("TipoHuella", `${describir(r.TipoHuella)} no vale; es "01" (SHA-256)`);
      t = instante("FechaHoraHusoGenRegistro", r.FechaHoraHusoGenRegistro);
    } catch (e) {
      return formato(seq, e);
    }
    if (calculada !== r.Huella) {
      return fallo(seq, "huella", `la huella del registro ${seq} no es la que sale de sus datos`);
    }
    if (previo !== null && t < previo.t) {
      return fallo(seq, "fecha_hora_retrocede", `el registro ${seq} (${r.FechaHoraHusoGenRegistro}) es anterior al ${previo.seq}`);
    }
    if (t > ahora + 60000) {
      return fallo(seq, "fecha_hora_futura", `el registro ${seq} (${r.FechaHoraHusoGenRegistro}) va más de un minuto por delante`);
    }

    const clave = `${f.num}\u0000${f.fecha}`;
    const ultimo = vigentes.get(clave);
    const subsanacion = r.TipoRegistro === "alta" && r.Subsanacion === "S";
    if (r.TipoRegistro === "alta" && !subsanacion && ultimo === "alta") {
      return fallo(seq, "regla_apertura", `registro ${seq}: la factura ${f.num} de ${f.fecha} ya tenía un alta vigente`);
    }
    if ((r.TipoRegistro === "anulacion" || subsanacion) && ultimo !== "alta") {
      return fallo(seq, "regla_apertura", `registro ${seq}: la factura ${f.num} de ${f.fecha} no tenía un alta vigente`);
    }
    vigentes.set(clave, r.TipoRegistro);

    if (ancla !== null && seq === ancla.seq) huellaAncla = r.Huella;
    previo = { seq, huella: r.Huella, t, nif: f.nif, num: f.num, fecha: f.fecha };
    ultimaHuella = r.Huella;
  }

  if (ancla !== null) {
    if (previo === null || previo.seq < ancla.seq) {
      return fallo(ancla.seq, "ancla", `no existe el registro ${ancla.seq} del ancla: la cadena termina en el ${previo === null ? 0 : previo.seq}`);
    }
    if (huellaAncla !== ancla.huella) {
      return fallo(ancla.seq, "ancla", `la huella del registro ${ancla.seq} no es la anclada`);
    }
  }
  return { ok: true, revisados, seq: null, motivo: null, detalle: null, ultimaHuella };
}
