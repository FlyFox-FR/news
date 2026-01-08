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
    if (!HF_TOKEN) return { summary: content, context: "", tags: [] };

    // Strikerer Prompt für saubere Tags
    const prompt = `<s>[INST] Analysiere diese Nachricht. Antworte strikt im Format. Sprache: IMMER DEUTSCH.
    
    Input: "${title} - ${content}"

    Format:
    ZUSAMMENFASSUNG: [Max 20 Wörter, neutral]
    KONTEXT: [Warum ist das relevant? Max 1 Satz]
    TAGS: [Max 3 Schlagworte, kommasepariert, keine Rauten]

    Antwort: [/INST]`;

    try {
        const response = await axios.post(
            `https://api-inference.huggingface.co/models/${AI_MODEL}`,
            { inputs: prompt, parameters: { max_new_tokens: 200, return_full_text: false } },
            { headers: { Authorization: `Bearer ${HF_TOKEN}` }, timeout: 20000 }
        );

        const text = response.data[0]?.generated_text || "";
        
        // Robustes Parsing
        const summary = text.match(/ZUSAMMENFASSUNG:\s*(.+)/i)?.[1] || title;
        const context = text.match(/KONTEXT:\s*(.+)/i)?.[1] || "";
        const tags = text.match(/TAGS:\s*(.+)/i)?.[1]?.split(',').map(t => t.trim()) || [];

        return { summary, context, tags };

    } catch (error) {
        console.log(`⚠️ KI-Fehler:`, error.message);
        return { summary: title, context: "", tags: [] };
    }
}

async function run() {
    console.log("🚀 Starte Premium News-Abruf...");
    const sources = JSON.parse(fs.readFileSync('sources.json', 'utf8'));
    const existingNews = loadExistingNews();
    let newNewsFeed = [];

    for (const source of sources) {
        try {
            console.log(`📡 ${source.name} (${source.country})...`);
            const feed = await parser.parseURL(source.url);
            const items = feed.items.slice(0, source.count);

            for (const item of items) {
                // Cache Check
                const cached = existingNews.find(n => n.link === item.link);
                if (cached) {
                    newNewsFeed.push({ ...cached, lastUpdated: new Date() });
                    continue;
                }

                // AI Analysis
                const ai = await analyzeWithAI(item.title, item.contentSnippet || item.title);
                
                newNewsFeed.push({
                    id: Math.random().toString(36).substr(2, 9),
                    source: source.name,
                    sourceCountry: source.country, // Neu: Flagge durchreichen
                    title: item.title,
                    link: item.link,
                    img: item.enclosure?.url || item.itunes?.image || null,
                    date: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
                    text: ai.summary,
                    context: ai.context,
                    tags: ai.tags
                });
                await sleep(2000);
            }
        } catch (e) { console.error(`❌ Fehler ${source.name}:`, e.message); }
    }

    newNewsFeed.sort((a, b) => new Date(b.date) - new Date(a.date));
    fs.writeFileSync('news.json', JSON.stringify(newNewsFeed, null, 2));
    console.log("✅ Fertig.");
}

run();
