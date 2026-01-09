const Parser = require('rss-parser');
const axios = require('axios');
const fs = require('fs');

const parser = new Parser();

// API CONFIG
const API_KEY = process.env.GEMINI_API_KEY;
// Wir nutzen die REST API direkt URL. Das funktioniert ohne Bibliothek.
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${API_KEY}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadExistingNews() {
    try {
        if (fs.existsSync('news.json')) return JSON.parse(fs.readFileSync('news.json', 'utf8'));
    } catch (e) { }
    return [];
}

async function analyzeWithGeminiRaw(title, content, sourceName) {
    if (!API_KEY) {
        console.error("❌ Kein GEMINI_API_KEY (Env Var fehlt)");
        return { summary: title, context: "", tags: [sourceName] };
    }

    const safeContent = (content || "").substring(0, 2000).replace(/<[^>]*>/g, "");

    // JSON Body für die Google API
    const requestBody = {
        contents: [{
            parts: [{
                text: `Du bist ein Nachrichten-Redakteur. Fasse diesen Text in einem einzigen deutschen Satz zusammen.
                Titel: ${title}
                Inhalt: ${safeContent}
                Antworte NUR mit der Zusammenfassung.`
            }]
        }]
    };

    try {
        // Direkter POST Request ohne SDK
        const response = await axios.post(API_URL, requestBody, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000
        });

        // Antwort manuell auspacken
        let summary = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        
        if (!summary) throw new Error("Keine Antwort im JSON");

        summary = summary.trim().replace(/\*\*/g, '').replace(/^["']|["']$/g, '');

        return { 
            summary: summary, 
            context: "", 
            tags: [sourceName, "News"] 
        };

    } catch (error) {
        // Detaillierte Fehleranalyse für den direkten Request
        const status = error.response?.status;
        const msg = error.response?.data?.error?.message || error.message;
        console.error(`⚠️ API Fehler (${status}) bei "${title.substring(0, 10)}...": ${msg}`);
        
        return { summary: title, context: "", tags: [sourceName] };
    }
}

async function run() {
    console.log("🚀 Starte News-Abruf (Direct RAW API)...");
    
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
                const cached = existingNews.find(n => n.link === item.link);
                
                // Cache Logik
                if (cached && cached.text && cached.text !== cached.title) {
                    newNewsFeed.push({ ...cached, lastUpdated: new Date() });
                    continue;
                }

                console.log(`🤖 Generiere: ${item.title.substring(0, 30)}...`);
                
                const rawContent = item.contentSnippet || item.content || "";
                const ai = await analyzeWithGeminiRaw(item.title, rawContent, source.name);
                
                newNewsFeed.push({
                    id: Math.random().toString(36).substr(2, 9),
                    source: source.name,
                    sourceCountry: source.country || "🌍",
                    title: item.title,
                    link: item.link,
                    img: item.enclosure?.url || item.itunes?.image || null,
                    date: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
                    text: ai.summary,
                    context: ai.context,
                    tags: ai.tags
                });
                
                await sleep(1000); // 1 Sekunde Pause reicht bei Google
            }
        } catch (e) { console.error(`❌ Fehler ${source.name}:`, e.message); }
    }

    newNewsFeed.sort((a, b) => new Date(b.date) - new Date(a.date));
    fs.writeFileSync('news.json', JSON.stringify(newNewsFeed, null, 2));
    console.log(`✅ Fertig! ${newNewsFeed.length} Nachrichten.`);
}

run();
