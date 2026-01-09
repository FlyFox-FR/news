const Parser = require('rss-parser');
const axios = require('axios');
const fs = require('fs');

const parser = new Parser();
const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadExistingNews() {
    try {
        if (fs.existsSync('news.json')) return JSON.parse(fs.readFileSync('news.json', 'utf8'));
    } catch (e) { }
    return [];
}

// 1. INHALTS-ANALYSE
async function analyzeWithPollinations(title, content, sourceName) {
    const safeContent = (content || "").substring(0, 1500).replace(/<[^>]*>/g, "");

    const instruction = `Du bist News-Redakteur. Analysiere: "${title} - ${safeContent}"
    Antworte NUR mit validem JSON.
    ANWEISUNG:
    1. Sprache: ZWINGEND DEUTSCH.
    2. Nenne NUR Länder/Personen, die im Text stehen. ERFINDE NICHTS.
    3. Suche nach harten Fakten (Zahlen, Orte).
    4. Schreibe 2-4 Bulletpoints.
    
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

            rawText = rawText.split("--- Support")[0]; 
            rawText = rawText.split("🌸 Ad")[0];
            rawText = rawText.replace(/```json/g, "").replace(/```/g, "").trim();

            const firstOpen = rawText.indexOf('{');
            const lastClose = rawText.lastIndexOf('}');
            if (firstOpen !== -1 && lastClose !== -1) rawText = rawText.substring(firstOpen, lastClose + 1);

            let data;
            try { data = JSON.parse(rawText); } catch (e) { throw new Error("JSON Error"); }
            if (!data.bullets) data.bullets = [];
            data.bullets = data.bullets.map(b => b.replace(/^(Fakt \d:|Punkt \d:|-|\*|•)\s*/i, "").trim());

            return { summary: data.scoop || title, newTitle: data.newTitle || title, bullets: data.bullets, tags: [sourceName, "News"] };

        } catch (error) {
            if (error.response?.status === 429) { await sleep(30000); retries--; continue; }
            await sleep(5000); retries--;
        }
    }
    return { summary: title, newTitle: title, bullets: [], tags: [sourceName] };
}

// 2. KI CLUSTERING (Mit erhöhtem Timeout)
async function clusterWithAI(articles) {
    if (articles.length === 0) return [];
    
    console.log(`🧠 KI sortiert ${articles.length} Artikel...`);

    // Liste bauen
    const listForAI = articles.map((a, index) => `ID ${index}: ${a.newTitle || a.title}`).join("\n");
    
    // Sicherheit: Falls Liste zu lang für URL ist, kürzen wir hart
    const safeList = listForAI.substring(0, 3500);

    const instruction = `Du bist ein News-Aggregator. Gruppiere diese Schlagzeilen nach EXAKT demselben Ereignis.
    
    Liste:
    ${safeList}
    
    Aufgabe: Gib ein JSON Array von Arrays zurück. Jedes innere Array enthält die IDs, die zusammengehören.
    Beispiel: [[0, 5], [1], [2, 3]]
    
    Regeln:
    1. "Sturm Elli" und "Unwetter im Norden" = GLEICHES EVENT -> Gruppieren.
    2. "Iran Protest" und "Iran Militärübung" = UNTERSCHIEDLICH -> Nicht gruppieren.
    3. Jede ID muss vorkommen.
    4. Antworte NUR mit dem JSON.`;

    const url = `https://text.pollinations.ai/${encodeURIComponent(instruction)}?model=openai&seed=${Math.floor(Math.random() * 1000)}`;

    try {
        // FIX: Timeout auf 120 Sekunden erhöht!
        const response = await axios.get(url, { timeout: 120000 });
        
        let rawText = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
        
        rawText = rawText.replace(/```json|```/g, "").trim();
        const first = rawText.indexOf('[');
        const last = rawText.lastIndexOf(']');
        if (first !== -1 && last !== -1) rawText = rawText.substring(first, last + 1);

        const groups = JSON.parse(rawText);
        
        if (!Array.isArray(groups) || !Array.isArray(groups[0])) throw new Error("Kein Array");

        console.log("🧠 KI-Gruppierung erfolgreich:", JSON.stringify(groups));
        
        let clusteredFeed = [];
        let usedIndices = new Set();

        groups.forEach(groupIndices => {
            let validIndices = groupIndices.filter(i => articles[i] !== undefined);
            if (validIndices.length === 0) return;

            // BILD-PRIORITÄT: Wer hat ein Bild? Der wird Chef.
            let bestParentIndex = 0; 
            for (let k = 0; k < validIndices.length; k++) {
                if (articles[validIndices[k]].img) {
                    bestParentIndex = k;
                    break; 
                }
            }

            let parentRealIndex = validIndices[bestParentIndex];
            let parent = articles[parentRealIndex];
            usedIndices.add(parentRealIndex);
            
            parent.related = [];

            for (let i = 0; i < validIndices.length; i++) {
                if (i === bestParentIndex) continue; 

                let childIndex = validIndices[i];
                if (!usedIndices.has(childIndex)) {
                    parent.related.push(articles[childIndex]);
                    usedIndices.add(childIndex);
                }
            }
            clusteredFeed.push(parent);
        });

        // Reste einsammeln
        articles.forEach((item, index) => {
            if (!usedIndices.has(index)) {
                item.related = [];
                clusteredFeed.push(item);
            }
        });

        return clusteredFeed;

    } catch (e) {
        console.error("❌ KI-Clustering fehlgeschlagen (Timeout/Error):", e.message);
        return articles; // Fallback: Alles anzeigen
    }
}

