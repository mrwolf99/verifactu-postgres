// El helper JS sin Postgres: los tres ejemplos oficiales, el fixture que exporta la base y la detección de
// manipulaciones. Corre igual en Node (>= 18) y en Deno:
//
//   node test/js-solo.mjs [ruta/a/verifactu.mjs] [--sin-webcrypto]
//   deno run --allow-read test/js-solo.mjs [ruta/a/verifactu.mjs]
//
// --sin-webcrypto quita globalThis.crypto antes de cargar el helper, para recorrer el respaldo node:crypto (el
// camino de Node 18) en un Node moderno. Código de salida 0 solo si todo está en verde.

import { readFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = globalThis.Deno ? globalThis.Deno.args : process.argv.slice(2);
const sinWebcrypto = args.includes("--sin-webcrypto");
const rutaJs = args.find((a) => !a.startsWith("--")) ?? fileURLToPath(new URL("../js/verifactu.mjs", import.meta.url));
if (sinWebcrypto) {
  Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true, writable: true });
}
const v = await import(pathToFileURL(rutaJs).href);
const vectores = JSON.parse(readFileSync(new URL("./vectores/aeat-huella-v0.1.2.json", import.meta.url), "utf8"));
const fixture = readFileSync(new URL("./vectores/cadena-ejemplo.ndjson", import.meta.url), "utf8")
  .split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));

const entorno = globalThis.Deno ? `Deno ${globalThis.Deno.version.deno}` : `Node ${process.version}`;
const cripto = globalThis.crypto && globalThis.crypto.subtle ? "WebCrypto" : "node:crypto (respaldo)";
console.log(`js-solo · ${entorno} · ${cripto} · helper ${v.VERSION}`);

let total = 0;
let verdes = 0;
function comprobar(ok, texto) {
  total++;
  if (ok) verdes++;
  else console.log(`ROJO ${texto}`);
}
function primeraDiferencia(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}
function copia(x) {
  return JSON.parse(JSON.stringify(x));
}
async function lanza(fn, campo) {
  try {
    await fn();
    return "no lanzó";
  } catch (e) {
    if (!(e instanceof v.ErrorFormato)) return `lanzó ${e && e.name}: ${e && e.message}`;
    return e.campo === campo ? true : `lanzó ErrorFormato por ${e.campo} y no por ${campo}`;
  }
}

// ── 1. Los tres ejemplos oficiales ────────────────────────────────────────────────────────────────────────
for (const caso of vectores.casos) {
  const e = caso.entrada;
  const cadena = caso.tipo === "alta"
    ? v.cadenaAlta({ ...e, HuellaAnterior: e.Huella })
    : v.cadenaAnulacion({
      IDEmisorFactura: e.IDEmisorFacturaAnulada, NumSerieFactura: e.NumSerieFacturaAnulada,
      FechaExpedicionFactura: e.FechaExpedicionFacturaAnulada, HuellaAnterior: e.Huella,
      FechaHoraHusoGenRegistro: e.FechaHoraHusoGenRegistro,
    });
  const i = primeraDiferencia(cadena, caso.cadena);
  comprobar(cadena === caso.cadena, `${caso.nombre}: la cadena es distinta en la posición ${i}: se esperaba `
    + `«…${caso.cadena.slice(i, i + 30)}» y salió «…${cadena.slice(i, i + 30)}»`);
  const huella = await v.sha256Hex(cadena);
  comprobar(huella === caso.huella, `${caso.nombre}: huella ${huella} en vez de ${caso.huella}`);
}

// ── 2. La huella sabe fallar: variantes de la cadena del caso 1 que NO pueden dar su huella ─────────────────
const c1 = vectores.casos[0];
const variantes = {
  "123.450 en vez de 123.45": c1.cadena.replace("ImporteTotal=123.45", "ImporteTotal=123.450"),
  "sin &Huella=": c1.cadena.replace("&Huella=", ""),
  "fecha 2024-01-01": c1.cadena.replace("FechaExpedicionFactura=01-01-2024", "FechaExpedicionFactura=2024-01-01"),
  "Z en vez de +01:00": c1.cadena.replace("19:20:30+01:00", "18:20:30Z"),
};
for (const [nombre, variante] of Object.entries(variantes)) {
  comprobar(variante !== c1.cadena, `variante «${nombre}»: la sustitución no se aplicó`);
  comprobar((await v.sha256Hex(variante)) !== c1.huella, `variante «${nombre}» da la huella oficial`);
}

