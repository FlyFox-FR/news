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
    // Sicherheit: Text kürzen
    const safeContent = (content || "").substring(0, 1000).replace(/<[^>]*>/g, "");

    // Der Prompt muss teil der URL sein
    const instruction = `Du bist News-Redakteur. Fasse diesen Text in einem einzigen deutschen Satz zusammen: "${title} - ${safeContent}"`;
    
    // URL Encoding ist wichtig!
    const url = `https://text.pollinations.ai/${encodeURIComponent(instruction)}?model=openai`;

    try {
        // Einfacher GET Request. Wie eine Webseite öffnen.
        const response = await axios.get(url, { timeout: 10000 });
        
        let summary = response.data; // Der Text kommt direkt zurück
        
        // Aufräumen
        if (typeof summary !== 'string') summary = JSON.stringify(summary);
        summary = summary.trim().replace(/^["']|["']$/g, '');

        if (summary.length < 5) throw new Error("Zu kurz");

        return { 
            summary: summary, 
            context: "", 
            tags: [sourceName, "News"] 
        };

    } catch (error) {
        console.error(`⚠️ Fehler bei "${title.substring(0, 15)}...":`, error.message);
        // Fallback
        return { summary: title, context: "", tags: [sourceName] };
    }
}

async function run() {
    console.log("🚀 Starte News-Abruf (Pollinations No-Key)...");
    
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
                
                // Cache Check
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
                
                // Kurze Pause, um den Server nicht zu ärgern
                await sleep(2000); 
            }
        } catch (e) { console.error(`❌ Fehler ${source.name}:`, e.message); }
    }

    newNewsFeed.sort((a, b) => new Date(b.date) - new Date(a.date));
    fs.writeFileSync('news.json', JSON.stringify(newNewsFeed, null, 2));
    console.log(`✅ Fertig! ${newNewsFeed.length} Nachrichten.`);
}

run();
