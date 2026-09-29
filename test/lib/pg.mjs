// Cliente mínimo del protocolo de PostgreSQL (v3, consulta simple, formato texto), sin dependencias.
//
// Es solo para las pruebas: habla con el clúster desechable por socket Unix (o con el servicio de la CI por TCP
// en localhost) y SOLO acepta autenticación «trust». Devuelve el SQLSTATE exacto de cada error y permite tener
// varias sesiones abiertas a la vez, que es lo que piden las pruebas de concurrencia.

import net from "node:net";

export class ErrorPg extends Error {
  constructor(campos) {
    super(`${campos.C ?? "?????"}: ${campos.M ?? "error sin mensaje"}`);
    this.name = "ErrorPg";
    this.codigo = campos.C ?? null;
    this.mensaje = campos.M ?? null;
    this.detalle = campos.D ?? null;
    this.pista = campos.H ?? null;
    this.restriccion = campos.n ?? null;
  }
}

function cstr(s) {
  return Buffer.concat([Buffer.from(s, "utf8"), Buffer.from([0])]);
}

function empaquetar(tipo, cuerpo) {
  const cabecera = Buffer.alloc(5);
  cabecera.write(tipo, 0, "latin1");
  cabecera.writeInt32BE(4 + cuerpo.length, 1);
  return Buffer.concat([cabecera, cuerpo]);
}

function leerCampos(b) {
  const campos = {};
  let i = 0;
  while (i < b.length && b[i] !== 0) {
    const clave = String.fromCharCode(b[i]);
    const fin = b.indexOf(0, i + 1);
    campos[clave] = b.toString("utf8", i + 1, fin);
    i = fin + 1;
  }
  return campos;
}

export class Conexion {
  static abrir({ socket = null, host = null, puerto = 5432, usuario, base, aplicacion = "verifactu-pruebas" }) {
    return new Promise((resolve, reject) => {
      const c = new Conexion();
      c.usuario = usuario;
      c.base = base;
      c.pid = null;
      c.estado = null;
      c.avisos = [];
      c._buf = Buffer.alloc(0);
      c._cola = Promise.resolve();
      c._pendiente = { arranque: true, resolve: () => resolve(c), reject, error: null };
      c._cerrada = false;
      const sock = socket ? net.createConnection({ path: socket }) : net.createConnection({ host, port: puerto });
      c._sock = sock;
      sock.on("connect", () => {
        const params = Buffer.concat([
          cstr("user"), cstr(usuario), cstr("database"), cstr(base),
          cstr("client_encoding"), cstr("UTF8"), cstr("application_name"), cstr(aplicacion), Buffer.from([0]),
        ]);
        const cuerpo = Buffer.alloc(8 + params.length);
        cuerpo.writeInt32BE(8 + params.length, 0);
        cuerpo.writeInt32BE(196608, 4); // protocolo 3.0
        params.copy(cuerpo, 8);
        sock.write(cuerpo);
      });
      sock.on("data", (d) => {
        c._buf = Buffer.concat([c._buf, d]);
        c._leerMensajes();
      });
      sock.on("error", (e) => c._fallar(e));
      sock.on("close", () => {
        c._cerrada = true;
        c._fallar(new Error("la conexión con el servidor se cerró"));
      });
    });
  }

  _fallar(e) {
    const p = this._pendiente;
    if (p) {
      this._pendiente = null;
      p.reject(p.error ?? e);
    }
  }

  _leerMensajes() {
    while (this._buf.length >= 5) {
      const largo = this._buf.readInt32BE(1);
      if (this._buf.length < 1 + largo) return;
      const tipo = String.fromCharCode(this._buf[0]);
      const cuerpo = this._buf.subarray(5, 1 + largo);
      this._buf = this._buf.subarray(1 + largo);
      this._mensaje(tipo, cuerpo);
    }
  }