// ── 3. Estricto: rechaza lo que no tiene la forma exacta, nombrando el campo ────────────────────────────────
const base = { ...c1.entrada, HuellaAnterior: "" };
const rechazos = [
  ["CuotaTotal 12.3", { CuotaTotal: "12.3" }, "CuotaTotal"],
  ["ImporteTotal +123.45", { ImporteTotal: "+123.45" }, "ImporteTotal"],
  ["ImporteTotal -0.00", { ImporteTotal: "-0.00" }, "ImporteTotal"],
  ["NumSerieFactura con espacio delante", { NumSerieFactura: " 12345678/G33" }, "NumSerieFactura"],
  ["NumSerieFactura con &", { NumSerieFactura: "A&B" }, "NumSerieFactura"],
  ["NumSerieFactura con tabulador", { NumSerieFactura: "A\tB" }, "NumSerieFactura"],
  ["NumSerieFactura con U+0085", { NumSerieFactura: "A\u0085B" }, "NumSerieFactura"],
  ["NumSerieFactura de 61", { NumSerieFactura: "X".repeat(61) }, "NumSerieFactura"],
  ["NumSerieFactura con surrogado suelto", { NumSerieFactura: "A\ud800B" }, "NumSerieFactura"],
  ["hora con Z", { FechaHoraHusoGenRegistro: "2024-01-01T18:20:30Z" }, "FechaHoraHusoGenRegistro"],
  ["hora con fracciones", { FechaHoraHusoGenRegistro: "2024-01-01T19:20:30.5+01:00" }, "FechaHoraHusoGenRegistro"],
  ["TipoFactura f1", { TipoFactura: "f1" }, "TipoFactura"],
  ["TipoFactura F4", { TipoFactura: "F4" }, "TipoFactura"],
  ["fecha 31-02-2024", { FechaExpedicionFactura: "31-02-2024" }, "FechaExpedicionFactura"],
  ["fecha 2024-01-01", { FechaExpedicionFactura: "2024-01-01" }, "FechaExpedicionFactura"],
  ["NIF en minúsculas", { IDEmisorFactura: "89890001k" }, "IDEmisorFactura"],
  ["huella anterior en minúsculas", { HuellaAnterior: c1.huella.toLowerCase() }, "HuellaAnterior"],
];
for (const [nombre, cambio, campo] of rechazos) {
  const r = await lanza(() => v.cadenaAlta({ ...base, ...cambio }), campo);
  comprobar(r === true, `rechazo «${nombre}»: ${r}`);
}
const sesenta = "X".repeat(59) + "\u{1F600}";
comprobar(v.cadenaAlta({ ...base, NumSerieFactura: sesenta }).includes(sesenta),
  "60 puntos de código (61 unidades UTF-16) tienen que valer");

// ── 4. El fixture que exporta la base ──────────────────────────────────────────────────────────────────────
const nFixture = fixture.length;
comprobar(nFixture >= 13, `el fixture tiene ${nFixture} registros`);
for (let k = 0; k < 3; k++) {
  comprobar(fixture[k].Huella === vectores.casos[k].huella, `fixture: el registro ${k + 1} no lleva la huella oficial ${k + 1}`);
}
for (const r of fixture) {
  const h = await v.huellaRegistro(r);
  comprobar(h === r.Huella, `fixture: la huella JS del registro ${r.seq} no es la de la base`);
}
const sano = await v.verificarCadena(fixture);
comprobar(sano.ok && sano.revisados === nFixture && sano.ultimaHuella === fixture[nFixture - 1].Huella,
  `fixture sano: ${JSON.stringify(sano)}`);
async function* asincrono(lista) {
  for (const x of lista) yield x;
}
const sanoAsinc = await v.verificarCadena(asincrono(fixture), { nif: "89890001K" });
comprobar(sanoAsinc.ok, `fixture sano (iterable asíncrono): ${JSON.stringify(sanoAsinc)}`);

