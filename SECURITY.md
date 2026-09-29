# Seguridad

## Versiones con soporte

| Versión | Soporte |
|---|---|
| la última 0.x | sí |
| anteriores | no |

## Cómo avisar

Por **Private vulnerability reporting** de GitHub: en este repositorio, pestaña *Security* → *Report a vulnerability*. El aviso llega solo a quien mantiene el proyecto y no queda público hasta que haya arreglo. No hay dirección de correo para esto: por favor, no abras un *issue* público.

Ayuda mucho que el aviso diga:

- Qué pasa, en qué versión y con qué versión de PostgreSQL.
- Cómo se reproduce: el SQL o el JS mínimos.
- Qué esperabas que pasara.

## Qué entra

- Una huella que difiera de la especificación de la AEAT (v0.1.2) para alguna entrada que la librería acepte.
- Saltarse una guarda —bifurcar la cadena, alterar o borrar un registro, fijar un campo que pone la base— **sin DDL y sin ser superusuario**.
- Permisos que se escapan: un rol que, sin que se le conceda, llega a las tablas o a las funciones.
- Una verificación (SQL o JS) que da ok sobre una cadena alterada que debería detectar según el README.

## Qué no entra

- Lo que puede hacer el propietario o el superusuario con DDL: apagar disparadores, quitar restricciones, reemplazar funciones o restaurar una copia vieja. Es una limitación declarada en el README ([Qué puede y qué no un superusuario](README.md#qué-puede-y-qué-no-un-superusuario)).
- Lo que queda fuera del alcance de la librería: el XML, la firma, el envío a la AEAT y el código QR.

No hay programa de recompensas.
