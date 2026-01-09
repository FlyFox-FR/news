const Parser = require('rss-parser');
const axios = require('axios');
const fs = require('fs');

const parser = new Parser();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- Ähnlichkeits-Check (Repariert) ---
function isSimilar(title1, title2) {
    if (!title1 || !title2) return false;
    
    // Alles klein, Sonderzeichen weg, in Wörter splitten
    const clean = t => t.toLowerCase().replace(/[^\w\säöüß]/g, '').split(/\s+/).filter(w => w.length > 3);
    const words1 = clean(title1);
    const words2 = clean(title2);

    // Schnittmenge berechnen
    const matches = words1.filter(w => words2.includes(w)).length;
    
    // Wenn mehr als 3 wichtige Wörter gleich sind oder 40% Übereinstimmung
    const threshold = Math.min(words1.length, words2.length) * 0.4; 
    return matches >= 3 || matches > threshold;
}

function loadExistingNews() {
    try {
        if (fs.existsSync('news.json')) return JSON.parse(fs.readFileSync('news.json', 'utf8'));
    } catch (e) { }
    return [];
}

async function analyzeWithPollinations(title, content, sourceName) {
    // Input kürzen
    const safeContent = (content || "").substring(0, 1500).replace(/<[^>]*>/g, "");

    const instruction = `Du bist News-Redakteur. Analysiere: "${title} - ${safeContent}"
    
    Antworte NUR mit validem JSON.
    ANWEISUNG:
    1. Suche nach harten Fakten (Zahlen, Orte, Namen).
    2. Schreibe 2-4 Bulletpoints.
    
    Format:
    {
      "newTitle": "Sachliche Überschrift",
      "scoop": "Kernaussage in einem Satz.",
      "bullets": ["Fakt 1", "Fakt 2", "Fakt 3"]
    }`;
    
    // Seed verhindert Caching
    const url = `https://text.pollinations.ai/${encodeURIComponent(instruction)}?model=openai&seed=${Math.floor(Math.random() * 10000)}`;

    let retries = 3;
    while (retries > 0) {
        try {
            const response = await axios.get(url, { timeout: 35000 });
            
            let rawText = response.data;
            if (typeof rawText !== 'string') rawText = JSON.stringify(rawText);

            // --- AGGRESSIVER CLEANER ---
            // 1. Werbung weg
            rawText = rawText.split("--- Support")[0]; 
            rawText = rawText.split("🌸 Ad")[0];
            
            // 2. Markdown weg (```json ... ```)
            rawText = rawText.replace(/```json/g, "").replace(/```/g, "").trim();

            // 3. Alles vor { und nach } abschneiden
            const firstOpen = rawText.indexOf('{');
            const lastClose = rawText.lastIndexOf('}');
            
            if (firstOpen !== -1 && lastClose !== -1) {
                rawText = rawText.substring(firstOpen, lastClose + 1);
            }

            let data;
            try {
                data = JSON.parse(rawText);
            } catch (jsonError) {
                // Letzter Rettungsversuch: Manchmal fehlen Anführungszeichen bei Keys
                console.log("⚠️ JSON kaputt, nutze Fallback-Daten.");
                throw new Error("JSON Broken");
            }

            // Validierung
            if (!data.bullets || !Array.isArray(data.bullets)) data.bullets = [];
            
            // Aufzählungszeichen entfernen
            data.bullets = data.bullets.map(b => b.replace(/^(Fakt \d:|Punkt \d:|-|\*|•)\s*/i, "").trim());

            return { 
                summary: data.scoop || title, 
                newTitle: data.newTitle || title, 
                bullets: data.bullets,   
                tags: [sourceName, "News"] 
            };

        } catch (error) {
            const status = error.response?.status;
            
            if (status === 429) {
                console.log(`🛑 Zu schnell! Warte 30s...`);
                await sleep(30000); 
                retries--;
                continue; 
            }

            // Bei JSON Fehlern warten wir kurz und probieren es nochmal (neuer Seed hilft oft)
            console.error(`⚠️ Fehler: ${error.message}. Warte kurz...`);
            await sleep(5000);
            retries--;
        }
    }

    // Harter Fallback (damit das Skript nicht abbricht)
    return { summary: title, newTitle: title, bullets: [], tags: [sourceName] };
}

async function run() {
    console.log("🚀 Starte News-Abruf (Fixed Edition)...");
    
    let sources = [];
    try { sources = JSON.parse(fs.readFileSync('sources.json', 'utf8')); } 
    catch(e) { 
        console.log("⚠️ Keine sources.json, nutze Standard.");
        sources = [{ name: "Tagesschau", url: "https://www.tagesschau.de/xml/rss2/", count: 3, country: "🇩🇪" }]; 
    }

    const existingNews = loadExistingNews();
    let newNewsFeed = [];

    for (const source of sources) {
        try {
            console.log(`\n📡 ${source.name}...`);
            const feed = await parser.parseURL(source.url);
            const items = feed.items.slice(0, source.count);

            for (const item of items) {
                // Wir generieren IMMER neu (außer es ist exakt derselbe Link im Cache mit Bullets)
                // Cache-Check für exakte Performance
                const cached = existingNews.find(n => n.link === item.link);
                if (cached && cached.bullets && cached.bullets.length > 0) {
                     // Check ob es schon im neuen Feed gruppiert wurde? Nein, wir laden es erstmal.
                     // Wir verarbeiten cached items genauso wie neue, um Gruppierung zu prüfen
                }

                console.log(`🤖 Analysiere: ${item.title.substring(0, 30)}...`);
                
                const rawContent = item.contentSnippet || item.content || "";
                
                // KI Analyse starten
                const ai = await analyzeWithPollinations(item.title, rawContent, source.name);
                
                const newsItem = {
                    id: Math.random().toString(36).substr(2, 9),
                    source: source.name,
                    sourceCountry: source.country || "🌍",
                    title: ai.newTitle || item.title,
                    originalTitle: item.title,
                    link: item.link,
                    img: item.enclosure?.url || item.itunes?.image || null,
                    date: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
                    text: ai.summary,
                    bullets: ai.bullets,
                    tags: ai.tags,
                    related: [] 
                };

                // --- GRUPPIERUNG ---
                // Prüfen: Haben wir schon eine ähnliche Story im 'newNewsFeed'?
                const parentIndex = newNewsFeed.findIndex(n => isSimilar(n.originalTitle, item.title));

                if (parentIndex !== -1) {
                    console.log(`🔗 Gruppiere "${item.title.substring(0,20)}..." zu existierender Story.`);
                    // Als Variante hinzufügen
                    newNewsFeed[parentIndex].related.push(newsItem);
                } else {
                    // Neue Haupt-Story
                    newNewsFeed.push(newsItem);
                }
                
                // 10 Sekunden Pause für API-Stabilität
                await sleep(10000); 
            }
        } catch (e) { console.error(`❌ Fehler bei ${source.name}:`, e.message); }
    }

    newNewsFeed.sort((a, b) => new Date(b.date) - new Date(a.date));
    fs.writeFileSync('news.json', JSON.stringify(newNewsFeed, null, 2));
    console.log(`✅ Fertig! ${newNewsFeed.length} Nachrichten-Cluster.`);
}

run();
