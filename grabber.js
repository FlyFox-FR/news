const Parser = require('rss-parser');
const axios = require('axios');
const fs = require('fs');

const parser = new Parser();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- TEXT CLEANER ---
function cleanString(str) {
    return str.toLowerCase()
        .replace(/[^\w\säöüß]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// --- 1. IDENTITÄTS-CHECK (Ist es derselbe Artikel?) ---
// Streng: Link gleich ODER Titel zu 90% gleich
function isSameArticle(item1, item2) {
    if (item1.link === item2.link) return true;
    const t1 = cleanString(item1.originalTitle || item1.title);
    const t2 = cleanString(item2.title);
    return t1 === t2 || (t1.includes(t2) && t1.length - t2.length < 5) || (t2.includes(t1) && t2.length - t1.length < 5);
}

// --- 2. THEMEN-CHECK (Gehört es zum selben Thema?) ---
// Lockerer: Gemeinsame Wörter oder Teilwörter
function isRelatedTopic(title1, title2) {
    if (!title1 || !title2) return false;

    const stopWords = ["und", "der", "die", "das", "mit", "von", "für", "auf", "den", "im", "in", "ist", "hat", "zu", "eine", "ein", "bei", "nach", "gegen", "über", "wird", "sich"];
    
    const getWords = (t) => cleanString(t).split(' ').filter(w => w.length > 2 && !stopWords.includes(w));
    
    const words1 = getWords(title1);
    const words2 = getWords(title2);

    let matches = 0;
    
    words1.forEach(w1 => {
        // Exakter Match
        if (words2.includes(w1)) {
            matches++;
            return; // Ein Wort nur einmal zählen
        }
        // Teilwort-Match (z.B. "Sturm" in "Sturmtief")
        const partial = words2.find(w2 => (w1.length > 3 && w2.length > 3) && (w1.includes(w2) || w2.includes(w1)));
        if (partial) matches++;
    });

    // ELLI-FIX: 
    // Bei kurzen Titeln reicht schon 1 starkes Wort + 1 Teilwort, oder 2 Treffer.
    // Bei langen Titeln brauchen wir mehr Evidenz.
    const minLen = Math.min(words1.length, words2.length);
    
    if (minLen <= 4) return matches >= 1 && (matches / minLen) >= 0.4; // 40% Übereinstimmung bei kurzen Titeln
    return matches >= 2;
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
    4. Erfinde NIE etwas. NICHTS erfinden. Was nicht so ungefähr in dem Kontext des Textes drinsteht, das kannst Du nicht nehmen. Dann nimm etwas aus dem Text.
    5. Aber es wäre gut, wenn Du ein bisschen was aus dem ganzen Artikel nimmst, damit es wie eine ECHTE Zusammenfassung ist und nicht nur die ersten 3 Sätze.
    
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
    console.log(`🧹 Starte Clustering für ${allNews.length} Artikel...`);
    let clustered = [];
    let processedIds = new Set();

    // Neueste zuerst
    allNews.sort((a, b) => new Date(b.date) - new Date(a.date));

    for (let i = 0; i < allNews.length; i++) {
        let item = allNews[i];
        if (processedIds.has(item.id)) continue;

        let group = [item];
        processedIds.add(item.id);

        for (let j = i + 1; j < allNews.length; j++) {
            let candidate = allNews[j];
            if (processedIds.has(candidate.id)) continue;

            // Hier nutzen wir den toleranten Themen-Check
            if (isRelatedTopic(item.originalTitle, candidate.originalTitle)) {
                console.log(`🔗 Cluster: "${candidate.originalTitle}" -> "${item.originalTitle}"`);
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
    console.log("🚀 Starte News-Abruf (Final Dedupe & Cluster)...");
    
    let sources = [];
    try { sources = JSON.parse(fs.readFileSync('sources.json', 'utf8')); } 
    catch(e) { sources = [{ name: "Tagesschau", url: "https://www.tagesschau.de/xml/rss2/", count: 3, country: "🇩🇪" }]; }

    // 1. Alles Vorhandene laden und flachklopfen
    const existingNews = loadExistingNews();
    let flatFeed = [];
    
    existingNews.forEach(item => {
        let cleanItem = { ...item };
        delete cleanItem.related;
        flatFeed.push(cleanItem);
        if (item.related) item.related.forEach(child => flatFeed.push(child));
    });

    console.log(`📂 Cache geladen: ${flatFeed.length} Artikel.`);

    // 2. Neue News holen und INTELLIGENT einfügen
    for (const source of sources) {
        try {
            console.log(`\n📡 ${source.name}...`);
            const feed = await parser.parseURL(source.url);
            const items = feed.items.slice(0, source.count);

            for (const item of items) {
                // DER TÜRSTEHER: Gibt es diesen Artikel schon?
                const existingIndex = flatFeed.findIndex(n => isSameArticle(n, item));
                
                if (existingIndex !== -1) {
                    // Update Datum, aber behalte KI-Daten (spart Tokens!)
                    // console.log(`♻️ Update existierender Artikel: ${item.title.substring(0,20)}...`);
                    flatFeed[existingIndex].date = item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString();
                    continue; // Fertig, nicht neu generieren
                }

                // Wenn wirklich neu: KI anwerfen
                console.log(`🤖 Neu: ${item.title.substring(0, 30)}...`);
                const rawContent = item.contentSnippet || item.content || "";
                const ai = await analyzeWithPollinations(item.title, rawContent, source.name);
                
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

    // 3. Jetzt alles sauber gruppieren
    const finalFeed = clusterNews(flatFeed);
    
    fs.writeFileSync('news.json', JSON.stringify(finalFeed, null, 2));
    console.log(`✅ Fertig! ${finalFeed.length} Themen-Cluster.`);
}

run();

