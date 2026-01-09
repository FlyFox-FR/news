const Parser = require('rss-parser');
const axios = require('axios');
const fs = require('fs');

const parser = new Parser();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- NEU: INTELLIGENTER ÄHNLICHKEITS-CHECK ---
function cleanAndStem(text) {
    if (!text) return [];
    
    // Stoppwörter (erweitert)
    const stopWords = ["und", "oder", "aber", "der", "die", "das", "ein", "eine", "einer", "den", "dem", "des", "mit", "von", "bei", "für", "auf", "im", "in", "ist", "sind", "war", "wird", "werden", "nach", "über", "wegen", "dass", "hat", "haben", "wie", "als", "auch", "noch", "doch", "aus", "all", "gegen"];

    return text.toLowerCase()
        .replace(/[^\w\säöüß]/g, ' ') // Sonderzeichen weg
        .split(/\s+/) // In Wörter splitten
        .filter(w => w.length > 2) // Min 3 Zeichen
        .filter(w => !stopWords.includes(w)) // Stoppwörter raus
        .map(w => {
            // "Stemming Light": Einfache Endungen entfernen, um "Sturm" == "Stürme" zu erkennen
            if (w.length > 5) return w.replace(/(en|em|ern|er|es|e)$/, "");
            return w;
        });
}

function getSimilarityScore(title1, title2) {
    const set1 = cleanAndStem(title1);
    const set2 = cleanAndStem(title2);

    if (set1.length === 0 || set2.length === 0) return 0;

    let matchWeight = 0;
    let totalWeight = 0;

    // Wir gewichten lange, seltene Wörter höher!
    // "Iran" (4) zählt weniger als "Oreschnik" (9) oder "Bundestagswahl" (14).
    
    set1.forEach(w1 => {
        const weight = w1.length * w1.length; // Quadratische Gewichtung: Länge ist Macht
        totalWeight += weight;
        
        // Prüfen ob w1 in set2 enthalten ist (oder sehr ähnlich)
        if (set2.some(w2 => w2 === w1 || (w1.length > 4 && w2.includes(w1)) || (w2.length > 4 && w1.includes(w2)))) {
            matchWeight += weight * 2; // Match zählt für beide Seiten
        }
    });
    
    set2.forEach(w2 => {
        totalWeight += w2.length * w2.length;
    });

    // Dice Koeffizient Formel (angepasst auf Gewichtung)
    // 2 * (Gewicht der Matches) / (Gesamtgewicht beider Sätze)
    const score = matchWeight / totalWeight;
    
    return score;
}

// --- 1. DEDUPLIZIERUNG (Exakt gleiche Artikel verhindern) ---
function isSameArticle(item1, item2) {
    if (item1.link === item2.link) return true;
    // Wenn Score extrem hoch (> 0.85), ist es quasi derselbe Titel
    return getSimilarityScore(item1.originalTitle || item1.title, item2.title) > 0.85;
}

// --- 2. CLUSTERING (Themen gruppieren) ---
function isRelatedTopic(title1, title2) {
    const score = getSimilarityScore(title1, title2);
    
    // Schwellenwert: 0.35 hat sich als guter "Sweet Spot" erwiesen.
    // Iran/Protest vs Iran/Militär hat einen Score von ca. 0.1 (nur "Iran" matcht, Rest nicht).
    // Elli/Sturm vs Winter/Elli hat Score von ca. 0.5 (Elli + Sturm/Winter matcht).
    return score > 0.35; 
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
    1. Sprache: ZWINGEND DEUTSCH.
    2. Suche nach harten Fakten (Zahlen, Orte, Namen).
    3. Schreibe 2-4 Bulletpoints.
    
    Format:
    {
      "newTitle": "Sachliche Überschrift",
      "scoop": "Kernaussage in einem Satz.",
      "bullets": ["Fakt 1", "Fakt 2", "Fakt 3"]
    }`;
    
    const url = `https://text.pollinations.ai/${encodeURIComponent(instruction)}?model=openai&seed=${Math.floor(Math.random() * 10000)}`;

    let retries = 3;
    while (retries > 0) {
        try {
            const response = await axios.get(url, { timeout: 35000 });
            let rawText = response.data;
            if (typeof rawText !== 'string') rawText = JSON.stringify(rawText);

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
            if (error.response?.status === 429) { await sleep(30000); retries--; continue; }
            await sleep(5000); retries--;
        }
    }
    return { summary: title, newTitle: title, bullets: [], tags: [sourceName] };
}

