const Parser = require('rss-parser');
const axios = require('axios');
const fs = require('fs');

const parser = new Parser();

// Konfiguration
const AI_MODEL = "mistralai/Mistral-7B-Instruct-v0.3"; 
const HF_TOKEN = process.env.HF_TOKEN; 

const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadExistingNews() {
    try {
        if (fs.existsSync('news.json')) return JSON.parse(fs.readFileSync('news.json', 'utf8'));
    } catch (e) { }
    return [];
}

async function analyzeWithAI(title, content) {
    if (!HF_TOKEN) return { summary: title, context: "", tags: [] };

    console.log(`🤖 Frage KI zu: ${title.substring(0, 20)}...`);

    // Neuer Prompt: Wir nutzen ### als Trenner. Das ist für die KI einfacher.
    const prompt = `<s>[INST] Du bist ein Nachrichten-Redakteur.
    Analysiere diesen Text: "${title} - ${content}"
    
    Antworte auf DEUTSCH und nutze GENAU dieses Format mit ### Trennern:
    
    ZUSAMMENFASSUNG (1 Satz)
    ###
    WARUM ES WICHTIG IST (1 kurzer Satz)
    ###
    TAG1, TAG2, TAG3
    [/INST]`;

    try {
        const response = await axios.post(
            `https://api-inference.huggingface.co/models/${AI_MODEL}`,
            { 
                inputs: prompt,
                parameters: { 
                    max_new_tokens: 200, 
                    return_full_text: false,
                    temperature: 0.1 // 0.1 macht die KI sehr "gehorsam" und weniger kreativ
                } 
            },
            { headers: { Authorization: `Bearer ${HF_TOKEN}` }, timeout: 30000 }
        );

        let text = response.data[0]?.generated_text || "";
        // console.log("DEBUG RAW KI ANTWORT:", text); // Zum Debuggen in GitHub Logs

        // Simples Splitten am Trenner ###
        const parts = text.split('###');

        // Wir säubern die Teile von Zeilenumbrüchen und Leerzeichen
        let summary = parts[0] ? parts[0].replace(/ZUSAMMENFASSUNG/i, "").trim() : title;
        let context = parts[1] ? parts[1].replace(/WARUM ES WICHTIG IST/i, "").trim() : "";
        let tagsRaw = parts[2] ? parts[2].trim() : "";
        
        // Tags säubern
        let tags = tagsRaw.split(',').map(t => t.replace(/TAGS|TAG/i, "").trim()).filter(t => t.length > 2);

        // Fallback, falls Format komplett kaputt
        if (summary.length < 5) summary = title;

        return { summary, context, tags };

    } catch (error) {
        console.log(`⚠️ KI-Fehler:`, error.message);
        return { summary: title, context: "", tags: [] };
    }
}

async function run() {
    console.log("🚀 Starte News-Abruf 3.0 (Robust)...");
    
    let sources = [];
    try { sources = JSON.parse(fs.readFileSync('sources.json', 'utf8')); } 
    catch(e) { sources = [{ name: "Tagesschau", url: "https://www.tagesschau.de/xml/rss2/", count: 3, country: "🇩🇪" }]; }

    const existingNews = loadExistingNews();
    let newNewsFeed = [];

    for (const source of sources) {
        try {
            console.log(`📡 Lade ${source.name}...`);
            const feed = await parser.parseURL(source.url);
            const items = feed.items.slice(0, source.count);

            for (const item of items) {
                // Cache Check
                const cached = existingNews.find(n => n.link === item.link);
                
                // Wir nutzen den Cache nur, wenn die Zusammenfassung NICHT identisch mit dem Titel ist (das war der Fehler vorher)
                if (cached && cached.text && cached.text !== cached.title && cached.context) {
                    newNewsFeed.push({ ...cached, lastUpdated: new Date() });
                    continue; // Nächste News
                }

                // Generiere neu
                const snippet = item.contentSnippet || item.content || "";
                const ai = await analyzeWithAI(item.title, snippet);
                
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
                
                await sleep(3000); // 3 Sekunden Pause
            }
        } catch (e) { console.error(`❌ Fehler ${source.name}:`, e.message); }
    }

    newNewsFeed.sort((a, b) => new Date(b.date) - new Date(a.date));
    fs.writeFileSync('news.json', JSON.stringify(newNewsFeed, null, 2));
    console.log(`✅ Fertig! ${newNewsFeed.length} Nachrichten.`);
}

run();
