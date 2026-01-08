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
    // Fallback: Wenn kein Token da ist, gib einfach den Originaltitel zurück
    if (!HF_TOKEN) return { summary: content, context: "", tags: [] };

    // Prompt: Wir bitten die KI um klare Struktur
    const prompt = `<s>[INST] Du bist ein News-Bot. Fasse zusammen.
    Input: "${title} - ${content}"
    
    Antworte EXAKT in diesem Format (keine Einleitung!):
    ZUSAMMENFASSUNG: [Deutscher Satz]
    KONTEXT: [Warum wichtig?]
    TAGS: [Tag1, Tag2, Tag3]
    [/INST]`;

    try {
        const response = await axios.post(
            `https://api-inference.huggingface.co/models/${AI_MODEL}`,
            { 
                inputs: prompt,
                parameters: { 
                    max_new_tokens: 250, 
                    return_full_text: false,
                    temperature: 0.3 // Weniger kreativ, mehr strikt
                } 
            },
            { headers: { Authorization: `Bearer ${HF_TOKEN}` }, timeout: 20000 }
        );

        let text = response.data[0]?.generated_text || "";
        
        // --- DER FIX: Robusteres Parsing ---
        // Wir suchen alles zwischen den Keywords, auch über mehrere Zeilen (\s\S)
        
        const summaryMatch = text.match(/ZUSAMMENFASSUNG:\s*([\s\S]*?)(?=KONTEXT:|TAGS:|$)/i);
        const contextMatch = text.match(/KONTEXT:\s*([\s\S]*?)(?=TAGS:|$)/i);
        const tagsMatch = text.match(/TAGS:\s*([\s\S]*?)$/i);

        let summary = summaryMatch ? summaryMatch[1].trim() : "";
        let context = contextMatch ? contextMatch[1].trim() : "";
        let tags = tagsMatch ? tagsMatch[1].split(',').map(t => t.trim()) : [];

        // Notfall-Plan: Wenn die KI das Format ignoriert hat, nimm den ganzen Text als Zusammenfassung
        if (!summary && text.length > 5) {
            summary = text.replace(/ZUSAMMENFASSUNG:|KONTEXT:|TAGS:/gi, "").trim();
        }
        // Wenn immer noch leer, nimm den Original-Titel
        if (!summary) summary = title;

        return { summary, context, tags };

    } catch (error) {
        console.log(`⚠️ KI-Fehler:`, error.message);
        // Fallback bei Fehler: Originaltext nehmen
        return { summary: title, context: "", tags: [] };
    }
}

async function run() {
    console.log("🚀 Starte News-Abruf (Fix Version)...");
    
    // Quellen laden oder Default nutzen falls Datei fehlt
    let sources = [];
    try {
        sources = JSON.parse(fs.readFileSync('sources.json', 'utf8'));
    } catch(e) {
        console.log("⚠️ Keine sources.json gefunden, nutze Defaults.");
        sources = [{ name: "Tagesschau", url: "https://www.tagesschau.de/xml/rss2/", count: 3, country: "🇩🇪" }];
    }

    const existingNews = loadExistingNews();
    let newNewsFeed = [];

    for (const source of sources) {
        try {
            console.log(`📡 Lade ${source.name}...`);
            const feed = await parser.parseURL(source.url);
            // Begrenzen auf Anzahl aus Config
            const items = feed.items.slice(0, source.count || 3);

            for (const item of items) {
                // Cache Check: Kennen wir den Link schon?
                const cached = existingNews.find(n => n.link === item.link);
                
                // Wir nutzen den Cache NUR, wenn dort auch wirklich ein Text drin steht (Bugfix für leere News)
                if (cached && cached.text && cached.text.length > 5 && cached.text !== cached.title) {
                    // console.log(`♻️ Cache Treffer: ${item.title.substring(0,20)}...`);
                    newNewsFeed.push({ ...cached, lastUpdated: new Date() });
                    continue;
                }

                // Wenn nicht im Cache oder Cache war fehlerhaft -> Neu generieren
                const contentSnippet = item.contentSnippet || item.content || item.title;
                console.log(`🤖 Generiere neu: ${item.title.substring(0, 30)}...`);
                
                const ai = await analyzeWithAI(item.title, contentSnippet);
                
                newNewsFeed.push({
                    id: Math.random().toString(36).substr(2, 9),
                    source: source.name,
                    sourceCountry: source.country || "🌍",
                    title: item.title,
                    link: item.link,
                    img: item.enclosure?.url || item.itunes?.image || null,
                    date: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
                    text: ai.summary,   // Das Feld für die Zusammenfassung
                    context: ai.context,
                    tags: ai.tags
                });
                
                await sleep(2500); // Etwas längere Pause für die KI
            }
        } catch (e) { console.error(`❌ Fehler ${source.name}:`, e.message); }
    }

    // Sortieren: Neueste oben
    newNewsFeed.sort((a, b) => new Date(b.date) - new Date(a.date));
    
    fs.writeFileSync('news.json', JSON.stringify(newNewsFeed, null, 2));
    console.log(`✅ Fertig! ${newNewsFeed.length} Nachrichten.`);
}

run();
