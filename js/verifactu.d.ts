// verifactu-postgres 0.1.0 · tipos del helper JS (js/verifactu.mjs).

export declare const VERSION: string;

/** Lista L2 de la Orden HAC/1177/2024. */
export type TipoFactura = "F1" | "F2" | "F3" | "R1" | "R2" | "R3" | "R4" | "R5";

/** Campos de la huella de un alta, con el texto EXACTO que entra en la cadena (sin recortar ni normalizar). */
export interface CamposAlta {
  IDEmisorFactura: string;
  /** De 1 a 60 caracteres del ASCII imprimible (32–126), sin & = < > " ' ni espacios en los extremos. */
  NumSerieFactura: string;
  /** dd-mm-aaaa */
  FechaExpedicionFactura: string;
  TipoFactura: TipoFactura;
  /** Dos decimales y punto, sin «+»: "12.35", "-5.00", "0.00". */
  CuotaTotal: string;
  ImporteTotal: string;
  /** "" en el primer registro; si no, la huella del registro anterior. */
  HuellaAnterior: string;
  /** AAAA-MM-DDThh:mm:ss±hh:mm, sin «Z» ni fracciones. */
  FechaHoraHusoGenRegistro: string;
}

/** Campos de la huella de una anulación (en la cadena se escriben como ...Anulada). */
export interface CamposAnulacion {
  IDEmisorFactura: string;
  NumSerieFactura: string;
  FechaExpedicionFactura: string;
  HuellaAnterior: string;
  FechaHoraHusoGenRegistro: string;
}

export interface RegistroAnterior {
  IDEmisorFactura: string;
  NumSerieFactura: string;
  FechaExpedicionFactura: string;
  Huella: string;
}

export type Encadenamiento = { PrimerRegistro: "S" } | { RegistroAnterior: RegistroAnterior };

/** Una línea de verifactu.exportar_cadena() para un alta. */
export interface RegistroAltaExportado {
  seq: number;
  TipoRegistro: "alta";
  IDEmisorFactura: string;
  NumSerieFactura: string;
  FechaExpedicionFactura: string;
  TipoFactura: TipoFactura;
  CuotaTotal: string;
  ImporteTotal: string;
  Subsanacion: "S" | "N";
  Encadenamiento: Encadenamiento;
  FechaHoraHusoGenRegistro: string;
  TipoHuella: "01";
  Huella: string;
}

/** Una línea de verifactu.exportar_cadena() para una anulación. */
export interface RegistroAnulacionExportado {
  seq: number;
  TipoRegistro: "anulacion";
  IDEmisorFacturaAnulada: string;
  NumSerieFacturaAnulada: string;
  FechaExpedicionFacturaAnulada: string;
  Encadenamiento: Encadenamiento;
  FechaHoraHusoGenRegistro: string;
  TipoHuella: "01";
  Huella: string;
}

export type RegistroExportado = RegistroAltaExportado | RegistroAnulacionExportado;

export type Motivo =
  | "secuencia"
  | "encadenamiento"
  | "emisor"
  | "formato"
  | "huella"
  | "fecha_hora_retrocede"
  | "fecha_hora_futura"
  | "regla_apertura"
  | "ancla";

export interface ResultadoVerificacion {
  ok: boolean;
  /** Registros leídos hasta la rotura (incluido el roto) o, si está bien, todos. */
  revisados: number;
  /** El primer seq que falla, o null. */
  seq: number | null;
  motivo: Motivo | null;
  detalle: string | null;
  /** La huella del último registro que pasó todas las comprobaciones, o null si ninguno. */
  ultimaHuella: string | null;
}

export interface OpcionesVerificacion {
  /** NIF que tiene que llevar toda la cadena. Si no se da, manda el del primer registro. */
  nif?: string;
  /** Un seq y su huella anotados FUERA de la base: detecta la vuelta a una copia vieja. */
  ancla?: { seq: number; huella: string };
  /** «Ahora», en milisegundos desde 1970, para detectar horas futuras. Por defecto, Date.now(). */
  ahora?: number;
}

export declare class ErrorFormato extends Error {
  readonly name: "ErrorFormato";
  /** El campo que no tiene la forma esperada. */
  readonly campo: string;
  constructor(campo: string, mensaje: string);
}

export declare function cadenaAlta(c: CamposAlta): string;
export declare function cadenaAnulacion(c: CamposAnulacion): string;
/** SHA-256 de los bytes UTF-8, en hexadecimal y mayúsculas. WebCrypto (en un navegador, solo en contexto seguro); en Node 18, node:crypto. */
export declare function sha256Hex(texto: string): Promise<string>;
export declare function huellaRegistro(r: RegistroExportado): Promise<string>;
export declare function verificarCadena(
  registros: Iterable<RegistroExportado> | AsyncIterable<RegistroExportado>,
  opciones?: OpcionesVerificacion,
): Promise<ResultadoVerificacion>;
