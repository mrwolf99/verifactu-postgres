// El repositorio no lleva datos que no deba: ningún NIF fuera de la lista blanca, ninguna ruta de usuario, ningún
// correo (salvo las direcciones noreply), nada con forma de JWT, de clave o de dirección de un proyecto de Supabase.
//
// Mira dos sitios, porque una fuga puede estar en cualquiera de los dos:
//  · los ficheros del árbol de trabajo (también los ignorados, que un zip o un «git add -f» se llevarían);
//  · el HISTORIAL de git: el texto de cada commit y cada etiqueta (autor, committer, mensaje) y el contenido de cada
//    fichero de cada commit alcanzable. Eso no lo ve un grep sobre la carpeta: los objetos van comprimidos.
//
// Con VF_LISTA_NEGRA=/ruta/a/lista.txt pasa además una lista negra PROPIA, que vive fuera del repositorio (un
// término por línea, sin distinguir mayúsculas; «re:» delante para una expresión regular; «#» para comentarios).
// De esa lista nunca se imprime el término: solo su número de línea.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const descripcion = "Limpieza del árbol y del historial de git: NIF, rutas, correos, JWT, claves; lista negra propia opcional";

const BLANCA = new Set(["89890001K", "A00000000", "B00000000"]);
const CORREO_PERMITIDO = /^(?:noreply@anthropic\.com|(?:[0-9]+\+)?[A-Za-z0-9-]+@users\.noreply\.github\.com)$/i;
const REGLAS = [
  ["un NIF fuera de la lista blanca", /\b(?:[0-9]{8}[A-Z]|[A-Z][0-9]{7}[0-9A-Z])\b/g, (m) => !BLANCA.has(m)],
  ["una ruta de usuario", /\/(?:Users|home)\/[A-Za-z0-9._-]+/g],
  ["un correo", /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, (m) => !CORREO_PERMITIDO.test(m)],
  ["algo con forma de JWT", /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ["algo con forma de clave", /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}|\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["una dirección de proyecto de Supabase", /[a-z0-9]{20}\.supabase\.(?:co|in)\b/g],
];

function leerListaNegra(ruta) {
  const reglas = [];
  fs.readFileSync(ruta, "utf8").split("\n").forEach((linea, i) => {
    const l = linea.trim();
    if (l === "" || l.startsWith("#")) return;
    const re = l.startsWith("re:") ? new RegExp(l.slice(3), "gi") : new RegExp(l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    reglas.push([`el término de la línea ${i + 1} de la lista negra`, re]);
  });
  return reglas;
}

/** Aplica las reglas a un texto; devuelve «dónde: qué» por cada acierto. */
function revisar(texto, donde, reglas) {
  const hallazgos = [];
  texto.split("\n").forEach((linea, i) => {
    for (const [que, re, filtro] of reglas) {
      for (const m of linea.matchAll(re)) if (!filtro || filtro(m[0])) hallazgos.push(`${donde}:${i + 1}: ${que}`);
    }
  });
  return hallazgos;
}

function recorrer(dir, raiz, salida) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const ruta = path.join(dir, e.name);
    if (e.isDirectory()) recorrer(ruta, raiz, salida);
    else if (e.isFile()) salida.push(path.relative(raiz, ruta));
  }
  return salida;
}

