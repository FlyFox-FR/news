const Parser = require('rss-parser');
const axios = require('axios');
const fs = require('fs');

const parser = new Parser();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Hilfsfunktion: Alte News laden (Caching)
function loadExistingNews() {
    try {
        if (fs.existsSync('news.json')) return JSON.parse(fs.readFileSync('news.json', 'utf8'));
    } catch (e) { }
    return [];
}

// Die KI-Funktion (nutzt Pollinations.ai -> OpenAI im Hintergrund)
async function analyzeWithPollinations(title, content, sourceName) {
    // Input bereinigen und kürzen
    const safeContent = (content || "").substring(0, 1500).replace(/<[^>]*>/g, "");

    // --- DER SMARTE PROMPT ---
    const instruction = `Du bist ein knallharter News-Ticker-Redakteur.
    Analysiere diesen Text: "${title} - ${safeContent}"
    
    Aufgabe: Schreibe EINEN Satz auf Deutsch.
    REGELN:
    1. Sei extrem konkret: Nenne Handlungen, Zahlen oder konkrete Vorwürfe statt abstrakter Begriffe wie "Kommunikation" oder "Vertrauen".
    2. Kein "Politiker-Geschwafel" (wie "unterminieren", "implizieren", "Signale senden").
    3. Sag genau, WER WAS gemacht hat.
    
    Beispiel schlecht: "Die Politik hat das Vertrauen verspielt."
    Beispiel gut: "Kanzler Scholz hat die Steuerpläne gestoppt, weil die FDP drohte, die Koalition zu verlassen."`;
    
    // URL bauen (Pollinations API)
    // Seed sorgt für Abwechslung, model=openai sorgt für Intelligenz
    const url = `https://text.pollinations.ai/${encodeURIComponent(instruction)}?model=openai&seed=${Math.floor(Math.random() * 1000)}`;

    let retries = 3;
    while (retries > 0) {
        try {
            // GET Request an die KI (30s Timeout für langsame Antworten)
            const response = await axios.get(url, { timeout: 30000 });
            
            let summary = response.data;
            
            // Falls Antwort ein Objekt ist, in String wandeln
            if (typeof summary !== 'string') summary = JSON.stringify(summary);
            
            // Aufräumen (Anführungszeichen und Prefixe entfernen)
            summary = summary.trim().replace(/^["']|["']$/g, ''); 
            summary = summary.replace(/^Zusammenfassung:\s*/i, '');

            // Sicherheitscheck: Zu kurz? Dann war es wohl ein Fehler.
            if (summary.length < 10) throw new Error("Antwort zu kurz");

            return { 
                summary: summary, 
                context: "", 
                tags: [sourceName, "News"] 
            };

        } catch (error) {
            const status = error.response?.status;
            
            // FEHLER 429 = RATE LIMIT (Wir waren zu schnell)
            if (status === 429) {
                console.log(`🛑 Zu schnell für Pollinations! Kühle 30 Sekunden ab...`);
                await sleep(30000); // 30 Sekunden warten
                retries--;
                continue; // Nächster Versuch
            }

            console.error(`⚠️ Fehler: ${error.message}. Warte kurz...`);
            await sleep(5000);
            retries--;
        }
    }

    // Fallback: Wenn alles scheitert, nimm den Titel
    return { summary: title, context: "", tags: [sourceName] };
}

async function run() {
    console.log("🚀 Starte News-Abruf (Pollinations Smart & Stable)...");
    
    // Quellen laden
    let sources = [];
    try { sources = JSON.parse(fs.readFileSync('sources.json', 'utf8')); } 
    catch(e) { 
        console.log("⚠️ Keine sources.json, nutze Standard.");
        sources = [{ name: "Tagesschau", url: "https://www.tagesschau.de/xml/rss2/", count: 3, country: "🇩🇪" }]; 
    }

    const existingNews = loadExistingNews();
    let newNewsFeed = [];

    for (const source of sources) {
        try {
            console.log(`\n📡 ${source.name}...`);
            const feed = await parser.parseURL(source.url);
            
            // Wir beschränken uns auf die Anzahl aus der Config
            const items = feed.items.slice(0, source.count);

            for (const item of items) {
                // Check: Haben wir diese News schon?
                const cached = existingNews.find(n => n.link === item.link);
                
                // Cache nutzen, wenn vorhanden und valide (Text ist nicht nur der Titel)
                if (cached && cached.text && cached.text !== cached.title && cached.text.length > 10) {
                    newNewsFeed.push({ ...cached, lastUpdated: new Date() });
                    continue; // Überspringe KI-Generierung
                }

                console.log(`🤖 Generiere: ${item.title.substring(0, 40)}...`);
                
                const rawContent = item.contentSnippet || item.content || "";
                
                // KI Aufruf
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
                
                // WICHTIG: 10 Sekunden Pause zwischen JEDER generierten Nachricht
                // Das verhindert zuverlässig den 429 Fehler (Rate Limit)
                await sleep(10000); 
            }
        } catch (e) { console.error(`❌ Fehler bei ${source.name}:`, e.message); }
    }

    // Sortieren (Neueste zuerst) und Speichern
    newNewsFeed.sort((a, b) => new Date(b.date) - new Date(a.date));
    fs.writeFileSync('news.json', JSON.stringify(newNewsFeed, null, 2));
    console.log(`✅ Fertig! ${newNewsFeed.length} Nachrichten gespeichert.`);
}

run();
