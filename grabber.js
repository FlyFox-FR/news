const Parser = require('rss-parser');
const axios = require('axios');
const fs = require('fs');

const parser = new Parser();

// FIX: Wir wechseln auf Zephyr. Mistral v0.3 verursacht Error 410 (Gone).
const AI_MODEL = "HuggingFaceH4/zephyr-7b-beta"; 
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

    // Text kürzen, um API-Fehler zu vermeiden
    const safeContent = (content || "").substring(0, 800).replace(/<[^>]*>/g, "");

    // Simpler Prompt, da Zephyr sehr gut Anweisungen folgt
    const prompt = `<|system|>
Du bist ein Nachrichten-Redakteur. Fasse die Nachricht in einem einzigen deutschen Satz zusammen.
</s>
<|user|>
Titel: ${title}
Inhalt: ${safeContent}
</s>
<|assistant|>`;

    let retries = 3;
    while (retries > 0) {
        try {
            const response = await axios.post(
                `https://api-inference.huggingface.co/models/${AI_MODEL}`,
                { 
                    inputs: prompt,
                    parameters: { 
                        max_new_tokens: 150, 
                        return_full_text: false 
                    } 
                },
                { 
                    headers: { Authorization: `Bearer ${HF_TOKEN}` },
                    timeout: 40000 
                }
            );

            let summary = response.data[0]?.generated_text || "";
            summary = summary.trim().replace(/^["']|["']$/g, ''); // Anführungszeichen entfernen

            if (summary.length < 5) throw new Error("Leere Antwort");

            return { 
                summary: summary, 
                context: "", 
                tags: [sourceName, "News"] 
            };

        } catch (error) {
            const errData = error.response?.data;
            const status = error.response?.status;

            // 410 oder 404 bedeutet: Modell existiert nicht mehr. Abbruch.
            if (status === 410 || status === 404) {
                console.error("🚨 KRITISCH: Modell nicht gefunden (410). Bitte Modell in grabber.js ändern!");
                break;
            }

            // Loading Fehler -> Warten
            if (errData && JSON.stringify(errData).includes("loading")) {
                const wait = (errData.estimated_time || 20);
                console.log(`⏳ Modell lädt (${wait}s)...`);
                await sleep((wait + 2) * 1000);
                retries--;
                continue;
            }
            
            console.log(`⚠️ API Fehler (${status}): ${error.message}. Retry...`);
            await sleep(3000);
            retries--;
        }
    }

    // Fallback
    return { summary: title, context: "", tags: [sourceName] };
}

async function run() {
    console.log("🚀 Starte News-Abruf (Zephyr Fix)...");
    
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
                
                // Cache nutzen, wenn Text existiert und kein Fallback-Titel ist
                if (cached && cached.text && cached.text !== cached.title) {
                    newNewsFeed.push({ ...cached, lastUpdated: new Date() });
                    continue;
                }

                console.log(`🤖 Generiere: ${item.title.substring(0, 30)}...`);
                
                const rawContent = item.contentSnippet || item.content || "";
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
