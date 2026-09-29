// Lo que recibe cada prueba: bases recién instaladas, consultas, comprobaciones con su causa y limpieza.
//
// Una comprobación que no se cumple lanza Fallo con un texto que dice QUÉ se esperaba y QUÉ salió: la prueba
// termina en ROJO con esa causa. Nada se da por bueno en silencio.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Conexion, ErrorPg, ident, lit } from "./pg.mjs";

export class Fallo extends Error {
  constructor(causa) {
    super(causa);
    this.name = "Fallo";
  }
}

export class Contexto {
  constructor({ cluster, prueba, sqlPath, jsPath, raiz }) {
    this.cluster = cluster;
    this.prueba = prueba;
    this.sqlPath = sqlPath;
    this.jsPath = jsPath;
    this.raiz = raiz;
    this.comprobaciones = 0;
    this.noMirados = [];
    this._bases = [];
    this._roles = [];
    this._conexiones = [];
    this._cache = new Map();
    this._n = 0;
    this.tmp = fs.mkdtempSync(path.join(cluster.tmp, `${prueba.slice(0, 2)}-`));
  }

  // ── Comprobaciones ──────────────────────────────────────────────────────────────────────────────────
  ok(condicion, texto) {
    if (!condicion) throw new Fallo(texto);
    this.comprobaciones++;
  }

  igual(obtenido, esperado, texto) {
    if (obtenido !== esperado) {
      throw new Fallo(`${texto}: se esperaba ${JSON.stringify(esperado)} y salió ${JSON.stringify(obtenido)}`);
    }
    this.comprobaciones++;
  }

  /** Lo que esta prueba no puede mirar aquí. grave = la prueba no puede darse por verde sin ello. */
  noMirado(texto, { grave = false } = {}) {
    this.noMirados.push({ texto, grave });
  }

  /** Ejecuta sql y exige que falle con ese SQLSTATE (y, si se pide, esa restricción o ese texto en el mensaje). */
  async falla(base, sql, codigo, texto, { usuario, restriccion, contiene } = {}) {
    let error = null;
    try {
      await this.q(base, sql, { usuario });
    } catch (e) {
      error = e;
    }
    if (error === null) throw new Fallo(`${texto}: NO FALLÓ (se esperaba ${codigo})`);
    if (!(error instanceof ErrorPg)) throw error;
    if (error.codigo !== codigo) {
      throw new Fallo(`${texto}: falló con ${error.codigo} (${error.mensaje}) y se esperaba ${codigo}`);
    }
    if (restriccion && error.restriccion !== restriccion) {
      throw new Fallo(`${texto}: falló con ${codigo} pero por ${error.restriccion ?? "(sin restricción)"} y no por ${restriccion}`);
    }
    if (contiene && !String(error.mensaje).includes(contiene)) {
      throw new Fallo(`${texto}: falló con ${codigo} pero el mensaje no nombra «${contiene}»: ${error.mensaje}`);
    }
    this.comprobaciones++;
    return error;
  }

