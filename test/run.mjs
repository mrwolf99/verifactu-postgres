#!/usr/bin/env node
// EL comando de pruebas de verifactu-postgres. Sin dependencias.
//
//   PG_BIN=/ruta/a/postgres/bin node test/run.mjs               pasada normal
//   PG_BIN=/ruta/a/postgres/bin node test/run.mjs 05 11         solo esas pruebas
//   PG_BIN=/ruta/a/postgres/bin node test/run.mjs --sabotajes   cada sabotaje tiene que poner en rojo SU prueba
//
// Por defecto crea un clúster DESECHABLE (ver test/lib/cluster.mjs) y lo borra al terminar. Cada prueba recibe
// bases recién instaladas. Código de salida: 0 todo en verde · 1 algún rojo · 3 algo sin mirar · 2 sin Postgres.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { abrirCluster } from "./lib/cluster.mjs";
import { Contexto, Fallo } from "./lib/contexto.mjs";
import { lineaPrueba, porcentaje, resumenPasada, segundos } from "./lib/informe.mjs";
import { SABOTAJES, aplicarSabotaje } from "./sabotajes.mjs";

const RAIZ = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const TOPE_PRUEBA_MS = 180000;

function listarPruebas(filtro) {
  const dir = path.join(RAIZ, "test", "pruebas");
  let archivos = fs.readdirSync(dir).filter((f) => /^[0-9]{2}-.+\.mjs$/.test(f)).sort();
  if (filtro.length) archivos = archivos.filter((f) => filtro.some((x) => f.startsWith(x)));
  return archivos.map((f) => ({ nombre: f.replace(/\.mjs$/, ""), archivo: path.join(dir, f) }));
}

function conTope(promesa, ms, texto) {
  let reloj;
  const tope = new Promise((_, reject) => { reloj = setTimeout(() => reject(new Fallo(texto)), ms); });
  return Promise.race([promesa, tope]).finally(() => clearTimeout(reloj));
}

function relativo(texto) {
  return String(texto).split(RAIZ + path.sep).join("");
}

async function correrPrueba(cluster, prueba, fuentes) {
  const inicio = Date.now();
  const t = new Contexto({ cluster, prueba: prueba.nombre, ...fuentes, raiz: RAIZ });
  let estado = "VERDE";
  let causa = null;
  try {
    const mod = await import(pathToFileURL(prueba.archivo).href);
    await conTope(Promise.resolve().then(() => mod.default(t)), TOPE_PRUEBA_MS,
      `tiempo agotado: más de ${TOPE_PRUEBA_MS / 1000} s`);
    if (t.comprobaciones === 0) {
      estado = "ROJO";
      causa = "no comprobó nada";
    } else if (t.noMirados.some((n) => n.grave)) {
      estado = "NO MIRADO";
    }
  } catch (e) {
    estado = "ROJO";
    causa = (e instanceof Fallo ? e.message : `REVENTÓ: ${relativo(e && e.stack ? e.stack : e)}`).trimEnd();
  }
  try {
    await t.limpiar();
  } catch (e) {
    if (estado !== "ROJO") {
      estado = "ROJO";
      causa = `la limpieza falló: ${e.message}`;
    }
  }
  return { nombre: prueba.nombre, estado, causa, comprobaciones: t.comprobaciones, noMirados: t.noMirados, ms: Date.now() - inicio };
}

async function pasada(cluster, pruebas, fuentes, alTerminar) {
  const resultados = [];
  for (const p of pruebas) {
    const r = await correrPrueba(cluster, p, fuentes);
    resultados.push(r);
    if (alTerminar) alTerminar(r);
  }
  return resultados;
}

async function pasadaNormal(cluster, pruebas) {
  const fuentes = { sqlPath: path.join(RAIZ, "sql", "verifactu.sql"), jsPath: path.join(RAIZ, "js", "verifactu.mjs") };
  console.log("SQL: sql/verifactu.sql · JS: js/verifactu.mjs\n");
  const inicio = Date.now();
  const resultados = await pasada(cluster, pruebas, fuentes, (r) => console.log(lineaPrueba(r)));
  console.log("─".repeat(96));
  console.log(resumenPasada(resultados, Date.now() - inicio));
  if (resultados.some((r) => r.estado === "ROJO")) return 1;
  if (resultados.some((r) => r.estado !== "VERDE")) return 3;
  return 0;
}

function sha(texto) {
  return crypto.createHash("sha256").update(texto).digest("hex").slice(0, 12);
}

