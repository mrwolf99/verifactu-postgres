// Cómo se cuentan las cosas: VERDE, ROJO o NO MIRADO, con la causa, y el recuento «N/total · %».

export function porcentaje(n, total) {
  if (total === 0) return "0 %";
  return `${Math.floor((n * 100) / total)} %`;
}

export function segundos(ms) {
  return `${(ms / 1000).toFixed(1).replace(".", ",")} s`;
}

export function lineaPrueba(r) {
  const estado = r.estado.padEnd(9);
  const nombre = r.nombre.padEnd(27);
  const cuenta = `${String(r.comprobaciones).padStart(3)} comprob.`;
  let s = `${estado} ${nombre} ${cuenta}  ${segundos(r.ms).padStart(7)}`;
  if (r.causa) s += `\n          ↳ ${r.causa.split("\n").join("\n            ")}`;
  for (const n of r.noMirados) s += `\n          · NO MIRADO${n.grave ? " (grave)" : ""}: ${n.texto}`;
  return s;
}

export function resumenPasada(resultados, ms) {
  const verdes = resultados.filter((r) => r.estado === "VERDE").length;
  const rojos = resultados.filter((r) => r.estado === "ROJO").length;
  const sinMirar = resultados.filter((r) => r.estado === "NO MIRADO").length;
  const comprobaciones = resultados.reduce((a, r) => a + r.comprobaciones, 0);
  // Las notas NO MIRADO que no son graves no cambian el estado de su prueba, pero se cuentan: un resumen que no dice
  // lo que dejó fuera se lee como si lo cubriera todo.
  const notas = resultados.reduce((a, r) => a + r.noMirados.length, 0);
  return `pruebas en verde: ${verdes}/${resultados.length} · ${porcentaje(verdes, resultados.length)}`
    + `   rojas: ${rojos}   no miradas: ${sinMirar}   notas NO MIRADO: ${notas}   comprobaciones: ${comprobaciones}`
    + `   tiempo: ${segundos(ms)}`;
}
