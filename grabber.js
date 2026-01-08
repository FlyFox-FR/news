const Parser = require('rss-parser');
const axios = require('axios');
const fs = require('fs');

const parser = new Parser();

// Konfiguration
const AI_MODEL = "mistralai/Mistral-7B-Instruct-v0.3"; 
const HF_TOKEN = process.env.HF_TOKEN; 

// Hilfsfunktion: Pause
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Hilfsfunktion: Alte News laden (Caching)
function loadExistingNews() {
    try {
        if (fs.existsSync('news.json')) {
            return JSON.parse(fs.readFileSync('news.json', 'utf8'));
        }
    } catch (e) { console.error("Keine alten News gefunden."); }
    return [];
}

// Funktion: KI-Analyse (Zusammenfassung + Kontext + Tags + Übersetzung)
async function analyzeWithAI(title, content, sourceName) {
    if (!HF_TOKEN) return { summary: content, context: "Kein Token", tags: [] };

    console.log(`🤖 Frage KI zu: "${title.substring(0, 30)}..." (${sourceName})`);

    // Prompt: Wir zwingen die KI in ein striktes Format
    const prompt = `<s>[INST] Du bist ein Nachrichten-Assistent. Analysiere den folgenden Text (egal welche Sprache) und antworte IMMER auf DEUTSCH.
    
    Aufgabe:
    1. SUMMARY: Eine Zusammenfassung in einem Satz.
    2. CONTEXT: Ein kurzer Satz, warum diese Nachricht wichtig ist (Hintergrund).
    3. TAGS: Max 3 Schlagworte (z.B. Politik, Tech, USA), mit Komma getrennt.

    Format der Antwort (halte dich strikt daran):
    SUMMARY: [Dein Text]
    CONTEXT: [Dein Text]
    TAGS: [Tag1, Tag2, Tag3]

    Titel: ${title}
    Inhalt: ${content}
    [/INST]`;

    try {
        const response = await axios.post(
            `https://api-inference.huggingface.co/models/${AI_MODEL}`,
            { 
                inputs: prompt,
                parameters: { max_new_tokens: 250, return_full_text: false }
            },
            { headers: { Authorization: `Bearer ${HF_TOKEN}` }, timeout: 20000 }
        );

        const rawText = response.data[0]?.generated_text || "";
        
        // Parsing der Antwort mit Regex
        const summaryMatch = rawText.match(/SUMMARY:\s*(.+)/);
        const contextMatch = rawText.match(/CONTEXT:\s*(.+)/);
        const tagsMatch = rawText.match(/TAGS:\s*(.+)/);

        return {
            summary: summaryMatch ? summaryMatch[1].trim() : "Konnte nicht zusammengefasst werden.",
            context: contextMatch ? contextMatch[1].trim() : "Kein Kontext verfügbar.",
            tags: tagsMatch ? tagsMatch[1].split(',').map(t => t.trim()) : []
        };

    } catch (error) {
        console.log(`⚠️ KI-Fehler:`, error.message);
        return { summary: content.substring(0, 100) + "...", context: "", tags: [] };
    }
}

async function run() {
    console.log("🚀 Starte News-Abruf 2.0...");
    
    // 1. Quellen laden
    const sources = JSON.parse(fs.readFileSync('sources.json', 'utf8'));
    
    // 2. Cache laden (Alte News)
    const existingNews = loadExistingNews();
    
    let newNewsFeed = [];

    for (const source of sources) {
        try {
            console.log(`\n📡 Lade Quelle: ${source.name}...`);
            const feed = await parser.parseURL(source.url);
            const items = feed.items.slice(0, source.count);

            for (const item of items) {
                // CACHE CHECK: Haben wir den Link schon?
                const cachedItem = existingNews.find(n => n.link === item.link);
                
                if (cachedItem) {
                    console.log(`♻️ Aus Cache geladen: ${item.title.substring(0, 20)}...`);
                    // Aktualisiere nur das Datum, behalte KI-Daten
                    newNewsFeed.push({ ...cachedItem, lastUpdated: new Date() });
                } else {
                    // NEU: KI fragen
                    const contentText = item.contentSnippet || item.content || item.title;
                    const aiResult = await analyzeWithAI(item.title, contentText, source.name);
                    
                    newNewsFeed.push({
                        id: Math.random().toString(36).substr(2, 9), // ID für Bookmarks
                        source: source.name,
                        title: item.title,
                        link: item.link,
                        img: item.enclosure?.url || item.itunes?.image || null,
                        date: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
                        // KI Daten:
                        text: aiResult.summary,
                        context: aiResult.context,
                        tags: aiResult.tags
                    });
                    
                    await sleep(2000); // Rate Limit Schutz
                }
            }
        } catch (e) {
            console.error(`❌ Fehler bei ${source.name}:`, e.message);
        }
    }

    // Sortieren nach Datum (Neueste zuerst)
    newNewsFeed.sort((a, b) => new Date(b.date) - new Date(a.date));

    // Speichern
    fs.writeFileSync('news.json', JSON.stringify(newNewsFeed, null, 2));
    console.log(`✅ Fertig! ${newNewsFeed.length} Nachrichten gespeichert.`);
}

run();
