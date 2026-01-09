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

async function analyzeWithPollinations(title, content, sourceName) {
    // Input bereinigen
    const safeContent = (content || "").substring(0, 1500).replace(/<[^>]*>/g, "");

    // --- DER "DETAIL-JÄGER" PROMPT ---
    const instruction = `Du bist ein investigativer News-Redakteur.
    Analysiere diesen Input: "${title} - ${safeContent}"
    
    Aufgabe: Erstelle ein JSON-Objekt auf DEUTSCH.
    
    ANWEISUNG:
    1. Suche aggressiv nach Details: Zahlen, Orte, Namen, Uhrzeiten, Geldbeträge.
    2. Wenn im Text "48 Stunden" oder "3000 Menschen" steht, MUSS das in die Bullets.
    3. Sprache: ZWINGEND DEUTSCH (auch wenn der Input Englisch ist).
    4. Versuche immer 3 bis 4 Bulletpoints zu finden.
    5. Sei präzise, aber nicht langweilig.
    
    Format:
    {
      "newTitle": "Knackige, informative Headline",
      "scoop": "Der wichtigste Satz (Was ist passiert?).",
      "bullets": [
        "Detail mit Zahl/Fakt 1",
        "Detail mit Name/Ort 2",
        "Hintergrund/Kontext 3"
      ]
    }`;
    
    // Seed für Variation
    const url = `https://text.pollinations.ai/${encodeURIComponent(instruction)}?model=openai&seed=${Math.floor(Math.random() * 1000)}`;

    let retries = 3;
    while (retries > 0) {
        try {
            // Timeout erhöht für bessere Ergebnisse
            const response = await axios.get(url, { timeout: 35000 });
            
            let rawText = response.data;
            if (typeof rawText !== 'string') rawText = JSON.stringify(rawText);

            // --- REPARATUR & CLEANING ---
            // Ad-Blocker
            rawText = rawText.split("--- Support")[0]; 
            
            // JSON ausschneiden
            const firstOpen = rawText.indexOf('{');
            const lastClose = rawText.lastIndexOf('}');
            
            if (firstOpen !== -1 && lastClose !== -1) {
                rawText = rawText.substring(firstOpen, lastClose + 1);
            }

            let data;
            try {
                data = JSON.parse(rawText);
            } catch (jsonError) {
                // Fallback: Manchmal hilft ein simpler Regex Fix
                console.log("⚠️ JSON Reparatur Versuch...");
                throw new Error("Invalid JSON");
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

            console.error(`⚠️ Fehler: ${error.message}. Warte kurz...`);
            await sleep(5000);
            retries--;
        }
    }

    return { summary: title, newTitle: title, bullets: [], tags: [sourceName] };
}

async function run() {
    console.log("🚀 Starte News-Abruf (Detail Hunter)...");
    
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
                const cached = existingNews.find(n => n.link === item.link);
                
                // Cache nutzen? Nur wenn Bullets da sind.
                // ACHTUNG: Ich habe den Cache-Check etwas gelockert, damit er englische Texte neu generiert (Deutsch-Zwang)
                if (cached && cached.bullets && cached.bullets.length > 1 && cached.text !== cached.title) {
                    newNewsFeed.push({ ...cached, lastUpdated: new Date() });
                    continue; 
                }

                console.log(`🤖 Analysiere: ${item.title.substring(0, 40)}...`);
                
                const rawContent = item.contentSnippet || item.content || "";
                const ai = await analyzeWithPollinations(item.title, rawContent, source.name);
                
                newNewsFeed.push({
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
                    tags: ai.tags
                });
                
                // 10 Sekunden Pause für Stabilität
                await sleep(10000); 
            }
        } catch (e) { console.error(`❌ Fehler bei ${source.name}:`, e.message); }
    }

    newNewsFeed.sort((a, b) => new Date(b.date) - new Date(a.date));
    fs.writeFileSync('news.json', JSON.stringify(newNewsFeed, null, 2));
    console.log(`✅ Fertig! ${newNewsFeed.length} Nachrichten gespeichert.`);
}

run();