  _mensaje(tipo, b) {
    const p = this._pendiente;
    switch (tipo) {
      case "R": {
        const codigo = b.readInt32BE(0);
        if (codigo !== 0) {
          this._fallar(new Error(`el servidor pide autenticación (tipo ${codigo}); las pruebas solo usan trust`));
          this._sock.destroy();
        }
        break;
      }
      case "K":
        this.pid = b.readInt32BE(0);
        break;
      case "S":
      case "A":
        break;
      case "N":
        this.avisos.push(leerCampos(b));
        break;
      case "E": {
        const e = new ErrorPg(leerCampos(b));
        if (p && p.arranque) {
          this._pendiente = null;
          p.reject(e);
          this._sock.destroy();
        } else if (p) {
          p.error ??= e;
        }
        break;
      }
      case "T": {
        const n = b.readInt16BE(0);
        const columnas = [];
        let i = 2;
        for (let k = 0; k < n; k++) {
          const fin = b.indexOf(0, i);
          columnas.push(b.toString("utf8", i, fin));
          i = fin + 1 + 18;
        }
        if (p) p.actual = { columnas, filas: [] };
        break;
      }
      case "D": {
        const n = b.readInt16BE(0);
        const fila = [];
        let i = 2;
        for (let k = 0; k < n; k++) {
          const largo = b.readInt32BE(i);
          i += 4;
          if (largo < 0) fila.push(null);
          else {
            fila.push(b.toString("utf8", i, i + largo));
            i += largo;
          }
        }
        if (p && p.actual) p.actual.filas.push(fila);
        break;
      }
      case "C": {
        const comando = b.toString("utf8", 0, b.indexOf(0));
        if (p) {
          p.resultados.push({ comando, columnas: p.actual?.columnas ?? [], filas: p.actual?.filas ?? [] });
          p.actual = null;
        }
        break;
      }
      case "I":
        if (p) p.resultados.push({ comando: "", columnas: [], filas: [] });
        break;
      case "G": // COPY FROM STDIN: estas pruebas no lo usan
        this._sock.write(empaquetar("f", cstr("las pruebas no envían COPY")));
        break;
      case "H":
      case "d":
      case "c":
        if (p) p.error ??= new Error("COPY TO STDOUT no está soportado en este cliente de pruebas");
        break;
      case "Z":
        this.estado = String.fromCharCode(b[0]);
        this._pendiente = null;
        if (p) {
          if (p.arranque) p.resolve();
          else if (p.error) p.reject(p.error);
          else p.resolve(p.resultados);
        }
        break;
      default:
        break;
    }
  }

  /** Ejecuta una o varias sentencias (protocolo simple). Devuelve [{comando, columnas, filas}], una por sentencia. */
  consulta(sql) {
    const siguiente = this._cola.then(() => new Promise((resolve, reject) => {
      if (this._cerrada) {
        reject(new Error("la conexión está cerrada"));
        return;
      }
      this._pendiente = { arranque: false, resolve, reject, error: null, resultados: [], actual: null };
      this._sock.write(empaquetar("Q", cstr(sql)));
    }));
    this._cola = siguiente.catch(() => {});
    return siguiente;
  }

  /** Filas (como listas de texto o null) del último resultado. */
  async filas(sql) {
    const r = await this.consulta(sql);
    return r.length ? r[r.length - 1].filas : [];
  }

  /** Filas del último resultado como objetos {columna: valor}. */
  async objetos(sql) {
    const r = await this.consulta(sql);
    if (!r.length) return [];
    const { columnas, filas } = r[r.length - 1];
    return filas.map((f) => Object.fromEntries(columnas.map((c, i) => [c, f[i]])));
  }

  cerrar() {
    return new Promise((resolve) => {
      if (this._cerrada) {
        resolve();
        return;
      }
      this._sock.once("close", () => resolve());
      try {
        this._sock.end(empaquetar("X", Buffer.alloc(0)));
      } catch {
        this._sock.destroy();
      }
      setTimeout(() => this._sock.destroy(), 2000).unref();
    });
  }
}

/** Identificador SQL entre comillas dobles. */
export function ident(s) {
  return `"${String(s).replaceAll('"', '""')}"`;
}

/** Literal SQL entre comillas simples (standard_conforming_strings = on, que es lo de serie). */
export function lit(s) {
  if (s === null || s === undefined) return "null";
  return `'${String(s).replaceAll("'", "''")}'`;
}
