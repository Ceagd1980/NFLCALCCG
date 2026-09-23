# Radar NFL

Web que muestra los partidos NFL de la semana con datos de TeamRankings.com:
posición en su división, % de victorias y racha; puntos, touchdowns, yardas por punto
y yardas por juego (local en casa / visita fuera); 3 marcadores posibles, total de
puntos y hándicap (spread).

## Estructura
- `public/index.html` — la página
- `netlify/functions/nfl.mjs` — lee TeamRankings y entrega `/api/nfl`
- `netlify.toml` — configuración de Netlify (no cambiar)

## Publicar
1. Crear repositorio nuevo en GitHub y subir arrastrando las carpetas `public` y `netlify`
   más los archivos `netlify.toml`, `package.json` y `README.md`. No hace falta main.yml.
2. Netlify → Add new site → Import from GitHub → elegir el repositorio → Deploy.