// ── 5. Manipulaciones: cada una tiene que dar su motivo en su registro ──────────────────────────────────────
async function espera(nombre, registros, opciones, seq, motivo) {
  const r = await v.verificarCadena(registros, opciones);
  comprobar(!r.ok && r.seq === seq && r.motivo === motivo,
    `${nombre}: se esperaba ${motivo} en el ${seq} y salió ${r.ok ? "ok" : `${r.motivo} en el ${r.seq} (${r.detalle})`}`);
}
async function rehacer(r) {
  r.Huella = await v.huellaRegistro(r);
  return r;
}
{
  const m = copia(fixture);
  m[1].CuotaTotal = "99.99";
  await rehacer(m[1]);
  await espera("registro 2 alterado y su huella rehecha", m, {}, 3, "encadenamiento");
}
{
  const m = copia(fixture);
  m[4].ImporteTotal = "1.00";
  await espera("importe del 5 cambiado sin rehacer la huella", m, {}, 5, "huella");
}
await espera("falta el registro 4", fixture.filter((r) => r.seq !== 4), {}, 5, "secuencia");
{
  const ultimo = fixture[nFixture - 1];
  const sinUltimo = fixture.slice(0, -1);
  const r = await v.verificarCadena(sinUltimo);
  comprobar(r.ok, "sin el último y sin ancla, el JS no puede verlo (da ok)");
  await espera("sin el último, con ancla", sinUltimo, { ancla: { seq: ultimo.seq, huella: ultimo.Huella } }, ultimo.seq, "ancla");
  await espera("ancla con otra huella", fixture, { ancla: { seq: 2, huella: c1.huella } }, 2, "ancla");
}
{
  const m = copia(fixture);
  m[5].IDEmisorFactura = "A00000000";
  await espera("NIF cambiado en el 6", m, {}, 6, "emisor");
}
await espera("NIF esperado distinto", fixture, { nif: "A00000000" }, 1, "emisor");
await espera("reloj de la verificación en 2023", fixture, { ahora: Date.parse("2023-12-31T00:00:00Z") }, 1, "fecha_hora_futura");
{
  const m = copia(fixture);
  m[2].Encadenamiento = { PrimerRegistro: "S" };
  await espera("PrimerRegistro en el 3", m, {}, 3, "encadenamiento");
}
{
  const m = copia(fixture);
  m[3].TipoHuella = "02";
  await espera("TipoHuella 02", m, {}, 4, "formato");
}
{
  const m = copia(fixture);
  m[3].CuotaTotal = "21";
  await espera("CuotaTotal sin decimales", m, {}, 4, "formato");
}

// Cadenas construidas aquí mismo, con huellas correctas, para los motivos que no salen alterando el fixture.
async function construir(lista) {
  const salida = [];
  for (const [i, datos] of lista.entries()) {
    const anterior = salida[i - 1];
    const r = {
      seq: i + 1, ...datos,
      Encadenamiento: anterior ? {
        RegistroAnterior: {
          IDEmisorFactura: anterior.IDEmisorFactura ?? anterior.IDEmisorFacturaAnulada,
          NumSerieFactura: anterior.NumSerieFactura ?? anterior.NumSerieFacturaAnulada,
          FechaExpedicionFactura: anterior.FechaExpedicionFactura ?? anterior.FechaExpedicionFacturaAnulada,
          Huella: anterior.Huella,
        },
      } : { PrimerRegistro: "S" },
      TipoHuella: "01",
    };
    salida.push(await rehacer(r));
  }
  return salida;
}
const alta = (num, hora, extra = {}) => ({
  TipoRegistro: "alta", IDEmisorFactura: "89890001K", NumSerieFactura: num, FechaExpedicionFactura: "01-01-2024",
  TipoFactura: "F1", CuotaTotal: "1.00", ImporteTotal: "2.00", Subsanacion: "N", FechaHoraHusoGenRegistro: hora, ...extra,
});
const anulacion = (num, hora) => ({
  TipoRegistro: "anulacion", IDEmisorFacturaAnulada: "89890001K", NumSerieFacturaAnulada: num,
  FechaExpedicionFacturaAnulada: "01-01-2024", FechaHoraHusoGenRegistro: hora,
});
await espera("la hora retrocede dos minutos",
  await construir([alta("A-1", "2024-01-01T10:02:00+01:00"), alta("A-2", "2024-01-01T10:00:00+01:00")]), {}, 2,
  "fecha_hora_retrocede");
await espera("alta repetida sin subsanación",
  await construir([alta("A-1", "2024-01-01T10:00:00+01:00"), alta("A-1", "2024-01-01T10:00:01+01:00")]), {}, 2,
  "regla_apertura");
await espera("anulación sin alta",
  await construir([anulacion("A-1", "2024-01-01T10:00:00+01:00")]), {}, 1, "regla_apertura");
await espera("subsanación sin alta",
  await construir([alta("A-1", "2024-01-01T10:00:00+01:00", { Subsanacion: "S" })]), {}, 1, "regla_apertura");
{
  const buena = await construir([alta("A-1", "2024-01-01T10:00:00+01:00"), anulacion("A-1", "2024-01-01T10:00:01+01:00"),
    alta("A-1", "2024-01-01T10:00:02+01:00"), alta("A-1", "2024-01-01T10:00:03+01:00", { Subsanacion: "S" })]);
  const r = await v.verificarCadena(buena);
  comprobar(r.ok, `alta, anulación, nueva alta y subsanación: tiene que dar ok y da ${JSON.stringify(r)}`);
}

console.log(`js-solo: ${verdes}/${total} comprobaciones en verde`);
if (verdes !== total) process.exit(1);
