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

// Die neue, ultra-robuste KI-Funktion mit Retry-Logik
async function analyzeWithAI(title, content) {
    // 1. Check: Token da?
    if (!HF_TOKEN) {
        console.log("⚠️ Kein HF_TOKEN gefunden! Nutze Fallback.");
        return { summary: title, context: "", tags: [] };
    }

    const prompt = `<s>[INST] Du bist ein News-Redakteur. Analysiere diesen Text: "${title} - ${content}"
    
    Antworte auf DEUTSCH. Nutze EXAKT dieses Format mit ### als Trenner:
    
    ZUSAMMENFASSUNG (Max 1 Satz, neutral)
    ###
    WARUM ES WICHTIG IST (Max 1 kurzer Satz)
    ###
    TAG1, TAG2, TAG3 (Keine Rauten, nur Kommas)
    [/INST]`;

    // 2. Die Hartnäckigkeits-Schleife (Max 5 Versuche)
    let retries = 5;
    
    while (retries > 0) {
        try {
            const response = await axios.post(
                `https://api-inference.huggingface.co/models/${AI_MODEL}`,
                { 
                    inputs: prompt,
                    parameters: { 
                        max_new_tokens: 250, 
                        return_full_text: false,
                        temperature: 0.1 
                    } 
                },
                { 
                    headers: { Authorization: `Bearer ${HF_TOKEN}` },
                    timeout: 90000 // 90 Sekunden Timeout (Wichtig für Kaltstarts!)
                }
            );

            // Wenn wir hier sind, hat die API geantwortet! 🎉
            const text = response.data[0]?.generated_text || "";
            // console.log(`🔍 Raw KI-Antwort für "${title.substring(0,10)}...":`, text); 

            // Parsen
            const parts = text.split('###');
            let summary = parts[0] ? parts[0].replace(/ZUSAMMENFASSUNG/i, "").trim() : title;
            let context = parts[1] ? parts[1].replace(/WARUM ES WICHTIG IST/i, "").trim() : "";
            let tagsRaw = parts[2] ? parts[2].trim() : "";
            let tags = tagsRaw.split(',').map(t => t.replace(/TAGS|TAG/i, "").trim()).filter(t => t.length > 2);

            // Sicherheits-Check: Hat die KI nur Müll zurückgegeben?
            if (summary.length < 5) summary = title;

            return { summary, context, tags };

        } catch (error) {
            // FEHLER-ANALYSE
            const errData = error.response?.data;
            const status = error.response?.status;

            // Fall 1: Modell schläft noch (503 Error)
            if (errData && JSON.stringify(errData).includes("loading")) {
                const waitTime = errData.estimated_time || 20;
                console.log(`⏳ Modell lädt noch... Warte ${waitTime.toFixed(1)}s (Versuch ${6 - retries}/5)`);
                await sleep(waitTime * 1000);
                retries--;
                continue; // Nächster Schleifen-Durchlauf
            }

            // Fall 2: Rate Limit (Zu viele Anfragen)
            if (status === 429) {
                console.log(`🛑 Rate Limit! Warte 60s...`);
                await sleep(60000);
                retries--;
                continue;
            }

            // Fall 3: Echter Fehler (z.B. falscher Token)
            console.error(`💥 Fataler API-Fehler bei "${title.substring(0, 15)}...":`);
            console.error(`   Status: ${status}`);
            console.error(`   Details:`, JSON.stringify(errData));
            console.error(`   Message:`, error.message);
            
            // Bei fatalen Fehlern brechen wir diesen Artikel ab
            break; 
        }
    }

    // Wenn alle Retries aufgebraucht sind:
    console.log(`⚠️ Gebe auf für: "${title.substring(0, 20)}..." -> Nutze Originaltext.`);
    return { summary: title, context: "", tags: [] };
}

async function run() {
    console.log("🚀 Starte News-Abruf (Debug Mode)...");
    
    let sources = [];
    try { sources = JSON.parse(fs.readFileSync('sources.json', 'utf8')); } 
    catch(e) { 
        console.log("⚠️ Keine sources.json gefunden, nutze Defaults.");
        sources = [{ name: "Tagesschau", url: "https://www.tagesschau.de/xml/rss2/", count: 3, country: "🇩🇪" }]; 
    }

    const existingNews = loadExistingNews();
    let newNewsFeed = [];

    for (const source of sources) {
        try {
            console.log(`\n📡 Quelle: ${source.name}`);
            const feed = await parser.parseURL(source.url);
            const items = feed.items.slice(0, source.count);

            for (const item of items) {
                // Cache Check
                const cached = existingNews.find(n => n.link === item.link);
                
                // Strenger Cache Check: Nur nutzen, wenn Kontext da ist UND Text != Titel
                if (cached && cached.text && cached.text !== cached.title && cached.context) {
                    newNewsFeed.push({ ...cached, lastUpdated: new Date() });
                    continue;
                }

                // Generierung
                console.log(`🤖 Bearbeite: ${item.title.substring(0, 40)}...`);
                const contentSnippet = item.contentSnippet || item.content || "";
                
                const ai = await analyzeWithAI(item.title, contentSnippet);
                
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
                
                // Wichtig: Kurze Pause zwischen Artikeln, um Rate-Limits zu schonen
                await sleep(2000); 
            }
        } catch (e) { console.error(`❌ Fehler bei ${source.name}:`, e.message); }
    }

    newNewsFeed.sort((a, b) => new Date(b.date) - new Date(a.date));
    fs.writeFileSync('news.json', JSON.stringify(newNewsFeed, null, 2));
    console.log(`✅ Fertig! ${newNewsFeed.length} Nachrichten gespeichert.`);
}

run();
