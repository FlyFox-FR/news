const Parser = require('rss-parser');
const axios = require('axios');
const fs = require('fs');

const parser = new Parser();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- Ähnlichkeits-Check (Verbessert) ---
// Wir vergleichen Titel, kürzen sie und prüfen die Schnittmenge.
function getSimilarityScore(title1, title2) {
    const clean = t => t.toLowerCase().replace(/[^\w\säöüß-]/g, '').split(/\s+/).filter(w => w.length > 3);
    const words1 = new Set(clean(title1));
    const words2 = new Set(clean(title2));

    let matches = 0;
    words1.forEach(word => {
        if (words2.has(word)) matches++;
    });

    // Schwellenwert: Wenn mehr als 3 Wörter übereinstimmen oder 30% der Wörter
    return matches >= 3 || (words1.size > 0 && matches / words1.size > 0.3);
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
            const response = await axios.get(url, { timeout: 40000 });
            let rawText = response.data;
            if (typeof rawText !== 'string') rawText = JSON.stringify(rawText);

            rawText = rawText.split("--- Support")[0]; 
            const firstOpen = rawText.indexOf('{');
            const lastClose = rawText.lastIndexOf('}');
            if (firstOpen !== -1 && lastClose !== -1) rawText = rawText.substring(firstOpen, lastClose + 1);

            let data;
            try { data = JSON.JSON.parse(rawText); } catch (e) { throw new Error("JSON Error"); }
            if (!data.bullets) data.bullets = [];
            data.bullets = data.bullets.map(b => b.replace(/^(Fakt \d:|Punkt \d:|-|\*|•)\s*/i, "").trim());

            return { summary: data.scoop || title, newTitle: data.newTitle || title, bullets: data.bullets, tags: [sourceName, "News"] };

        } catch (error) {
            const status = error.response?.status;
            if (status === 429) { console.log(`🛑 Zu schnell! Warte 30s...`); await sleep(30000); retries--; continue; }
            console.error(`⚠️ Fehler: ${error.message}. Warte kurz...`);
            await sleep(5000); retries--;
        }
    }
    return { summary: title, newTitle: title, bullets: [], tags: [sourceName] };
}

async function run() {
    console.log("🚀 Starte News-Abruf (Clustering Edition)...");
    
    let sources = [];
    try { sources = JSON.parse(fs.readFileSync('sources.json', 'utf8')); } 
    catch(e) { sources = [{ name: "Tagesschau", url: "https://www.tagesschau.de/xml/rss2/", count: 3, country: "🇩🇪" }]; }

    const existingNews = loadExistingNews();
    let currentFeed = []; // Hier bauen wir die neue Liste auf

    for (const source of sources) {
        try {
            console.log(`\n📡 ${source.name}...`);
            const feed = await parser.parseURL(source.url);
            const items = feed.items.slice(0, source.count);

            for (const item of items) {
                // NEU: Prüfen, ob wir eine ähnliche Story haben (im aktuellen Lauf!)
                const parentIndex = currentFeed.findIndex(n => isSimilar(n.originalTitle, item.title));
                
                console.log(`🤖 Analysiere: ${item.title.substring(0, 30)}...`);
                const rawContent = item.contentSnippet || item.content || "";
                const ai = await analyzeWithPollinations(item.title, rawContent, source.name);
                
                const newsItem = {
                    id: Math.random().toString(36).substr(2, 9),
                    source: source.name,
                    sourceCountry: source.country || "🌍",
                    title: ai.newTitle || item.title,
                    originalTitle: item.title, // Wichtig für die Ähnlichkeitsprüfung!
                    link: item.link,
                    img: item.enclosure?.url || item.itunes?.image || null,
                    date: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
                    text: ai.summary,
                    bullets: ai.bullets,
                    tags: ai.tags,
                    related: [] // Hier kommen Duplikate rein
                };

                if (parentIndex !== -1) {
                    // Ähnliche News gefunden -> Füge diese als Variante hinzu
                    console.log(`🔗 Gruppiere "${item.title.substring(0,20)}..." zur existierenden Story.`);
                    currentFeed[parentIndex].related.push(newsItem);
                } else {
                    // Keine Ähnlichkeit gefunden -> Neue Haupt-Story
                    currentFeed.push(newsItem);
                }
                
                await sleep(10000); 
            }
        } catch (e) { console.error(`❌ Fehler bei ${source.name}:`, e.message); }
    }

    // Sortieren und Speichern
    currentFeed.sort((a, b) => new Date(b.date) - new Date(a.date));
    fs.writeFileSync('news.json', JSON.stringify(currentFeed, null, 2));
    console.log(`✅ Fertig! ${currentFeed.length} Themen-Cluster gespeichert.`);
}

run();