function clusterNews(allNews) {
    console.log(`🧹 Starte Clustering für ${allNews.length} Artikel...`);
    let clustered = [];
    let processedIds = new Set();

    allNews.sort((a, b) => new Date(b.date) - new Date(a.date));

    for (let i = 0; i < allNews.length; i++) {
        let item = allNews[i];
        if (processedIds.has(item.id)) continue;

        let group = [item];
        processedIds.add(item.id);

        for (let j = i + 1; j < allNews.length; j++) {
            let candidate = allNews[j];
            if (processedIds.has(candidate.id)) continue;

            if (isRelatedTopic(item.originalTitle, candidate.originalTitle)) {
                const score = getSimilarityScore(item.originalTitle, candidate.originalTitle);
                console.log(`🔗 Cluster (Score ${score.toFixed(2)}): "${candidate.originalTitle}" -> "${item.originalTitle}"`);
                group.push(candidate);
                processedIds.add(candidate.id);
            }
        }

        let parent = group[0];
        parent.related = [];
        for (let k = 1; k < group.length; k++) {
            parent.related.push(group[k]);
            if (group[k].related) parent.related.push(...group[k].related);
        }
        clustered.push(parent);
    }
    return clustered;
}

async function run() {
    console.log("🚀 Starte News-Abruf (Clean & Smart Cluster)...");
    
    let sources = [];
    try { sources = JSON.parse(fs.readFileSync('sources.json', 'utf8')); } 
    catch(e) { sources = [{ name: "Tagesschau", url: "https://www.tagesschau.de/xml/rss2/", count: 3, country: "🇩🇪" }]; }

    const existingNews = loadExistingNews();
    let flatFeed = [];
    
    existingNews.forEach(item => {
        let cleanItem = { ...item };
        delete cleanItem.related;
        flatFeed.push(cleanItem);
        if (item.related) item.related.forEach(child => flatFeed.push(child));
    });

    for (const source of sources) {
        try {
            console.log(`\n📡 ${source.name}...`);
            const feed = await parser.parseURL(source.url);
            const items = feed.items.slice(0, source.count);

            for (const item of items) {
                // Deduplizierung (Exakter Check)
                const existingIndex = flatFeed.findIndex(n => isSameArticle(n, item));
                
                if (existingIndex !== -1) {
                    flatFeed[existingIndex].date = item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString();
                    continue; 
                }

                console.log(`🤖 Neu: ${item.title.substring(0, 30)}...`);
                const rawContent = item.contentSnippet || item.content || "";
                const ai = await analyzeWithPollinations(item.title, rawContent, source.name);
                
                // KI-Bild Code wurde hier ENTFERNT (Wunsch gemäß)
                let imgUrl = item.enclosure?.url || item.itunes?.image || null;

                const newsItem = {
                    id: Math.random().toString(36).substr(2, 9),
                    source: source.name,
                    sourceCountry: source.country || "🌍",
                    title: ai.newTitle || item.title,
                    originalTitle: item.title,
                    link: item.link,
                    img: imgUrl,
                    date: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
                    text: ai.summary,
                    bullets: ai.bullets,
                    tags: ai.tags,
                    related: []
                };
                
                flatFeed.push(newsItem);
                await sleep(10000); 
            }
        } catch (e) { console.error(`❌ Fehler bei ${source.name}:`, e.message); }
    }

    const finalFeed = clusterNews(flatFeed);
    
    fs.writeFileSync('news.json', JSON.stringify(finalFeed, null, 2));
    console.log(`✅ Fertig! ${finalFeed.length} Themen-Cluster.`);
}

run();
