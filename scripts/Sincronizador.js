import axios from 'axios';
import fs from 'fs';
import zlib from 'zlib';
import readline from 'readline';

// --- CONFIGURACIÓN ---
const TMDB_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiI1ZTA4ZDg3MTM4MzY5YjllMGJkNDZmYzgyNWRkMzc0MCIsIm5iZiI6MTc3NzQ5OTA5NS40ODE5OTk5LCJzdWIiOiI2OWYyN2JkNzZmNDk5YWRhOTZiZDhlOWMiLCJzY29wZXMiOlsiYXBpX3JlYWQiXSwidmVyc2lvbiI6MX0.U2FdjZaejIOTGHnNLPQrByxcLEQ8mTeL2kK3Ishcl-k';
const MI_API_URL = 'https://api.dunddermifflin.com/peliskal';
const ARCHIVO_PROGRESO = 'progreso.json';

const tmdbOptions = {
    headers: {
        Authorization: `Bearer ${TMDB_TOKEN}`,
        accept: 'application/json'
    },
    timeout: 10000 
};

// --- UTILIDADES ---
const obtenerFechaAyer = () => {
    const fecha = new Date();
    fecha.setDate(fecha.getDate() - 1);
    return `${String(fecha.getMonth() + 1).padStart(2, '0')}_${String(fecha.getDate()).padStart(2, '0')}_${fecha.getFullYear()}`;
};

const guardarEstado = (tipo, linea) => {
    let progreso = {};
    if (fs.existsSync(ARCHIVO_PROGRESO)) {
        try { progreso = JSON.parse(fs.readFileSync(ARCHIVO_PROGRESO, 'utf8')); } catch (e) { progreso = {}; }
    }
    progreso[tipo] = linea;
    fs.writeFileSync(ARCHIVO_PROGRESO, JSON.stringify(progreso));
    progreso = null; // Liberar referencia
};

const obtenerEstado = (tipo) => {
    if (!fs.existsSync(ARCHIVO_PROGRESO)) return 0;
    try {
        const progreso = JSON.parse(fs.readFileSync(ARCHIVO_PROGRESO, 'utf8'));
        return progreso[tipo] || 0;
    } catch { return 0; }
};

// --- FLUJO PRINCIPAL ---
async function descargarYDescomprimir(tipo) {
    const fecha = obtenerFechaAyer();
    const nombreBase = `${tipo}_ids_${fecha}`;
    const archivoGz = `${nombreBase}.json.gz`;
    const archivoJson = `${nombreBase}.json`;
    const url = `https://files.tmdb.org/p/exports/${archivoGz}`;

    if (fs.existsSync(archivoJson)) return archivoJson;

    try {
        const response = await axios({ method: 'get', url, responseType: 'stream' });
        const writer = fs.createWriteStream(archivoGz);
        response.data.pipe(writer);
        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
        const fileContents = fs.createReadStream(archivoGz);
        const unzip = zlib.createGunzip();
        const writeStream = fs.createWriteStream(archivoJson);
        await new Promise((resolve, reject) => {
            fileContents.pipe(unzip).pipe(writeStream).on('finish', resolve).on('error', reject);
        });
        if (fs.existsSync(archivoGz)) fs.unlinkSync(archivoGz);
        return archivoJson;
    } catch (error) { 
        return null; 
    }
}

async function procesarArchivo(rutaArchivo) {
    if (!rutaArchivo) return;

    const esSerie = rutaArchivo.includes('tv_series');
    const categoria = esSerie ? 'tv' : 'movie';
    const inicioDesde = obtenerEstado(categoria);
    let lineaActual = 0;

    // Stream con buffer pequeño para ahorrar RAM
    const fileStream = fs.createReadStream(rutaArchivo, { highWaterMark: 64 * 1024 });
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
        lineaActual++;
        if (lineaActual <= inicioDesde || !line.trim()) continue;

        let itemSimple = JSON.parse(line);

        try {
            const urlTMDB = `https://api.themoviedb.org/3/${categoria}/${itemSimple.id}?append_to_response=external_ids&language=es-ES`;
            const responseTMDB = await axios.get(urlTMDB, tmdbOptions);
            const d = responseTMDB.data;

            const rawDate = esSerie ? d.first_air_date : d.release_date;
            const releaseYear = rawDate ? new Date(rawDate).getFullYear() : null;

            let dataFinal = {
                id_tmdb: d.id,
                id_imdb: d.external_ids?.imdb_id || null,
                title: (esSerie ? d.name : d.title) || d.original_name || d.original_title,
                overview: d.overview || "",
                release_year: releaseYear,
                poster: d.poster_path || null,
                backdrop: d.backdrop_path || null,
                rating: d.vote_average || 0,
                popularity: d.popularity || 0,
                genres: d.genres ? d.genres.map(g => g.id) : [],
                type: categoria
            };

            if (esSerie && d.seasons) {
                dataFinal.seasons = d.number_of_seasons;
                dataFinal.episodes = d.number_of_episodes;
                dataFinal.seasons_details = [];

                for (const s of d.seasons) {
                    if (s.season_number === 0) continue;
                    try {
                        const urlS = `https://api.themoviedb.org/3/tv/${d.id}/season/${s.season_number}?language=es-ES`;
                        const resS = await axios.get(urlS, tmdbOptions);
                        
                        dataFinal.seasons_details.push({
                            season_number: resS.data.season_number,
                            episodes: resS.data.episodes.map(ep => ({
                                episode_number: ep.episode_number,
                                title: ep.name,
                                overview: ep.overview,
                                air_date: ep.air_date
                            }))
                        });
                        await new Promise(r => setTimeout(r, 100)); // Delay mínimo entre temporadas
                    } catch (e) { /* Error silencioso en temporadas */ }
                }
            }

            // Enviar a API y limpiar objeto
            await axios.post(MI_API_URL, dataFinal);
            dataFinal = null; 

            // Guardar progreso cada 50 líneas para no abusar del disco
            if (lineaActual % 50 === 0) {
                guardarEstado(categoria, lineaActual);
            }
            
            // Delay para respetar rate limit
            await new Promise(r => setTimeout(r, 350));

        } catch (error) {
            if (error.response?.status === 429) {
                await new Promise(r => setTimeout(r, 15000));
                lineaActual--; 
            } else if (error.response?.status !== 409) {
                // Solo guardar estado si no es un error de "duplicado"
                guardarEstado(categoria, lineaActual);
            }
        }
        itemSimple = null; // Forzar limpieza de memoria
    }
    
    // Eliminar archivo al finalizar para liberar espacio en disco
    if (fs.existsSync(rutaArchivo)) fs.unlinkSync(rutaArchivo);
}

async function iniciarTodo() {
    const fileSeries = await descargarYDescomprimir('tv_series');
    if (fileSeries) await procesarArchivo(fileSeries);

    const fileMovies = await descargarYDescomprimir('movie');
    if (fileMovies) await procesarArchivo(fileMovies);

    process.exit();
}

iniciarTodo();