  /** Espera, sondeando, a que fn() dé algo verdadero. Nunca se usa para dar tiempo: solo para ver un estado. */
  async esperar(fn, texto, { tope = 15000 } = {}) {
    const fin = Date.now() + tope;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > fin) throw new Fallo(`${texto} (esperado ${tope / 1000} s)`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  // ── Bases, roles y conexiones ───────────────────────────────────────────────────────────────────────
  nombreBase() {
    return `vfp_${this.cluster.azar}_${this.prueba.slice(0, 2)}_${++this._n}`;
  }

  async baseVacia({ propietario = null, codificacion = null } = {}) {
    const nombre = this.nombreBase();
    let sql = `create database ${ident(nombre)} template template0`;
    if (codificacion) sql += ` encoding ${lit(codificacion)} lc_collate 'C' lc_ctype 'C'`;
    if (propietario) sql += ` owner ${ident(propietario)}`;
    await this.cluster.admin(sql);
    this._bases.push(nombre);
    return nombre;
  }

  /** Una base nueva con la librería recién instalada (con el SQL de esta pasada, saboteado o no). */
  async base({ usuario = null } = {}) {
    const nombre = await this.baseVacia({ propietario: usuario });
    await this.instalar(nombre, { usuario });
    return nombre;
  }

  async instalar(base, { usuario = null, sql = this.sqlPath } = {}) {
    const c = await this.cluster.conectar(base, usuario ?? this.cluster.superusuario);
    try {
      await c.consulta(fs.readFileSync(sql, "utf8"));
    } finally {
      await c.cerrar();
    }
  }

  async conexion(base, usuario = null) {
    const c = await this.cluster.conectar(base, usuario ?? this.cluster.superusuario);
    this._conexiones.push(c);
    return c;
  }

  async _cacheada(base, usuario) {
    const clave = `${base}\u0000${usuario ?? ""}`;
    if (!this._cache.has(clave)) this._cache.set(clave, await this.conexion(base, usuario));
    return this._cache.get(clave);
  }

  /** Filas del último resultado, como listas de texto (o null). */
  async q(base, sql, { usuario = null } = {}) {
    return (await this._cacheada(base, usuario)).filas(sql);
  }

  async objetos(base, sql, { usuario = null } = {}) {
    return (await this._cacheada(base, usuario)).objetos(sql);
  }

  async uno(base, sql, opciones) {
    const filas = await this.q(base, sql, opciones);
    return filas.length ? filas[0][0] : undefined;
  }

  async rol(nombre, { login = true } = {}) {
    const real = `vfp_${this.cluster.azar}_${nombre}`;
    await this.cluster.admin(`create role ${ident(real)} ${login ? "login" : "nologin"}`);
    this._roles.push(real);
    return real;
  }

  /** Un rol con un nombre fijo (anon, authenticated…). Si ya existía, no lo crea ni lo borra. */
  async rolFijo(nombre) {
    const existe = await this.cluster.admin(`select 1 from pg_roles where rolname = ${lit(nombre)}`);
    if (!existe.length) {
      await this.cluster.admin(`create role ${ident(nombre)} nologin`);
      this._roles.push(nombre);
    }
    return nombre;
  }

  // ── JS y procesos ───────────────────────────────────────────────────────────────────────────────────
  async js() {
    return import(pathToFileURL(this.jsPath).href);
  }

  bin(nombre) {
    return this.cluster.bin(nombre);
  }

  /** Lanza un proceso con el entorno del clúster (sin PG* heredadas). Nunca lanza: devuelve el código y la salida. */
  ejecutar(orden, args, { env = {}, tope = 120000, cwd = this.raiz } = {}) {
    return new Promise((resolve) => {
      let salida = "";
      let error = "";
      let hijo;
      try {
        hijo = spawn(orden, args, { cwd, env: { ...this.cluster.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) {
        resolve({ codigo: null, salida, error: e.message });
        return;
      }
      const reloj = setTimeout(() => hijo.kill("SIGKILL"), tope);
      hijo.stdout.on("data", (d) => { salida += d; });
      hijo.stderr.on("data", (d) => { error += d; });
      hijo.on("error", (e) => {
        clearTimeout(reloj);
        resolve({ codigo: null, salida, error: error + e.message });
      });
      hijo.on("close", (codigo) => {
        clearTimeout(reloj);
        resolve({ codigo, salida, error });
      });
    });
  }

  // ── Limpieza ────────────────────────────────────────────────────────────────────────────────────────
  async limpiar() {
    for (const c of this._conexiones) await c.cerrar().catch(() => {});
    for (const b of this._bases) await this.cluster.admin(`drop database if exists ${ident(b)} with (force)`);
    for (const r of this._roles.reverse()) await this.cluster.admin(`drop role if exists ${ident(r)}`);
    fs.rmSync(this.tmp, { recursive: true, force: true });
  }
}

export { Conexion, ErrorPg, ident, lit };
