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
    // Input kürzen (Platz lassen für die lange Antwort)
    const safeContent = (content || "").substring(0, 1200).replace(/<[^>]*>/g, "");

    // --- DER JSON-PROMPT ---
    // Wir fordern striktes JSON, damit wir die Daten im Frontend sauber anzeigen können.
    const instruction = `Du bist News-Redakteur. Analysiere: "${title} - ${safeContent}"
    
    Antworte NUR mit validem JSON (kein Markdown, kein Text davor/danach).
    Format:
    {
      "newTitle": "Sachliche, neutrale Überschrift (Anti-Clickbait)",
      "scoop": "Ein Satz, was der Kern der Nachricht ist.",
      "bullets": [
        "Fakt 1 mit Zahlen/Daten",
        "Fakt 2 (Hintergrund)",
        "Fakt 3 (Konsequenz)",
        "Fakt 4 (Detail)",
        "Fakt 5 (Ausblick)"
      ]
    }`;
    
    // Wir nutzen einen random Seed, damit er nicht cached
    const url = `https://text.pollinations.ai/${encodeURIComponent(instruction)}?model=openai&seed=${Math.floor(Math.random() * 10000)}`;

    let retries = 3;
    while (retries > 0) {
        try {
            const response = await axios.get(url, { timeout: 40000 }); // Längeres Timeout für mehr Text
            
            let rawText = response.data;
            if (typeof rawText !== 'string') rawText = JSON.stringify(rawText);

            // --- AD-BLOCKER & CLEANING ---
            // Wir schneiden alles ab, was nach Werbung aussieht
            rawText = rawText.split("--- Support")[0]; 
            rawText = rawText.split("🌸 Ad")[0];
            // Markdown Code-Blöcke entfernen, falls die KI welche macht
            rawText = rawText.replace(/```json/g, "").replace(/```/g, "").trim();

            // JSON Parsen
            let data;
            try {
                data = JSON.parse(rawText);
            } catch (jsonError) {
                // Fallback, falls KI kein valides JSON liefert
                console.log("⚠️ KI hat kein JSON geliefert, nutze Text-Fallback.");
                data = {
                    newTitle: title,
                    scoop: rawText.substring(0, 150) + "...",
                    bullets: ["Konnte keine Details extrahieren."]
                };
            }

            // Validierung
            if (!data.bullets || data.bullets.length === 0) throw new Error("Keine Bullets");

            return { 
                summary: data.scoop, 
                newTitle: data.newTitle, // Die neue sachliche Überschrift
                bullets: data.bullets,   // Die 5 Fakten
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

    // Harter Fallback
    return { summary: title, newTitle: title, bullets: [], tags: [sourceName] };
}

async function run() {
    console.log("🚀 Starte News-Abruf (Smart Brief Edition)...");
    
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
                
                // Cache nutzen, wenn valide UND wenn wir schon Bullets haben (neues Format)
                if (cached && cached.bullets && cached.bullets.length > 0) {
                    newNewsFeed.push({ ...cached, lastUpdated: new Date() });
                    continue; 
                }

                console.log(`🤖 Generiere Smart-Brief: ${item.title.substring(0, 30)}...`);
                
                const rawContent = item.contentSnippet || item.content || "";
                const ai = await analyzeWithPollinations(item.title, rawContent, source.name);
                
                newNewsFeed.push({
                    id: Math.random().toString(36).substr(2, 9),
                    source: source.name,
                    sourceCountry: source.country || "🌍",
                    title: ai.newTitle || item.title, // Wir nutzen den KI-Titel!
                    originalTitle: item.title,        // Backup
                    link: item.link,
                    img: item.enclosure?.url || item.itunes?.image || null,
                    date: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
                    text: ai.summary,
                    bullets: ai.bullets, // Das ist neu!
                    tags: ai.tags
                });
                
                // 12 Sekunden Pause (etwas länger, da Antwort größer ist)
                await sleep(12000); 
            }
        } catch (e) { console.error(`❌ Fehler bei ${source.name}:`, e.message); }
    }

    newNewsFeed.sort((a, b) => new Date(b.date) - new Date(a.date));
    fs.writeFileSync('news.json', JSON.stringify(newNewsFeed, null, 2));
    console.log(`✅ Fertig! ${newNewsFeed.length} Nachrichten gespeichert.`);
}

run();