async function run() {
    console.log("🚀 Starte News-Abruf (High Timeout)...");
    
    let sources = [];
    try { sources = JSON.parse(fs.readFileSync('sources.json', 'utf8')); } 
    catch(e) { sources = [{ name: "Tagesschau", url: "https://www.tagesschau.de/xml/rss2/", count: 3, country: "🇩🇪" }]; }

    const existingNews = loadExistingNews();
    let flatFeed = [];
    
    existingNews.forEach(item => {
        let cleanItem = { ...item };
        delete cleanItem.related;
        flatFeed.push(cleanItem);
        if (item.related) item.related.forEach(child => flatFeed.push(child));
    });

    for (const source of sources) {
        try {
            console.log(`\n📡 ${source.name}...`);
            const feed = await parser.parseURL(source.url);
            const items = feed.items.slice(0, source.count);

            for (const item of items) {
                const existingIndex = flatFeed.findIndex(n => n.link === item.link);
                if (existingIndex !== -1) {
                    flatFeed[existingIndex].date = item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString();
                    continue; 
                }

                console.log(`🤖 Analysiere: ${item.title.substring(0, 30)}...`);
                const rawContent = item.contentSnippet || item.content || "";
                
                const ai = await analyzeWithPollinations(item.title, rawContent, source.name);
                
                let imgUrl = item.enclosure?.url || item.itunes?.image || null;

                flatFeed.push({
                    id: Math.random().toString(36).substr(2, 9),
                    source: source.name,
                    sourceCountry: source.country || "🌍",
                    title: ai.newTitle || item.title,
                    originalTitle: item.title,
                    link: item.link,
                    img: imgUrl,
                    date: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
                    text: ai.summary,
                    bullets: ai.bullets,
                    tags: ai.tags,
                    related: []
                });
                await sleep(10000); 
            }
        } catch (e) { console.error(`❌ Fehler bei ${source.name}:`, e.message); }
    }

    const finalFeed = await clusterWithAI(flatFeed);
    
    finalFeed.sort((a, b) => new Date(b.date) - new Date(a.date));

    fs.writeFileSync('news.json', JSON.stringify(finalFeed, null, 2));
    console.log(`✅ Fertig! ${finalFeed.length} Themen-Cluster.`);
}

run();