function git(dir, args, { entrada, env } = {}) {
  const r = spawnSync("git", ["-C", dir, ...args], {
    input: entrada, env: { ...process.env, ...env }, maxBuffer: 512 * 1024 * 1024,
  });
  if (r.error) throw new Error(`git ${args[0]}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`git ${args[0]} salió con ${r.status}: ${String(r.stderr).trim()}`);
  return r.stdout;
}

/** Todos los commits, etiquetas y ficheros alcanzables desde cualquier referencia, con su texto. */
function objetosDelHistorial(dir, env) {
  const nombres = new Map();
  for (const linea of git(dir, ["rev-list", "--all", "--objects"], { env }).toString("utf8").split("\n")) {
    if (!linea) continue;
    const i = linea.indexOf(" ");
    const sha = i < 0 ? linea : linea.slice(0, i);
    if (!nombres.has(sha)) nombres.set(sha, i < 0 ? "" : linea.slice(i + 1));
  }
  if (nombres.size === 0) return [];
  const tipos = git(dir, ["cat-file", "--batch-check=%(objecttype) %(objectname)"],
    { entrada: [...nombres.keys()].join("\n") + "\n", env }).toString("utf8").split("\n").filter(Boolean).map((l) => l.split(" "));
  const interesan = tipos.filter(([tipo]) => tipo === "commit" || tipo === "tag" || tipo === "blob").map(([tipo, sha]) => ({ tipo, sha }));
  const crudo = git(dir, ["cat-file", "--batch"], { entrada: interesan.map((o) => o.sha).join("\n") + "\n", env });
  const salida = [];
  let pos = 0;
  for (const o of interesan) {
    const fin = crudo.indexOf(0x0a, pos);
    const [sha, tipo, tam] = crudo.toString("utf8", pos, fin).split(" ");
    if (sha !== o.sha || tipo !== o.tipo) throw new Error(`cat-file devolvió ${sha} ${tipo} y se esperaba ${o.sha} ${o.tipo}`);
    const inicio = fin + 1;
    salida.push({ ...o, ruta: nombres.get(o.sha), texto: crudo.toString("utf8", inicio, inicio + Number(tam)) });
    pos = inicio + Number(tam) + 1;
  }
  return salida;
}

function revisarHistorial(dir, reglas, env) {
  const hallazgos = [];
  const objetos = objetosDelHistorial(dir, env);
  for (const o of objetos) {
    const donde = `historial ${o.tipo} ${o.sha.slice(0, 8)}${o.ruta ? ` (${o.ruta})` : ""}`;
    hallazgos.push(...revisar(o.texto, donde, reglas));
  }
  return { hallazgos, objetos };
}

export default async function (t) {
  const listaNegra = process.env.VF_LISTA_NEGRA ? leerListaNegra(process.env.VF_LISTA_NEGRA) : [];
  const reglas = [...REGLAS, ...listaNegra];

  // 1. El árbol de trabajo.
  const ficheros = recorrer(t.raiz, t.raiz, []);
  t.ok(ficheros.length >= 30, `solo se han encontrado ${ficheros.length} ficheros: la búsqueda no recorre el repositorio`);
  const enArbol = ficheros.flatMap((f) => revisar(fs.readFileSync(path.join(t.raiz, f), "utf8"), f, reglas));
  t.ok(enArbol.length === 0, `${enArbol.length} hallazgos en el árbol: ${enArbol.slice(0, 6).join(" · ")}`);

  // 2. El historial de git.
  if (!fs.existsSync(path.join(t.raiz, ".git"))) {
    t.noMirado("historial de git: esta copia no lleva .git (por ejemplo, instalada desde npm)");
  } else {
    let r;
    try {
      r = revisarHistorial(t.raiz, reglas);
    } catch (e) {
      t.noMirado(`historial de git: ${e.message}`, { grave: true });
    }
    if (r) {
      t.ok(r.objetos.some((o) => o.tipo === "commit"), "el historial no tiene ningún commit: la búsqueda no lo recorre");
      t.ok(r.hallazgos.length === 0, `${r.hallazgos.length} hallazgos en el historial de git: ${r.hallazgos.slice(0, 6).join(" · ")}`);
    }
  }
  if (!process.env.VF_LISTA_NEGRA) {
    t.noMirado("lista negra propia: VF_LISTA_NEGRA no está puesta; solo se han pasado las reglas genéricas");
  }

  // 3. La guarda sabe ponerse roja: cada regla caza su ejemplo (construido aquí, no guardado en el repositorio).
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
  t.ok(REGLAS[2][2]("mrwolf99" + "@users.noreply.github.com") === false && REGLAS[2][2]("noreply" + "@anthropic.com") === false,
    "las direcciones noreply no cuentan como correo");

  // 4. Y el historial también: un repositorio de cebo, en el temporal de la prueba, con un correo en el autor, un NIF
  //    en un fichero que el último commit ya borró y un término de una lista negra de prueba en un mensaje.
  const cebo = path.join(t.tmp, "cebo");
  fs.mkdirSync(cebo);
  const aislado = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "cebo", GIT_COMMITTER_NAME: "cebo",
    GIT_AUTHOR_EMAIL: cebos[3], GIT_COMMITTER_EMAIL: "cebo" + "@users.noreply.github.com" };
  const termino = "cebo-lista-" + crypto.randomBytes(4).toString("hex");
  let hist = null;
  try {
    git(cebo, ["init", "-q"], { env: aislado });
    fs.writeFileSync(path.join(cebo, "datos.txt"), `nada\n${cebos[0]}\n`);
    git(cebo, ["add", "datos.txt"], { env: aislado });
    git(cebo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "primero"], { env: aislado });
    fs.writeFileSync(path.join(cebo, "datos.txt"), "nada\n");
    git(cebo, ["-c", "commit.gpgsign=false", "commit", "-q", "-a", "-m", `segundo ${termino}`], { env: aislado });
    const listaCebo = path.join(t.tmp, "lista-cebo.txt");
    fs.writeFileSync(listaCebo, `# lista de prueba\n${termino.toUpperCase()}\n`);
    hist = revisarHistorial(cebo, [...REGLAS, ...leerListaNegra(listaCebo)], aislado);
  } catch (e) {
    t.noMirado(`el cebo del historial no se pudo montar: ${e.message}`, { grave: true });
  }
  if (hist) {
    const h = hist.hallazgos.join(" · ");
    t.ok(fs.readFileSync(path.join(cebo, "datos.txt"), "utf8") === "nada\n", "el cebo: el último commit tenía que dejar el fichero limpio");
    t.ok(hist.hallazgos.some((x) => /historial commit .*: un correo$/.test(x)), `el correo del autor de un commit no se caza: ${h}`);
    t.ok(hist.hallazgos.some((x) => /historial blob .*\(datos\.txt\).*: un NIF/.test(x)),
      `el NIF de un fichero que ya no está en el árbol no se caza: ${h}`);
    t.ok(hist.hallazgos.some((x) => /historial commit .*: el término de la línea 2 de la lista negra$/.test(x)),
      `la lista negra no caza su término en un mensaje de commit: ${h}`);
    t.ok(!h.includes(termino) && !h.toLowerCase().includes(termino), "el informe no puede imprimir el término de la lista negra");
    const commits = hist.objetos.filter((o) => o.tipo === "commit").length;
    t.ok(commits === 2 && hist.hallazgos.filter((x) => /un correo$/.test(x)).length === commits,
      `un correo por commit (el del autor; el committer noreply no cuenta), y salen ${hist.hallazgos.filter((x) => /un correo$/.test(x)).length} en ${commits} commits: ${h}`);
  }
}
