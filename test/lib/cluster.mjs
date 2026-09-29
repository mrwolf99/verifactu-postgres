// El Postgres de las pruebas. Dos modos, y ninguno puede tocar una base que ya exista:
//
//  · local (por defecto): un clúster DESECHABLE. initdb en un directorio de fs.mkdtemp, arranque solo con socket
//    Unix (listen_addresses = '') en ese mismo directorio, puerto libre aleatorio, y parada y borrado al terminar,
//    también ante SIGINT/SIGTERM. Las variables PG* heredadas se quitan del entorno de todos los procesos hijos.
//  · servicio (CI): exige VF_PRUEBAS_SERVICIO=1, CI=true, PGHOST en {localhost, 127.0.0.1} y un superusuario.
//    Crea bases vfp_<azar>_<prueba>_<n> y las borra al terminar; no toca ninguna otra.

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Conexion, ident } from "./pg.mjs";

function entornoSinPG() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^PG/.test(k)) env[k] = v;
  return env;
}

function puertoLibre() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function correr(bin, args, env) {
  const r = spawnSync(bin, args, { env, encoding: "utf8" });
  if (r.error) throw new Error(`${path.basename(bin)}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${path.basename(bin)} salió con ${r.status}:\n${r.stderr || r.stdout}`);
  return r.stdout;
}

export async function abrirCluster() {
  const pgBin = process.env.PG_BIN;
  const servicio = process.env.VF_PRUEBAS_SERVICIO === "1";
  // En local hacen falta también initdb y pg_ctl; contra el servicio de la CI basta el cliente.
  const requeridos = servicio ? ["psql", "pg_dump", "pg_restore"] : ["initdb", "pg_ctl", "psql", "pg_dump", "pg_restore"];
  const faltan = requeridos.filter((b) => !pgBin || !fs.existsSync(path.join(pgBin, b)));
  if (faltan.length) {
    throw new Error(`PG_BIN tiene que apuntar a la carpeta bin de PostgreSQL; ahí no están: ${faltan.join(", ")}. `
      + "Por ejemplo: PG_BIN=\"$(pg_config --bindir)\" node test/run.mjs");
  }
  const azar = crypto.randomBytes(3).toString("hex");
  const bin = (nombre) => path.join(pgBin, nombre);
  return servicio ? abrirServicio({ bin, azar }) : abrirLocal({ bin, azar });
}

async function abrirLocal({ bin, azar }) {
  const envBase = entornoSinPG();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vfp-"));
  const datos = path.join(tmp, "datos");
  const puerto = await puertoLibre();
  const socket = path.join(tmp, `.s.PGSQL.${puerto}`);
  let parado = false;

  const pararSync = () => {
    if (parado) return;
    parado = true;
    if (fs.existsSync(path.join(datos, "postmaster.pid"))) {
      spawnSync(bin("pg_ctl"), ["-D", datos, "-m", "fast", "-w", "stop"], { env: envBase, stdio: "ignore" });
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  const alSenal = (senal) => {
    pararSync();
    process.exit(senal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", alSenal);
  process.once("SIGTERM", alSenal);
  process.once("exit", pararSync);

  try {
    if (Buffer.byteLength(socket) > 100) {
      throw new Error(`la ruta del socket (${Buffer.byteLength(socket)} bytes) pasa del límite del sistema; usa un TMPDIR más corto`);
    }
    correr(bin("initdb"), ["-D", datos, "-U", "postgres", "--auth=trust", "--encoding=UTF8", "--locale=C.UTF-8",
      "--no-instructions"], envBase);
    const opciones = `-h '' -k '${tmp}' -p ${puerto} -F -c max_connections=60`;
    correr(bin("pg_ctl"), ["-D", datos, "-l", path.join(tmp, "postgres.log"), "-w", "-t", "60", "-o", opciones, "start"], envBase);
  } catch (e) {
    pararSync();
    throw e;
  }

  const env = { ...envBase, PGHOST: tmp, PGPORT: String(puerto), PGUSER: "postgres" };
  const conectar = (base, usuario = "postgres") => Conexion.abrir({ socket, usuario, base });
  const admin = await conectar("postgres");
  const [[version]] = await admin.filas("show server_version");
  return {
    modo: "local",
    descripcion: `clúster desechable, solo socket Unix, puerto ${puerto}`,
    azar, bin, env, tmp, version,
    superusuario: "postgres",
    conectar,
    admin: (sql) => admin.filas(sql),
    async cerrar() {
      await admin.cerrar();
      pararSync();
      process.removeListener("exit", pararSync);
      return !fs.existsSync(tmp);
    },
  };
}

async function abrirServicio({ bin, azar }) {
  // Segundo cerrojo: en un ordenador de verdad puede haber un PostgreSQL con bases de verdad en localhost:5432.
  if (process.env.CI !== "true") {
    throw new Error("modo servicio: solo dentro de la CI (CI=true). En local, sin VF_PRUEBAS_SERVICIO: se usa un clúster desechable");
  }
  const host = process.env.PGHOST;
  if (!["localhost", "127.0.0.1"].includes(host)) {
    throw new Error("modo servicio: PGHOST tiene que ser localhost o 127.0.0.1 (el contenedor desechable de la CI)");
  }
  const puerto = Number(process.env.PGPORT || 5432);
  const usuario = process.env.PGUSER || "postgres";
  const env = { ...entornoSinPG(), PGHOST: host, PGPORT: String(puerto), PGUSER: usuario };
  if (process.env.PGPASSWORD) env.PGPASSWORD = process.env.PGPASSWORD;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vfp-"));
  const conectar = (base, u = usuario) => Conexion.abrir({ host, puerto, usuario: u, base });
  const admin = await conectar("postgres");
  const [[superusuario]] = await admin.filas("select rolsuper from pg_roles where rolname = current_user");
  if (superusuario !== "t") {
    await admin.cerrar();
    throw new Error(`modo servicio: ${usuario} no es superusuario`);
  }
  const [[version]] = await admin.filas("show server_version");
  const sobrantes = await admin.filas(`select datname from pg_database where datname like ${"'vfp\\_" + azar + "\\_%'"}`);
  if (sobrantes.length) throw new Error("modo servicio: ya hay bases con este prefijo; no se toca nada");
  return {
    modo: "servicio",
    descripcion: `servicio en ${host}:${puerto}`,
    azar, bin, env, tmp, version,
    superusuario: usuario,
    conectar,
    admin: (sql) => admin.filas(sql),
    async cerrar() {
      const restos = await admin.filas(`select datname from pg_database where datname like ${"'vfp\\_" + azar + "\\_%'"}`);
      for (const [d] of restos) await admin.filas(`drop database ${ident(d)} with (force)`);
      await admin.cerrar();
      fs.rmSync(tmp, { recursive: true, force: true });
      return !fs.existsSync(tmp);
    },
  };
}
