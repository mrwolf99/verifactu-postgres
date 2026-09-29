// El helper JS contra los vectores oficiales, el fixture y las manipulaciones (test/js-solo.mjs), en tres
// entornos: Node con WebCrypto, Node sin WebCrypto (el respaldo node:crypto, el camino de Node 18) y Deno.
import path from "node:path";

export const descripcion = "JS: vectores y fixture en Node (WebCrypto y respaldo node:crypto) y en Deno";

export default async function (t) {
  const script = path.join(t.raiz, "test/js-solo.mjs");
  const ejecuciones = [
    { nombre: "node", orden: process.execPath, args: [script, t.jsPath], cripto: "WebCrypto" },
    { nombre: "node sin WebCrypto", orden: process.execPath, args: [script, t.jsPath, "--sin-webcrypto"], cripto: "node:crypto (respaldo)" },
    { nombre: "deno", orden: "deno", args: ["run", "--allow-read", script, t.jsPath], cripto: "WebCrypto",
      env: { DENO_DIR: path.join(t.tmp, "deno"), DENO_NO_UPDATE_CHECK: "1", NO_COLOR: "1" } },
  ];
  const cuentas = new Set();
  for (const e of ejecuciones) {
    const r = await t.ejecutar(e.orden, e.args, { env: e.env });
    if (e.nombre === "deno" && r.codigo === null && /ENOENT/.test(r.error)) {
      t.noMirado("Deno no está en el PATH: el helper no se ha probado en Deno", { grave: true });
      continue;
    }
    const resumen = /js-solo: ([0-9]+)\/([0-9]+) comprobaciones en verde/.exec(r.salida);
    const primerRojo = r.salida.split("\n").find((l) => l.startsWith("ROJO ")) ?? "";
    t.ok(r.codigo === 0 && resumen && resumen[1] === resumen[2],
      `${e.nombre}: ${primerRojo.slice(5) || (r.error.trim().split("\n").slice(-3).join(" | ") || `salió con ${r.codigo}`)}`);
    t.ok(r.salida.split("\n")[0].includes(e.cripto), `${e.nombre}: no usó ${e.cripto}: ${r.salida.split("\n")[0]}`);
    cuentas.add(resumen[2]);
  }
  t.ok(cuentas.size === 1, `los entornos no corrieron las mismas comprobaciones: ${[...cuentas].join(", ")}`);
}