async function pasadaSabotajes(cluster, pruebas) {
  console.log(`${SABOTAJES.length} sabotajes · cada uno se aplica en una COPIA y corre la batería entera (${pruebas.length} pruebas)\n`);
  const inicio = Date.now();
  let cazados = 0;
  for (const s of SABOTAJES) {
    console.log(`${s.id} · ${s.fichero}: ${s.que}`);
    const destino = fs.mkdtempSync(path.join(cluster.tmp, "sab-"));
    const fuentes = { sqlPath: path.join(destino, "verifactu.sql"), jsPath: path.join(destino, "verifactu.mjs") };
    fs.copyFileSync(path.join(RAIZ, "sql", "verifactu.sql"), fuentes.sqlPath);
    fs.copyFileSync(path.join(RAIZ, "js", "verifactu.mjs"), fuentes.jsPath);
    const ap = aplicarSabotaje(s, { raiz: RAIZ, destino });
    if (!ap.aplicado) {
      console.log(`  SABOTAJE NO APLICADO: ${ap.motivo}\n  → NO DEMUESTRA NADA\n`);
      fs.rmSync(destino, { recursive: true, force: true });
      continue;
    }
    console.log(`  ancla: ${ap.coincidencias} coincidencia · texto cambiado: sí (${ap.bytes[0]} → ${ap.bytes[1]} bytes; `
      + `sha256 ${sha(ap.antes)}… → ${sha(ap.despues)}…) · ancla ausente en la copia: ${ap.anclaAusente ? "sí" : "NO"}`);
    const resultados = await pasada(cluster, pruebas, fuentes);
    const suya = resultados.find((r) => r.nombre.startsWith(s.prueba));
    const suyaOk = suya && suya.estado === "ROJO" && s.causa.test(suya.causa ?? "");
    const otrosRojos = resultados.filter((r) => r !== suya && r.estado !== "VERDE");
    const esperados = s.tambien ?? [];
    const ajenos = otrosRojos.filter((r) => !esperados.some((e) => r.nombre.startsWith(e)));
    const faltan = esperados.filter((e) => !otrosRojos.some((r) => r.nombre.startsWith(e)));
    console.log(`  su prueba: ${suya ? suya.nombre : s.prueba + " (NO EXISTE)"} · se espera ROJO con ${s.causa}`);
    console.log(`    ${suya ? suya.estado : "?"}${suyaOk ? " (SUYO)" : " (NO ES EL SUYO)"}: ${suya?.causa ?? "sin causa: no cayó"}`);
    for (const r of otrosRojos) {
      const declarado = esperados.some((e) => r.nombre.startsWith(e));
      console.log(`  también ${r.estado} ${r.nombre}${declarado ? " (declarado: cubre el mismo defecto)" : " (NO DECLARADO)"}: ${r.causa}`);
    }
    for (const e of faltan) console.log(`  declarado en rojo y salió en verde: ${e} (la declaración está mal)`);
    const verdes = resultados.filter((r) => r.estado === "VERDE").map((r) => r.nombre.slice(0, 2));
    console.log(`  en verde (${verdes.length}/${resultados.length}): ${verdes.join(" ")}`);
    const cazado = suyaOk && ajenos.length === 0 && faltan.length === 0;
    if (cazado) cazados++;
    console.log(`  → ${cazado ? "CAZADO con su rojo" : "NO CAZADO"}\n`);
    fs.rmSync(destino, { recursive: true, force: true });
  }
  console.log("─".repeat(96));
  console.log(`sabotajes cazados con su rojo: ${cazados}/${SABOTAJES.length} · ${porcentaje(cazados, SABOTAJES.length)}`
    + `   tiempo: ${segundos(Date.now() - inicio)}`);
  return cazados === SABOTAJES.length ? 0 : 1;
}

const args = process.argv.slice(2);
const modoSabotajes = args.includes("--sabotajes");
const filtro = args.filter((a) => !a.startsWith("--"));
const pruebas = listarPruebas(modoSabotajes ? [] : filtro);
const version = JSON.parse(fs.readFileSync(path.join(RAIZ, "package.json"), "utf8")).version;

let cluster;
try {
  cluster = await abrirCluster();
} catch (e) {
  console.error(`NO SE PUDO PREPARAR EL POSTGRES DE PRUEBAS: ${relativo(e.message)}`);
  process.exit(2);
}
let codigo = 1;
try {
  console.log(`verifactu-postgres ${version} · ${modoSabotajes ? "sabotajes" : "pruebas"}`);
  console.log(`PostgreSQL ${cluster.version} (${cluster.descripcion}) · Node ${process.version}`);
  codigo = modoSabotajes ? await pasadaSabotajes(cluster, pruebas) : await pasadaNormal(cluster, pruebas);
} finally {
  const borrado = await cluster.cerrar();
  console.log(cluster.modo === "local"
    ? `clúster desechable parado y borrado: ${borrado ? "sí" : "NO"}`
    : `bases de prueba borradas; temporal borrado: ${borrado ? "sí" : "NO"}`);
  if (!borrado && codigo === 0) codigo = 1;
}
process.exit(codigo);
