import axios from 'axios';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import readline from 'readline';

// --- CONFIGURACIÓN ---
const TMDB_TOKEN = '';
const MI_API_URL = 'https://api.dunddermifflin.com/peliskal';
const ARCHIVO_PROGRESO = 'progreso.json';

const tmdbOptions = {
    headers: {
        Authorization: `Bearer ${TMDB_TOKEN}`,
        accept: 'application/json'
    }
};

// --- UTILIDADES ---

const obtenerFechaAyer = () => {
    const fecha = new Date();
    fecha.setDate(fecha.getDate() - 1);
    const mes = String(fecha.getMonth() + 1).padStart(2, '0');
    const dia = String(fecha.getDate()).padStart(2, '0');
    const anio = fecha.getFullYear();
    return `${mes}_${dia}_${anio}`;
};

const guardarEstado = (tipo, linea) => {
    let progreso = {};
    if (fs.existsSync(ARCHIVO_PROGRESO)) {
        progreso = JSON.parse(fs.readFileSync(ARCHIVO_PROGRESO, 'utf8'));
    }
    progreso[tipo] = linea;
    fs.writeFileSync(ARCHIVO_PROGRESO, JSON.stringify(progreso, null, 2));
};

const obtenerEstado = (tipo) => {
    if (!fs.existsSync(ARCHIVO_PROGRESO)) return 0;
    const progreso = JSON.parse(fs.readFileSync(ARCHIVO_PROGRESO, 'utf8'));
    return progreso[tipo] || 0;
};

// --- FLUJO PRINCIPAL ---

async function descargarYDescomprimir(tipo) {
    const fecha = obtenerFechaAyer();
    const nombreBase = `${tipo}_ids_${fecha}`;
    const archivoGz = `${nombreBase}.json.gz`;
    const archivoJson = `${nombreBase}.json`;
    const url = `https://files.tmdb.org/p/exports/${archivoGz}`;

    if (fs.existsSync(archivoJson)) {
        console.log(`- El archivo ${archivoJson} ya existe. Saltando descarga.`);
        return archivoJson;
    }

    console.log(`- Descargando export de ${tipo} (${fecha})...`);
    
    try {
        const response = await axios({ method: 'get', url, responseType: 'stream' });
        const writer = fs.createWriteStream(archivoGz);
        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        console.log(`- Descomprimiendo ${tipo}...`);
        const fileContents = fs.createReadStream(archivoGz);
        const unzip = zlib.createGunzip();
        const writeStream = fs.createWriteStream(archivoJson);

        await new Promise((resolve, reject) => {
            fileContents.pipe(unzip).pipe(writeStream)
                .on('finish', resolve)
                .on('error', reject);
        });

        fs.unlinkSync(archivoGz); // Borrar el .gz para ahorrar espacio
        return archivoJson;
    } catch (error) {
        console.error(`❌ Error con ${tipo}:`, error.message);
        return null;
    }
}

async function procesarArchivo(rutaArchivo) {
    if (!rutaArchivo) return;

    const esSerie = rutaArchivo.includes('tv_series');
    const categoria = esSerie ? 'tv' : 'movie';
    const inicioDesde = obtenerEstado(categoria);
    let lineaActual = 0;

    console.log(`\n🚀 Procesando ${categoria.toUpperCase()} desde línea: ${inicioDesde}`);

    const fileStream = fs.createReadStream(rutaArchivo);
    const rl = readline.createInterface({ input: fileStream });

    for await (const line of rl) {
        lineaActual++;
        if (lineaActual <= inicioDesde || !line.trim()) continue;

        const itemSimple = JSON.parse(line);

        try {
            const urlTMDB = `https://api.themoviedb.org/3/${categoria}/${itemSimple.id}?append_to_response=external_ids&language=es-ES`;
            const responseTMDB = await axios.get(urlTMDB, tmdbOptions);
            const d = responseTMDB.data;

            if (d.external_ids?.imdb_id || d.id) {
                const dataFinal = {
                    id_tmdb: d.id,
                    id_imdb: d.external_ids?.imdb_id || null,
                    title: esSerie ? (d.name || d.original_name) : (d.title || d.original_title),
                    overview: d.overview,
                    release_year: new Date(esSerie ? d.first_air_date : d.release_date).getFullYear() || null,
                    poster: d.poster_path,
                    backdrop: d.backdrop_path,
                    rating: d.vote_average,
                    popularity: d.popularity,
                    genres: d.genres ? d.genres.map(g => g.id) : [],
                    type: categoria,
                    ...(esSerie && { 
                        seasons: d.number_of_seasons, 
                        episodes: d.number_of_episodes 
                    })
                };

                await axios.post(MI_API_URL, dataFinal);
                console.log(`[${categoria.toUpperCase()}] L${lineaActual} ✅: ${dataFinal.title}`);
            }

            if (lineaActual % 10 === 0) guardarEstado(categoria, lineaActual);
            await new Promise(r => setTimeout(r, 100)); // Anti-ban

        } catch (error) {
            if (error.response?.status === 429) {
                console.log("⏳ Límite excedido. Esperando 5s...");
                lineaActual--;
                await new Promise(r => setTimeout(r, 5000));
            } else {
                console.error(`❌ Error en ${categoria} L${lineaActual}:`, error.message);
            }
        }
    }
    console.log(`✅ Finalizado procesamiento de ${categoria}`);
}

async function iniciarTodo() {
    console.log("--- 1. PREPARANDO ARCHIVOS ---");
    
    // Descargamos ambos primero para asegurar que los archivos existan
    const fileMovies = await descargarYDescomprimir('movie');
    const fileSeries = await descargarYDescomprimir('tv_series');

    if (!fileMovies || !fileSeries) {
        console.error("❌ No se pudieron preparar los archivos. Abortando.");
        return;
    }

    console.log("\n--- 2. INICIANDO PROCESAMIENTO ---");

    // Procesa las películas primero
    console.log("--- Procesando Películas ---");
    await procesarArchivo(fileMovies);

    // Cuando termina las películas, sigue con las series
    console.log("\n--- Procesando Series ---");
    await procesarArchivo(fileSeries);

    console.log("\n🎉 ¡Todo el proceso ha terminado con éxito!");
    process.exit();
}

iniciarTodo();