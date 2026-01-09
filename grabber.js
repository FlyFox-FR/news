const Parser = require('rss-parser');
const axios = require('axios');
const fs = require('fs');

const parser = new Parser();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Ähnlichkeits-Check
function isSimilar(title1, title2) {
    const clean = t => t.toLowerCase().replace(/[^\w\säöüß]/g, '').split(/\s+/).filter(w => w.length > 3);
    const words1 = clean(title1);
    const words2 = clean(title2);
    const matches = words1.filter(w => words2.includes(w)).length;
    const threshold = Math.min(words1.length, words2.length) * 0.4; // 40% Übereinstimmung
    return matches >= 3 || matches > threshold;
}

function loadExistingNews() {
    try {
        if (fs.existsSync('news.json')) return JSON.parse(fs.readFileSync('news.json', 'utf8'));
    } catch (e) { }
    return [];
}

async function analyzeWithPollinations(title, content, sourceName) {
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
    
    const url = `https://text.pollinations.ai/${encodeURIComponent(instruction)}?model=openai&seed=${Math.floor(Math.random() * 10000)}`;

    let retries = 3;
    while (retries > 0) {
        try {
            const response = await axios.get(url, { timeout: 35000 });
            let rawText = response.data;
            if (typeof rawText !== 'string') rawText = JSON.stringify(rawText);

            // Cleaning
            rawText = rawText.split("--- Support")[0]; 
            const firstOpen = rawText.indexOf('{');
            const lastClose = rawText.lastIndexOf('}');
            if (firstOpen !== -1 && lastClose !== -1) rawText = rawText.substring(firstOpen, lastClose + 1);

            let data;
            try { data = JSON.parse(rawText); } catch (e) { throw new Error("JSON Error"); }
            
            if (!data.bullets) data.bullets = [];
            data.bullets = data.bullets.map(b => b.replace(/^(Fakt \d:|Punkt \d:|-|\*|•)\s*/i, "").trim());

            return { summary: data.scoop || title, newTitle: data.newTitle || title, bullets: data.bullets, tags: [sourceName, "News"] };

        } catch (error) {
            if (error.response?.status === 429) {
                console.log(`🛑 Zu schnell! Warte 30s...`);
                await sleep(30000); retries--; continue; 
            }
            console.error(`⚠️ Fehler: ${error.message}. Warte kurz...`);
            await sleep(5000); retries--;
        }
    }
    return { summary: title, newTitle: title, bullets: [], tags: [sourceName] };
}

async function run() {
    console.log("🚀 Starte News-Abruf (Full Stack Edition)...");
    
    let sources = [];
    try { sources = JSON.parse(fs.readFileSync('sources.json', 'utf8')); } 
    catch(e) { sources = [{ name: "Tagesschau", url: "https://www.tagesschau.de/xml/rss2/", count: 3, country: "🇩🇪" }]; }

    const existingNews = loadExistingNews();
    let newNewsFeed = [];

    for (const source of sources) {
        try {
            console.log(`\n📡 ${source.name}...`);
            const feed = await parser.parseURL(source.url);
            const items = feed.items.slice(0, source.count);

            for (const item of items) {
                // Check Cache (inklusive Unter-Artikel Prüfung wäre hier komplex, wir prüfen nur Hauptartikel)
                // Für dieses Feature generieren wir lieber frisch, um sicherzugehen.
                
                console.log(`🤖 Generiere: ${item.title.substring(0, 30)}...`);
                const rawContent = item.contentSnippet || item.content || "";
                
                // 1. IMMER ANALYSIEREN (User Wunsch: Nichts überspringen!)
                const ai = await analyzeWithPollinations(item.title, rawContent, source.name);
                
                // Das fertige News-Objekt
                const newsItem = {
                    id: Math.random().toString(36).substr(2, 9),
                    source: source.name,
                    sourceCountry: source.country || "🌍",
                    title: ai.newTitle,
                    originalTitle: item.title,
                    link: item.link,
                    img: item.enclosure?.url || item.itunes?.image || null,
                    date: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
                    text: ai.summary,
                    bullets: ai.bullets,
                    tags: ai.tags,
                    related: [] // Platz für Varianten
                };

                // 2. GRUPPIERUNG PRÜFEN
                // Ist schon eine ähnliche Story im neuen Feed?
                const parentIndex = newNewsFeed.findIndex(n => isSimilar(n.originalTitle, item.title));

                if (parentIndex !== -1) {
                    console.log(`🔗 Füge als Variante zu bestehender Story hinzu.`);
                    // Wir packen den GANZEN Artikel in das 'related' Array des existierenden Artikels
                    newNewsFeed[parentIndex].related.push(newsItem);
                } else {
                    // Neue Story -> Ab in den Feed
                    newNewsFeed.push(newsItem);
                }
                
                await sleep(10000); // Stabilitätspause
            }
        } catch (e) { console.error(`❌ Fehler bei ${source.name}:`, e.message); }
    }

    newNewsFeed.sort((a, b) => new Date(b.date) - new Date(a.date));
    fs.writeFileSync('news.json', JSON.stringify(newNewsFeed, null, 2));
    console.log(`✅ Fertig! ${newNewsFeed.length} Themen-Cluster gespeichert.`);
}

run();
