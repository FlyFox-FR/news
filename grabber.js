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
    // Text kürzen
    const safeContent = (content || "").substring(0, 800).replace(/<[^>]*>/g, "");

    const instruction = `Du bist Redakteur. Fasse diesen Text in einem einzigen deutschen Satz zusammen: "${title} - ${safeContent}"`;
    // Seed verhindert Caching-Probleme
    const url = `https://text.pollinations.ai/${encodeURIComponent(instruction)}?model=openai&seed=${Math.floor(Math.random() * 1000)}`;

    let retries = 3;
    while (retries > 0) {
        try {
            // Timeout auf 30 Sekunden erhöht (Pollinations ist manchmal langsam)
            const response = await axios.get(url, { timeout: 30000 });
            
            let summary = response.data;
            if (typeof summary !== 'string') summary = JSON.stringify(summary);
            summary = summary.trim().replace(/^["']|["']$/g, '');

            if (summary.length < 5) throw new Error("Zu kurz");

            return { 
                summary: summary, 
                context: "", 
                tags: [sourceName, "News"] 
            };

        } catch (error) {
            const status = error.response?.status;
            
            // FEHLER 429 = RATE LIMIT (ZU SCHNELL)
            if (status === 429) {
                console.log(`🛑 Zu schnell für Pollinations! Kühle 30 Sekunden ab...`);
                await sleep(30000); // 30 Sekunden warten
                retries--;
                continue; // Neuer Versuch
            }

            console.error(`⚠️ Fehler: ${error.message}. Warte kurz...`);
            await sleep(5000);
            retries--;
        }
    }

    // Fallback
    return { summary: title, context: "", tags: [sourceName] };
}

async function run() {
    console.log("🚀 Starte News-Abruf (Slow Mode für Stabilität)...");
    
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
                
                // Cache nutzen
                if (cached && cached.text && cached.text !== cached.title) {
                    newNewsFeed.push({ ...cached, lastUpdated: new Date() });
                    continue;
                }

                console.log(`🤖 Generiere: ${item.title.substring(0, 30)}...`);
                
                const rawContent = item.contentSnippet || item.content || "";
                const ai = await analyzeWithPollinations(item.title, rawContent, source.name);
                
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
                
                // WICHTIG: 10 Sekunden Pause zwischen JEDER Nachricht
                // Das verhindert den 429 Fehler zuverlässig.
                await sleep(10000); 
            }
        } catch (e) { console.error(`❌ Fehler ${source.name}:`, e.message); }
    }

    newNewsFeed.sort((a, b) => new Date(b.date) - new Date(a.date));
    fs.writeFileSync('news.json', JSON.stringify(newNewsFeed, null, 2));
    console.log(`✅ Fertig! ${newNewsFeed.length} Nachrichten.`);
}

run();
