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

    // --- DER "TRUTH & FACTS" PROMPT ---
    const instruction = `Du bist ein strenger Fakten-Checker für Nachrichten.
    Analysiere diesen Text: "${title} - ${safeContent}"
    
    Aufgabe: Erstelle ein JSON-Objekt.
    
    STRENGE REGELN (WICHTIG):
    1. Nutze AUSSCHLIESSLICH Informationen, die im Input-Text stehen. Erfinde KEINE Zahlen, Namen oder Gründe dazu!
    2. Wenn der Text kurz ist, erstelle nur 2 Bulletpoints. Wenn er lang ist, maximal 4.
    3. Keine Nummerierung in den Texten (nicht "1.", nicht "Fakt:").
    4. newTitle: Sachlich, kurz, kein Clickbait.
    
    Format:
    {
      "newTitle": "Die neue Überschrift",
      "scoop": "Die Kernaussage in einem Satz.",
      "bullets": [
        "Detail 1",
        "Detail 2",
        "Detail 3"
      ]
    }`;
    
    // Seed für Determinismus
    const url = `https://text.pollinations.ai/${encodeURIComponent(instruction)}?model=openai&seed=${Math.floor(Math.random() * 1000)}`;

    let retries = 3;
    while (retries > 0) {
        try {
            const response = await axios.get(url, { timeout: 40000 });
            
            let rawText = response.data;
            if (typeof rawText !== 'string') rawText = JSON.stringify(rawText);

            // --- REPARATUR-KIT ---
            // 1. Alles vor der ersten Klammer { und nach der letzten } wegwerfen
            const firstOpen = rawText.indexOf('{');
            const lastClose = rawText.lastIndexOf('}');
            
            if (firstOpen !== -1 && lastClose !== -1) {
                rawText = rawText.substring(firstOpen, lastClose + 1);
            }

            // 2. JSON Parsen
            let data;
            try {
                data = JSON.parse(rawText);
            } catch (jsonError) {
                console.log("⚠️ JSON kaputt, versuche Reparatur...");
                // Manchmal fehlen Anführungszeichen, aber wir nutzen dann lieber den Fallback
                throw new Error("Invalid JSON");
            }

            // 3. Inhalt prüfen & putzen
            if (!data.bullets || !Array.isArray(data.bullets)) data.bullets = [];
            
            // "Fakt 1:" oder "- " am Anfang entfernen
            data.bullets = data.bullets.map(b => b.replace(/^(Fakt \d:|Punkt \d:|-|\*)\s*/i, "").trim());

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

    // Fallback: Wenn alles scheitert
    return { summary: title, newTitle: title, bullets: [], tags: [sourceName] };
}

async function run() {
    console.log("🚀 Starte News-Abruf (Truth Mode)...");
    
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
                
                // Cache nutzen: Nur wenn Bullets da sind UND der Text nicht der Titel ist
                if (cached && cached.bullets && cached.bullets.length > 0 && cached.text !== cached.title) {
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
                
                // 10 Sekunden Pause beibehalten
                await sleep(10000); 
            }
        } catch (e) { console.error(`❌ Fehler bei ${source.name}:`, e.message); }
    }

    newNewsFeed.sort((a, b) => new Date(b.date) - new Date(a.date));
    fs.writeFileSync('news.json', JSON.stringify(newNewsFeed, null, 2));
    console.log(`✅ Fertig! ${newNewsFeed.length} Nachrichten gespeichert.`);
}

run();
