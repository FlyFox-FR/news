const Parser = require('rss-parser');
const axios = require('axios');
const fs = require('fs');

const parser = new Parser();

// Wir gehen zurück zum Original-Modell aus Version 1
const AI_MODEL = "mistralai/Mistral-7B-Instruct-v0.3"; 
const HF_TOKEN = process.env.HF_TOKEN; 

const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadExistingNews() {
    try {
        if (fs.existsSync('news.json')) return JSON.parse(fs.readFileSync('news.json', 'utf8'));
    } catch (e) { }
    return [];
}

async function analyzeWithAI(title, content, sourceName) {
    if (!HF_TOKEN) return { summary: title, context: "", tags: [] };

    // Input kürzen (Sicherheit)
    const safeContent = (content || "").substring(0, 800).replace(/<[^>]*>/g, "");

    // --- DER ORIGINAL PROMPT (leicht angepasst für Stabilität) ---
    // Keine komplizierten Formate. Einfach nur Text.
    const prompt = `<s>[INST] Du bist ein Nachrichten-Redakteur. Fasse die folgende Nachricht in einem einzigen, kurzen deutschen Satz zusammen. Antworte NUR mit der Zusammenfassung.
    
    Titel: ${title}
    Inhalt: ${safeContent}
    
    Zusammenfassung: [/INST]`;

    let retries = 4;
    while (retries > 0) {
        try {
            const response = await axios.post(
                `https://api-inference.huggingface.co/models/${AI_MODEL}`,
                { 
                    inputs: prompt,
                    parameters: { 
                        max_new_tokens: 150, // Genug für einen Satz
                        return_full_text: false 
                    } 
                },
                { 
                    headers: { Authorization: `Bearer ${HF_TOKEN}` },
                    timeout: 30000 
                }
            );

            let summary = response.data[0]?.generated_text || "";
            summary = summary.trim().replace(/^["']|["']$/g, ''); // Anführungszeichen wegputzen

            // Wenn Antwort leer ist, war es ein Fehler
            if (summary.length < 5) throw new Error("Leere Antwort");

            // ERFOLG!
            // Wir geben Tags manuell zurück, damit die UI nicht leer aussieht
            return { 
                summary: summary, 
                context: "", // Lassen wir leer, wie in Version 1
                tags: ["News", sourceName] // Automatische Tags
            };

        } catch (error) {
            const errData = error.response?.data;
            
            // Wenn Model lädt -> Warten (Das müssen wir behalten, sonst stürzt es ab)
            if (errData && JSON.stringify(errData).includes("loading")) {
                const wait = (errData.estimated_time || 20);
                console.log(`⏳ KI lädt (${wait}s)...`);
                await sleep((wait + 2) * 1000);
                retries--;
                continue;
            }
            
            // Bei anderen Fehlern: Kurz warten, nochmal probieren
            console.log(`⚠️ Fehler: ${error.message}. Versuche noch ${retries} mal...`);
            await sleep(5000);
            retries--;
        }
    }

    // Fallback wenn alles scheitert
    return { summary: title, context: "", tags: [] };
}

async function run() {
    console.log("🚀 Starte News-Abruf (Classic Mode)...");
    
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
                // Cache Check
                const cached = existingNews.find(n => n.link === item.link);
                
                // Wir nutzen den Cache, wenn der Text existiert und NICHT gleich dem Titel ist (also erfolgreich war)
                if (cached && cached.text && cached.text !== cached.title) {
                    newNewsFeed.push({ ...cached, lastUpdated: new Date() });
                    continue;
                }

                console.log(`🤖 Generiere: ${item.title.substring(0, 30)}...`);
                
                const rawContent = item.contentSnippet || item.content || "";
                
                // Wir übergeben source.name für die automatischen Tags
                const ai = await analyzeWithAI(item.title, rawContent, source.name);
                
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
                
                await sleep(2000); 
            }
        } catch (e) { console.error(`❌ Fehler ${source.name}:`, e.message); }
    }

    newNewsFeed.sort((a, b) => new Date(b.date) - new Date(a.date));
    fs.writeFileSync('news.json', JSON.stringify(newNewsFeed, null, 2));
    console.log(`✅ Fertig! ${newNewsFeed.length} Nachrichten.`);
}

run();
