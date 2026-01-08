const Parser = require('rss-parser');
const axios = require('axios');
const fs = require('fs');

const parser = new Parser();

// ÄNDERUNG: Anderes Modell. Zephyr ist zuverlässiger bei Formatierung als Mistral.
const AI_MODEL = "HuggingFaceH4/zephyr-7b-beta"; 
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

    // FIX 1: Input gnadenlos kürzen! 
    // Wenn der RSS Feed 5000 Wörter liefert, stürzt die Free-API ab. Wir nehmen nur die ersten 1000 Zeichen.
    const safeContent = (content || "").substring(0, 1000).replace(/<[^>]*>/g, ""); // HTML Tags entfernen

    const prompt = `<|system|>
Du bist ein Nachrichten-Redakteur. Antworte strikt auf DEUTSCH.
Formatiere deine Antwort EXAKT so:
ZUSAMMENFASSUNG: [Ein Satz]
KONTEXT: [Ein Satz warum wichtig]
TAGS: [Tag1, Tag2]
</s>
<|user|>
Analysiere: "${title} - ${safeContent}"
</s>
<|assistant|>`;

    let retries = 4;
    while (retries > 0) {
        try {
            const response = await axios.post(
                `https://api-inference.huggingface.co/models/${AI_MODEL}`,
                { 
                    inputs: prompt,
                    parameters: { 
                        max_new_tokens: 200, 
                        return_full_text: false, // WICHTIG: Damit der Prompt nicht wiederholt wird
                        temperature: 0.1 
                    } 
                },
                { 
                    headers: { Authorization: `Bearer ${HF_TOKEN}` },
                    timeout: 45000 
                }
            );

            const text = response.data[0]?.generated_text || "";
            // console.log(`🔍 Raw Output:`, text); // Debugging

            // FIX 2: Robusteres Parsing mit Regex (Statt .split)
            // Sucht nach "ZUSAMMENFASSUNG:" gefolgt von Text bis "KONTEXT:" kommt.
            const summaryMatch = text.match(/ZUSAMMENFASSUNG:?\s*([\s\S]*?)(?=KONTEXT:|$)/i);
            const contextMatch = text.match(/KONTEXT:?\s*([\s\S]*?)(?=TAGS:|$)/i);
            const tagsMatch = text.match(/TAGS:?\s*([\s\S]*?)$/i);

            let summary = summaryMatch ? summaryMatch[1].trim() : "";
            let context = contextMatch ? contextMatch[1].trim() : "";
            let tags = tagsMatch ? tagsMatch[1].split(',').map(t => t.trim()) : [];

            // Notfall-Reinigung, falls die KI Anführungszeichen nutzt
            summary = summary.replace(/^["']|["']$/g, '');
            context = context.replace(/^["']|["']$/g, '');

            // Wenn immer noch leer, war die Antwort Schrott -> Retry oder Fallback
            if (summary.length < 5) {
                // Versuchen wir, den ganzen Text zu nehmen, falls er kurz ist
                if (text.length > 5 && text.length < 200) summary = text; 
                else summary = title;
            }

            return { summary, context, tags };

        } catch (error) {
            const errData = error.response?.data;
            
            // Model loading -> Warten
            if (errData && JSON.stringify(errData).includes("loading")) {
                const wait = (errData.estimated_time || 20) + 5; // +5s Puffer
                console.log(`⏳ KI lädt (${wait}s)...`);
                await sleep(wait * 1000);
                retries--;
                continue;
            }
            
            // Anderer Fehler -> Loggen und abbrechen
            console.log(`⚠️ API Fehler: ${error.message}`);
            break;
        }
    }

    return { summary: title, context: "", tags: [] };
}

async function run() {
    console.log("🚀 Starte Fix-Run...");
    
    // Quellen laden
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
                // Cache-Logik: Wir nutzen den Cache NUR, wenn er valide Daten hat (Kontext existiert)
                const cached = existingNews.find(n => n.link === item.link);
                
                // CHECK: Ist der Cache "gesund"? (Hat er Kontext? Ist der Text ungleich dem Titel?)
                const isCacheHealthy = cached && cached.text && cached.text !== cached.title && cached.context && cached.context.length > 2;

                if (isCacheHealthy) {
                    newNewsFeed.push({ ...cached, lastUpdated: new Date() });
                    // console.log(`✅ Aus Cache: ${item.title.substring(0,20)}...`);
                    continue;
                }

                console.log(`🤖 Generiere neu: ${item.title.substring(0, 30)}...`);
                
                // Hier übergeben wir den ContentSnippet UND Content, damit wir sicher Text haben
                const rawContent = item.contentSnippet || item.content || "";
                const ai = await analyzeWithAI(item.title, rawContent);
                
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
