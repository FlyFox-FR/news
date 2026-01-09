const Parser = require('rss-parser');
const axios = require('axios');
const fs = require('fs');

const parser = new Parser();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- ÄHNLICHKEITS-CHECK (Smarter) ---
function isSimilar(title1, title2) {
    if (!title1 || !title2) return false;

    // Füllwörter ignorieren
    const stopWords = ["und", "der", "die", "das", "mit", "von", "für", "auf", "den", "im", "in", "ist", "hat", "zu", "eine", "ein", "bei", "nach", "gegen", "über"];

    const clean = t => t.toLowerCase()
        .replace(/[^\w\säöüß]/g, ' ') 
        .split(/\s+/)
        .filter(w => w.length > 2)
        .filter(w => !stopWords.includes(w));

    const words1 = clean(title1);
    const words2 = clean(title2);

    // Gemeinsame Wörter zählen
    let matches = 0;
    words1.forEach(w1 => {
        if (words2.includes(w1)) matches++;
    });

    // --- LOGIK-ÄNDERUNG ---
    
    // 1. Wenn ein Titel sehr kurz ist (< 4 relevante Wörter), müssen fast alle Wörter gleich sein.
    // Das verhindert "Iran Protest" == "Iran Militär".
    const minLen = Math.min(words1.length, words2.length);
    if (minLen < 4) {
        return matches >= (minLen - 1); // Fast exakt gleich
    }

    // 2. Bei langen Titeln reichen 40% Übereinstimmung ODER mind. 3 starke Treffer
    const threshold = Math.min(words1.length, words2.length) * 0.4;
    
    return matches >= 3 || matches > threshold;
}

function loadExistingNews() {
    try {
        if (fs.existsSync('news.json')) return JSON.parse(fs.readFileSync('news.json', 'utf8'));
    } catch (e) { }
    return [];
}

async function analyzeWithPollinations(title, content, sourceName) {
    const safeContent = (content || "").substring(0, 1500).replace(/<[^>]*>/g, "");

    // --- PROMPT (Anti-Halluzination) ---
    const instruction = `Du bist ein strenger Fakten-Checker.
    Analysiere: "${title} - ${safeContent}"
    
    Antworte NUR mit validem JSON.
    ANWEISUNG:
    1. Sprache: ZWINGEND DEUTSCH.
    2. Nenne NUR Länder/Personen, die im Text stehen. ERFINDE NICHTS (z.B. keine Beteiligung von Deutschland, wenn es nicht da steht).
    3. Suche nach harten Fakten (Zahlen, Orte).
    
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

// --- CLUSTERING LOGIK ---
function clusterNews(allNews) {
    console.log("🧹 Starte Clustering...");
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

            if (isSimilar(item.originalTitle, candidate.originalTitle)) {
                console.log(`🔗 Gruppiere "${candidate.originalTitle}" -> "${item.originalTitle}"`);
                group.push(candidate);
                processedIds.add(candidate.id);
            }
        }

        let parent = group[0];
        parent.related = [];
        for (let k = 1; k < group.length; k++) {
            parent.related.push(group[k]);
            if (group[k].related && group[k].related.length > 0) {
                parent.related.push(...group[k].related);
            }
        }
        clustered.push(parent);
    }
    return clustered;
}

async function run() {
    console.log("🚀 Starte News-Abruf (Strict Cluster)...");
    
    let sources = [];
    try { sources = JSON.parse(fs.readFileSync('sources.json', 'utf8')); } 
    catch(e) { sources = [{ name: "Tagesschau", url: "https://www.tagesschau.de/xml/rss2/", count: 3, country: "🇩🇪" }]; }

    const existingNews = loadExistingNews();
    
    // Alles in einen Topf werfen (flach)
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
                if (flatFeed.find(n => n.link === item.link)) continue;

                console.log(`🤖 Analysiere: ${item.title.substring(0, 30)}...`);
                const rawContent = item.contentSnippet || item.content || "";
                const ai = await analyzeWithPollinations(item.title, rawContent, source.name);
                
                // --- BILD ---
                let imgUrl = item.enclosure?.url || item.itunes?.image;
                if (!imgUrl) {
                    const cleanPrompt = item.title.replace(/[^a-zA-Z0-9\s]/g, '').substring(0, 100);
                    imgUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent("editorial news photo, realistic, " + cleanPrompt)}?width=800&height=400&nologo=true&model=flux`;
                }

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
