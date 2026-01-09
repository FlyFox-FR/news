const Parser = require('rss-parser');
const axios = require('axios');
const fs = require('fs');

const parser = new Parser();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- ÄHNLICHKEITS-CHECK (Verbessert & Lockerer) ---
function isSimilar(title1, title2) {
    if (!title1 || !title2) return false;

    // Füllwörter, die wir ignorieren (Rauschen)
    const stopWords = ["und", "der", "die", "das", "mit", "von", "für", "auf", "den", "im", "in", "ist", "hat", "zu", "eine", "ein", "bei", "nach"];

    const clean = t => t.toLowerCase()
        .replace(/[^\w\säöüß]/g, ' ') // Sonderzeichen zu Leerzeichen
        .split(/\s+/)
        .filter(w => w.length > 2) // Nur Wörter > 2 Zeichen
        .filter(w => !stopWords.includes(w)); // Keine Füllwörter

    const words1 = clean(title1);
    const words2 = clean(title2);

    // Zählen der Treffer
    let matches = 0;
    words1.forEach(w1 => {
        if (words2.includes(w1)) matches++;
    });
    
    // Wir prüfen auch Teilwörter (z.B. "Wintersturm" matcht "Sturm")
    words1.forEach(w1 => {
        words2.forEach(w2 => {
            if (w1 !== w2 && (w1.includes(w2) || w2.includes(w1)) && w1.length > 4 && w2.length > 4) {
                matches++;
            }
        });
    });

    // Wenn 2 oder mehr SIGNIFIKANTE Wörter gleich sind -> Match!
    // Oder wenn mehr als 40% des Titels identisch sind.
    const threshold = Math.min(words1.length, words2.length) * 0.4;
    return matches >= 2 || matches > threshold;
}

function loadExistingNews() {
    try {
        if (fs.existsSync('news.json')) return JSON.parse(fs.readFileSync('news.json', 'utf8'));
    } catch (e) { }
    return [];
}

async function analyzeWithPollinations(title, content, sourceName) {
    const safeContent = (content || "").substring(0, 1500).replace(/<[^>]*>/g, "");

    const instruction = `Du bist News-Redakteur. Analysiere: "${title} - ${safeContent}"
    
    Antworte NUR mit validem JSON.
    ANWEISUNG:
    1. Sprache: ZWINGEND DEUTSCH (Egal welche Sprache der Input hat!).
    2. Suche nach harten Fakten (Zahlen, Orte, Namen).
    3. Schreibe 2-4 Bulletpoints.
    
    Format:
    {
      "newTitle": "Sachliche Überschrift (Deutsch)",
      "scoop": "Kernaussage in einem Satz.",
      "bullets": ["Fakt 1", "Fakt 2", "Fakt 3"]
    }`;
    
    const url = `https://text.pollinations.ai/${encodeURIComponent(instruction)}?model=openai&seed=${Math.floor(Math.random() * 10000)}`;

    let retries = 3;
    while (retries > 0) {
        try {
            const response = await axios.get(url, { timeout: 40000 });
            let rawText = response.data;
            if (typeof rawText !== 'string') rawText = JSON.stringify(rawText);

            // Cleaning
            rawText = rawText.split("--- Support")[0]; 
            rawText = rawText.split("🌸 Ad")[0];
            rawText = rawText.replace(/```json/g, "").replace(/```/g, "").trim();

            const firstOpen = rawText.indexOf('{');
            const lastClose = rawText.lastIndexOf('}');
            if (firstOpen !== -1 && lastClose !== -1) rawText = rawText.substring(firstOpen, lastClose + 1);

            let data;
            try { data = JSON.parse(rawText); } catch (e) { throw new Error("JSON Error"); }
            
            if (!data.bullets) data.bullets = [];
            data.bullets = data.bullets.map(b => b.replace(/^(Fakt \d:|Punkt \d:|-|\*|•)\s*/i, "").trim());

            return { summary: data.scoop || title, newTitle: data.newTitle || title, bullets: data.bullets, tags: [sourceName, "News"] };

        } catch (error) {
            if (error.response?.status === 429) {
                console.log(`🛑 Zu schnell! Warte 30s...`);
                await sleep(30000); retries--; continue; 
            }
            console.error(`⚠️ Fehler: ${error.message}. Warte kurz...`);
            await sleep(5000); retries--;
        }
    }
    return { summary: title, newTitle: title, bullets: [], tags: [sourceName] };
}

async function run() {
    console.log("🚀 Starte News-Abruf (Better Clustering)...");
    
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
                // 1. DUPLETTE PRÜFEN (Im aktuellen Lauf - BEVOR wir KI fragen)
                // Wir schauen, ob im NEUEN Feed schon was Ähnliches liegt
                const parentIndex = newNewsFeed.findIndex(n => isSimilar(n.originalTitle, item.title));
                
                // Wir bauen das Item vorläufig (ohne KI Text)
                const tempItem = {
                    id: Math.random().toString(36).substr(2, 9),
                    source: source.name,
                    sourceCountry: source.country || "🌍",
                    title: item.title, // Vorläufiger Titel
                    originalTitle: item.title,
                    link: item.link,
                    img: item.enclosure?.url || item.itunes?.image || null,
                    date: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
                    text: "Lade Details...",
                    bullets: [],
                    tags: [],
                    related: []
                };

                if (parentIndex !== -1) {
                    console.log(`🔗 TREFFER! Gruppiere "${item.title.substring(0,20)}..." zu existierender Story.`);
                    // Wir müssen die Variante trotzdem analysieren, damit wir Bullets für sie haben!
                    // (User-Wunsch: Inhalt nicht überspringen)
                    const rawContent = item.contentSnippet || item.content || "";
                    const ai = await analyzeWithPollinations(item.title, rawContent, source.name);
                    
                    tempItem.title = ai.newTitle;
                    tempItem.text = ai.summary;
                    tempItem.bullets = ai.bullets;
                    tempItem.tags = ai.tags;

                    newNewsFeed[parentIndex].related.push(tempItem);
                } else {
                    // Neue Haupt-Story
                    // Check Cache (um API zu sparen)
                    const cached = existingNews.find(n => n.link === item.link);
                    if (cached && cached.bullets && cached.bullets.length > 0) {
                        console.log(`♻️ Aus Cache (Hauptstory): ${item.title.substring(0,20)}...`);
                        newNewsFeed.push({ ...cached, lastUpdated: new Date() });
                    } else {
                        console.log(`🤖 Generiere Hauptstory: ${item.title.substring(0, 30)}...`);
                        const rawContent = item.contentSnippet || item.content || "";
                        const ai = await analyzeWithPollinations(item.title, rawContent, source.name);
                        
                        tempItem.title = ai.newTitle;
                        tempItem.text = ai.summary;
                        tempItem.bullets = ai.bullets;
                        tempItem.tags = ai.tags;
                        
                        newNewsFeed.push(tempItem);
                    }
                }
                
                await sleep(10000); 
            }
        } catch (e) { console.error(`❌ Fehler bei ${source.name}:`, e.message); }
    }

    newNewsFeed.sort((a, b) => new Date(b.date) - new Date(a.date));
    fs.writeFileSync('news.json', JSON.stringify(newNewsFeed, null, 2));
    console.log(`✅ Fertig! ${newNewsFeed.length} Nachrichten-Cluster gespeichert.`);
}

run();
