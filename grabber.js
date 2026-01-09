const Parser = require('rss-parser');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require('fs');

const parser = new Parser();

// Konfiguration
const API_KEY = process.env.GEMINI_API_KEY;

// Wir versuchen Flash (schnell), Fallback ist Pro (stabil)
const MODEL_NAME = "gemini-1.5-flash"; 

const genAI = new GoogleGenerativeAI(API_KEY);
const model = genAI.getGenerativeModel({ model: MODEL_NAME });

const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadExistingNews() {
    try {
        if (fs.existsSync('news.json')) return JSON.parse(fs.readFileSync('news.json', 'utf8'));
    } catch (e) { }
    return [];
}

async function analyzeWithGemini(title, content, sourceName) {
    if (!API_KEY) {
        console.error("❌ Kein GEMINI_API_KEY gefunden!");
        return { summary: title, context: "", tags: [] };
    }

    const safeContent = (content || "").substring(0, 2000).replace(/<[^>]*>/g, "");

    const prompt = `Du bist ein professioneller Nachrichten-Redakteur.
    Aufgabe: Fasse den folgenden Artikel in einem einzigen, prägnanten deutschen Satz zusammen.
    
    Titel: ${title}
    Inhalt: ${safeContent}
    
    Antworte NUR mit der Zusammenfassung. Keine Einleitung, keine Formatierung.`;

    try {
        const result = await model.generateContent(prompt);
        const response = await result.response;
        let summary = response.text();
        
        summary = summary.trim().replace(/\*\*/g, '').replace(/^["']|["']$/g, '');

        if (!summary || summary.length < 5) throw new Error("Leere Antwort");

        return { 
            summary: summary, 
            context: "", 
            tags: [sourceName, "News"] 
        };

    } catch (error) {
        // Falls Flash nicht will, versuchen wir es nicht nochmal, sondern nehmen den Titel
        // Das spart Zeit und Nerven.
        console.error(`⚠️ Fehler:`, error.message);
        return { summary: title, context: "", tags: [sourceName] };
    }
}

async function run() {
    console.log("🚀 Starte News-Abruf (Gemini Final)...");
    
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
                
                if (cached && cached.text && cached.text !== cached.title) {
                    newNewsFeed.push({ ...cached, lastUpdated: new Date() });
                    continue;
                }

                console.log(`🤖 Gemini analysiert: ${item.title.substring(0, 30)}...`);
                
                const rawContent = item.contentSnippet || item.content || "";
                const ai = await analyzeWithGemini(item.title, rawContent, source.name);
                
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
                
                await sleep(1000); 
            }
        } catch (e) { console.error(`❌ Fehler ${source.name}:`, e.message); }
    }

    newNewsFeed.sort((a, b) => new Date(b.date) - new Date(a.date));
    fs.writeFileSync('news.json', JSON.stringify(newNewsFeed, null, 2));
    console.log(`✅ Fertig! ${newNewsFeed.length} Nachrichten.`);
}

run();
