// El repositorio no lleva datos que no deba: ningún NIF fuera de la lista blanca, ninguna ruta de usuario,
// ningún correo, nada con forma de JWT, de clave o de dirección de un proyecto de Supabase.
import fs from "node:fs";
import path from "node:path";

export const descripcion = "Limpieza: NIF solo de la lista blanca; sin rutas de usuario, correos, JWT, claves ni *.supabase.co";

const BLANCA = new Set(["89890001K", "A00000000", "B00000000"]);
const REGLAS = [
  ["un NIF fuera de la lista blanca", /\b(?:[0-9]{8}[A-Z]|[A-Z][0-9]{7}[0-9A-Z])\b/g, (m) => !BLANCA.has(m)],
  ["una ruta de usuario", /\/(?:Users|home)\/[A-Za-z0-9._-]+/g],
  ["un correo", /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g],
  ["algo con forma de JWT", /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ["algo con forma de clave", /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}|\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["una dirección de proyecto de Supabase", /[a-z0-9]{20}\.supabase\.(?:co|in)\b/g],
];

function recorrer(dir, raiz, salida) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const ruta = path.join(dir, e.name);
    if (e.isDirectory()) recorrer(ruta, raiz, salida);
    else if (e.isFile()) salida.push(path.relative(raiz, ruta));
  }
  return salida;
}

export default async function (t) {
  const ficheros = recorrer(t.raiz, t.raiz, []);
  t.ok(ficheros.length >= 30, `solo se han encontrado ${ficheros.length} ficheros: la búsqueda no recorre el repositorio`);
  const hallazgos = [];
  for (const f of ficheros) {
    const texto = fs.readFileSync(path.join(t.raiz, f), "utf8");
    texto.split("\n").forEach((linea, i) => {
      for (const [que, re, filtro] of REGLAS) {
        for (const m of linea.matchAll(re)) {
          if (!filtro || filtro(m[0])) hallazgos.push(`${f}:${i + 1}: ${que}`);
        }
      }
    });
  }
  t.ok(hallazgos.length === 0, `${hallazgos.length} hallazgos: ${hallazgos.slice(0, 6).join(" · ")}`);

  // La guarda sabe ponerse roja: cada regla caza su ejemplo (construido aquí, no guardado en el repositorio).
  const cebos = [
    "12345678" + "Z", "X" + "1234567" + "L", "/Us" + "ers/alguien/x", "alguien" + "@" + "ejemplo.org",
    "eyJ" + "a".repeat(10) + "." + "b".repeat(10), "sk_" + "live_" + "c".repeat(10), "a".repeat(20) + ".supa" + "base.co",
  ];
  for (const [k, [que, re, filtro]] of REGLAS.entries()) {
    const m = cebos[k === 0 ? 0 : k + 1].match(new RegExp(re.source));
    t.ok(m && (!filtro || filtro(m[0])), `la regla «${que}» no caza su cebo`);
  }
  t.ok(REGLAS[0][2]("89890001K") === false, "el NIF oficial de los ejemplos no cuenta como hallazgo");
  t.ok(/\b(?:[0-9]{8}[A-Z]|[A-Z][0-9]{7}[0-9A-Z])\b/.test(cebos[1]), "la regla del NIF caza también la forma de NIE/CIF");
}
