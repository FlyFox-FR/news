const Parser = require('rss-parser');
const axios = require('axios');
const fs = require('fs');

const parser = new Parser();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- HELPER ---
function cleanString(str) {
    return str.toLowerCase().replace(/[^\w\säöüß]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Prüft auf Duplikate
function isSameArticle(item1, item2) {
    if (item1.link === item2.link) return true;
    const t1 = cleanString(item1.originalTitle || item1.title);
    const t2 = cleanString(item2.title);
    return t1 === t2 || (t1.includes(t2) && t1.length - t2.length < 5);
}

// --- PRUNING LOGIK (Löscht alles älter als 24h) ---
function pruneNews(newsArray) {
    const now = new Date();
    const einTagInMs = 24 * 60 * 60 * 1000; 

    console.log(`🧹 Pruning: Prüfe ${newsArray.length} Items...`);
    const filtered = newsArray.filter(item => {
        const itemDate = new Date(item.date);
        return (now - itemDate) < einTagInMs;
    });

    console.log(`🧹 Pruning beendet: ${filtered.length} Items verbleiben.`);
    return filtered;
}

// "Kleber"-Algorithmus für Batch-Übergänge
function isRelatedTopicAlgorithmic(title1, title2) {
    const stopWords = ["und", "der", "die", "das", "mit", "von", "für", "auf", "den", "im", "in", "ist", "hat", "zu", "eine", "ein", "bei", "nach", "gegen", "über"];
    const getWords = (t) => cleanString(t).split(' ').filter(w => w.length > 2 && !stopWords.includes(w));
    const words1 = getWords(title1);
    const words2 = getWords(title2);
    let matches = 0;
    words1.forEach(w1 => {
        if (words2.includes(w1)) matches++;
        else {
            const partial = words2.find(w2 => (w1.length > 3 && w2.length > 3) && (w1.includes(w2) || w2.includes(w1)));
            if (partial) matches++;
        }
    });
    const minLen = Math.min(words1.length, words2.length);
    if (minLen <= 4) return matches >= 1 && (matches / minLen) >= 0.4;
    return matches >= 2;
}

function loadExistingNews() {
    try {
        if (fs.existsSync('news.json')) return JSON.parse(fs.readFileSync('news.json', 'utf8'));
    } catch (e) { }
    return [];
}

// 1. INHALTS-ANALYSE
async function analyzeWithPollinations(title, content, sourceName) {
    const safeContent = (content || "").substring(0, 1500).replace(/<[^>]*>/g, "");

    const instruction = `Du bist News-Redakteur. Analysiere: "${title} - ${safeContent}"
    Antworte NUR mit validem JSON.
    ANWEISUNG:
    1. Sprache: ZWINGEND DEUTSCH.
    2. ERFINDE NICHTS! Versuche dich an den Kontext der Artikel zu halten.
    3. Suche nach harten Fakten (Zahlen, Orte).
    4. Wenn Du wirklich keine harten Fakten, Orte, Namen etc. findest, dann schreibe kein Bulletpoint mit "Keine Orte, Fakten etc... im Text gefunden", sondern dann schreibe etwas zum Inhalt/Kontext des Artikels.
    5. Schreibe 2-4 Bulletpoints.

    Format:
    {
      "newTitle": "Sachliche Überschrift",
      "scoop": "Kernaussage in einem Satz.",
      "bullets": ["Fakt 1", "Fakt 2", "Fakt 3"]
    }`
    
    const url = `https://text.pollinations.ai/${encodeURIComponent(instruction)}?model=openai&seed=${Math.floor(Math.random() * 10000)}`;

    let retries = 3;
    while (retries > 0) {
        try {
            const response = await axios.get(url, { timeout: 35000 });
            let rawText = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);

            try {
                const deepSeekObj = JSON.parse(rawText);
                if (deepSeekObj.content) rawText = deepSeekObj.content;
            } catch (e) { }

            rawText = rawText.split("--- Support")[0]; 
            rawText = rawText.replace(/```json|```/g, "").trim();
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

// 2. KI CLUSTERING
async function clusterBatchWithAI(batchArticles, batchIndex) {
    console.log(`📦 Batch ${batchIndex + 1}: KI sortiert ${batchArticles.length} Artikel...`);
    const listForAI = batchArticles.map((a, index) => `ID ${index}: ${a.newTitle || a.title}`).join("\n");
    
    const instruction = `Gruppiere diese Nachrichten nach EXAKT demselben Ereignis. Antworte NUR mit JSON: [[ID, ID], [ID]].\n${listForAI}`;
    const url = `https://text.pollinations.ai/${encodeURIComponent(instruction)}?model=openai&seed=${Math.floor(Math.random() * 1000)}`;

    try {
        const response = await axios.get(url, { timeout: 60000 });
        let rawText = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
        
        try {
            const jsonObj = JSON.parse(rawText);
            if (jsonObj.content) rawText = jsonObj.content;
        } catch (e) { }

        const arrayMatch = rawText.match(/\[\s*\[[\d\s,\[\]]*\]\s*\]/s);
        let groups = arrayMatch ? JSON.parse(arrayMatch[0]) : null;

        if (!Array.isArray(groups)) throw new Error("Kein Array");

        let localClusters = [];
        let usedIndices = new Set();

        groups.forEach(groupIndices => {
            if (!Array.isArray(groupIndices)) return;
            let validIndices = groupIndices.filter(i => batchArticles[i] !== undefined);
            if (validIndices.length === 0) return;

            let bestParentIndex = validIndices.findIndex(idx => batchArticles[idx].img) !== -1 
                ? validIndices.findIndex(idx => batchArticles[idx].img) : 0;

            let parentIndex = validIndices[bestParentIndex];
            let parent = batchArticles[parentIndex];
            usedIndices.add(parentIndex);
            parent.related = [];

            validIndices.forEach((idx, i) => {
                if (i !== bestParentIndex && !usedIndices.has(idx)) {
                    parent.related.push(batchArticles[idx]);
                    usedIndices.add(idx);
                }
            });
            localClusters.push(parent);
        });

        batchArticles.forEach((item, index) => {
            if (!usedIndices.has(index)) {
                item.related = [];
                localClusters.push(item);
            }
        });
        return localClusters;

    } catch (e) {
        return batchArticles.map(a => { a.related = []; return a; });
    }
}

// --- 3. PIPELINE ---
async function runClusteringPipeline(allArticles) {
    const BATCH_SIZE = 15;
    let finalClusters = [];

    for (let i = 0; i < allArticles.length; i += BATCH_SIZE) {
        const batch = allArticles.slice(i, i + BATCH_SIZE);
        const batchClusters = await clusterBatchWithAI(batch, Math.floor(i / BATCH_SIZE));
        
        for (const newCluster of batchClusters) {
            let matched = false;
            for (const existingCluster of finalClusters) {
                if (isRelatedTopicAlgorithmic(existingCluster.title, newCluster.title)) {
                    if (!existingCluster.img && newCluster.img) {
                        newCluster.related.push(existingCluster, ...(existingCluster.related || []));
                        finalClusters[finalClusters.indexOf(existingCluster)] = newCluster;
                    } else {
                        existingCluster.related.push(newCluster, ...(newCluster.related || []));
                    }
                    matched = true;
                    break;
                }
            }
            if (!matched) finalClusters.push(newCluster);
        }
        await sleep(2000);
    }
    return finalClusters;
}

// --- HAUPTFUNKTION ---
async function run() {
    console.log("🚀 Starte News-Abruf (mit 24h Pruning)...");
    
    let sources = [];
    try { sources = JSON.parse(fs.readFileSync('sources.json', 'utf8')); } 
    catch(e) { sources = [{ name: "Tagesschau", url: "https://www.tagesschau.de/xml/rss2/", count: 3, country: "🇩🇪" }]; }

    // 1. Lade bestehende News und PRUNE sofort
    let existingNews = loadExistingNews();
    existingNews = pruneNews(existingNews);

    let flatFeed = [];
    existingNews.forEach(item => {
        let cleanItem = { ...item };
        delete cleanItem.related;
        flatFeed.push(cleanItem);
        if (item.related) item.related.forEach(child => flatFeed.push(child));
    });

    // 2. Neue News laden
    for (const source of sources) {
        try {
            console.log(`\n📡 ${source.name}...`);
            const feed = await parser.parseURL(source.url);
            let addedCount = 0;
            let checkedCount = 0;

            for (const item of feed.items) {
                if (addedCount >= source.count || checkedCount >= 20) break; 
                checkedCount++;

                const existingIndex = flatFeed.findIndex(n => isSameArticle(n, item));
                if (existingIndex !== -1) {
                    flatFeed[existingIndex].date = item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString();
                    continue; 
                }

                console.log(`🤖 Neu: ${item.title.substring(0, 30)}...`);
                const ai = await analyzeWithPollinations(item.title, item.contentSnippet || item.content || "", source.name);
                
                flatFeed.push({
                    id: Math.random().toString(36).substr(2, 9),
                    source: source.name,
                    sourceCountry: source.country || "🌍",
                    title: ai.newTitle || item.title,
                    originalTitle: item.title,
                    link: item.link,
                    img: item.enclosure?.url || item.itunes?.image || null,
                    date: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
                    text: ai.summary,
                    bullets: ai.bullets,
                    tags: ai.tags,
                    related: []
                });
                addedCount++;
                await sleep(5000); 
            }
        } catch (e) { console.error(`❌ Fehler bei ${source.name}:`, e.message); }
    }

    // 3. Vor dem Clustering nochmal prunen & sortieren
    flatFeed = pruneNews(flatFeed);
    flatFeed.sort((a, b) => new Date(b.date) - new Date(a.date));

    // Begrenzung auf 60 für Stabilität
    if (flatFeed.length > 60) {
        console.log(`✂️ Cleanup: Behalte Top 60.`);
        flatFeed = flatFeed.slice(0, 60);
    }

    // 4. Clustering (KI)
    let finalFeed = await runClusteringPipeline(flatFeed);
    
    // 5. Finales Pruning & Sortieren
    finalFeed = pruneNews(finalFeed);
    finalFeed.sort((a, b) => new Date(b.date) - new Date(a.date));

    // 6. Speichern
    fs.writeFileSync('news.json', JSON.stringify(finalFeed, null, 2));
    console.log(`✅ Fertig! ${finalFeed.length} Themen-Cluster gespeichert.`);
}

run();
