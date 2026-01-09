const Parser = require('rss-parser');
const axios = require('axios');
const fs = require('fs');

const parser = new Parser();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- HELPER & FALLBACK ---
function cleanString(str) {
    return str.toLowerCase().replace(/[^\w\säöüß]/g, ' ').replace(/\s+/g, ' ').trim();
}

function isSameArticle(item1, item2) {
    if (item1.link === item2.link) return true;
    const t1 = cleanString(item1.originalTitle || item1.title);
    const t2 = cleanString(item2.title);
    return t1 === t2 || (t1.includes(t2) && t1.length - t2.length < 5);
}

// Fallback Algo
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

// --- 1. INHALT ---
async function analyzeWithPollinations(title, content, sourceName) {
    const safeContent = (content || "").substring(0, 1500).replace(/<[^>]*>/g, "");

     const instruction = `Du bist News-Redakteur. Analysiere: "${title} - ${safeContent}"
    Antworte NUR mit validem JSON.
    ANWEISUNG:
    1. Sprache: ZWINGEND DEUTSCH.
    2. Nenne NUR Länder/Personen, die im Text stehen. ERFINDE NICHTS.
    3. Suche nach harten Fakten (Zahlen, Orte).
    4. Schreibe 2-4 Bulletpoints.
    5. Wenn Du wirklich keine harten Fakten, Orte, Namen etc. findest, dann schreibe kein Bulletpoint mit "Keine Orte, Fakten etc... im Text gefunden", sondern dann schreibe etwas zum Inhalt/Kontext des Artikels. Schreibe quasi niemals was du nicht findest. Vergiss nicht, du bist ein professioneller Nachrichten Redakteur.
    
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

// --- 2. CLUSTERING (MIT DEBUG & REASONING FILTER) ---
async function clusterWithAI(articles) {
    if (articles.length === 0) return [];
    
    const activeArticles = articles.slice(0, 60); 
    console.log(`🧠 KI sortiert Top ${activeArticles.length}...`);

    const listForAI = activeArticles.map((a, index) => `ID ${index}: ${a.newTitle || a.title}`).join("\n");
    const safeList = listForAI.substring(0, 3500);

    const instruction = `Du bist ein News-Aggregator. Gruppiere diese Schlagzeilen nach EXAKT demselben Ereignis.
    Liste:
    ${safeList}
    
    Aufgabe: Gib ein JSON Array von Arrays zurück. Jedes innere Array enthält die IDs, die zusammengehören.
    Beispiel: [[0, 5], [1], [2, 3]]
    Regeln:
    1. "Sturm Elli" und "Unwetter im Norden" = GLEICHES EVENT -> Gruppieren.
    2. "Iran Protest" und "Iran Militärübung" = UNTERSCHIEDLICH -> Nicht gruppieren.
    3. Antworte NUR mit dem JSON. Keine Erklärung!`;

    const url = `https://text.pollinations.ai/${encodeURIComponent(instruction)}?model=openai&seed=${Math.floor(Math.random() * 1000)}`;

    try {
        const response = await axios.get(url, { timeout: 120000 });
        
        // DEBUGGING: Wir speichern die rohe Antwort!
        let rawText = typeof response.data === 'string' ? response.data : JSON.stringify(response.data, null, 2);
        fs.writeFileSync('debug_ai_response.txt', rawText); // <--- HIER SPEICHERN WIR
        console.log("🐛 KI-Antwort gespeichert in debug_ai_response.txt");

        // --- LASER PARSER 2.0 ---
        // Das Modell könnte { "role": "assistant", "content": "[[1,2]]" } zurückgeben.
        // Wir suchen im GANZEN Text einfach nach [[ ... ]] mit Zahlen drin.
        // Regex Erklärung: Suche nach [[ gefolgt von Zahlen/Kommas/Klammern gefolgt von ]]
        const magicMatch = rawText.match(/\[\s*\[[\d\s,\[\]]*\]\s*\]/);

        if (magicMatch) {
            rawText = magicMatch[0]; // Wir nehmen nur das gefundene Array!
        } else {
            throw new Error("Kein Array-Muster [[...]] im Text gefunden.");
        }

        const groups = JSON.parse(rawText);
        if (!Array.isArray(groups)) throw new Error("Format ist kein Array");

        console.log("🧠 KI-Gruppierung erfolgreich!");
        
        let clusteredFeed = [];
        let usedIndices = new Set();

        groups.forEach(groupIndices => {
            if (!Array.isArray(groupIndices)) return;
            let validIndices = groupIndices.filter(i => activeArticles[i] !== undefined);
            if (validIndices.length === 0) return;

            // Bild-Priorität
            let bestParentIndex = 0; 
            for (let k = 0; k < validIndices.length; k++) {
                if (activeArticles[validIndices[k]].img) {
                    bestParentIndex = k;
                    break; 
                }
            }

            let parentRealIndex = validIndices[bestParentIndex];
            let parent = activeArticles[parentRealIndex];
            usedIndices.add(parentRealIndex);
            
            parent.related = [];

            for (let i = 0; i < validIndices.length; i++) {
                if (i === bestParentIndex) continue; 
                let childIndex = validIndices[i];
                if (!usedIndices.has(childIndex)) {
                    parent.related.push(activeArticles[childIndex]);
                    usedIndices.add(childIndex);
                }
            }
            clusteredFeed.push(parent);
        });

        activeArticles.forEach((item, index) => {
            if (!usedIndices.has(index)) {
                item.related = [];
                clusteredFeed.push(item);
            }
        });

        return clusteredFeed;

    } catch (e) {
        console.error("❌ KI-Clustering fehlgeschlagen:", e.message);
        console.log("⚙️ Starte algorithmischen Fallback (Math-Mode)...");
        return clusterAlgorithmic(articles);
    }
}

function clusterAlgorithmic(allNews) {
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

            if (isRelatedTopicAlgorithmic(item.originalTitle, candidate.originalTitle)) {
                console.log(`🔗 Algo-Cluster: "${candidate.originalTitle}" -> "${item.originalTitle}"`);
                group.push(candidate);
                processedIds.add(candidate.id);
            }
        }

        let parent = group[0];
        if (!parent.img) {
            const childWithImgIndex = group.findIndex(g => g.img);
            if (childWithImgIndex !== -1) {
                parent = group[childWithImgIndex];
                group.splice(childWithImgIndex, 1);
                group.unshift(parent);
            }
        }

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
    console.log("🚀 Starte News-Abruf (Debug & Fix)...");
    
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

    console.log(`📂 Cache: ${flatFeed.length} Artikel.`);

    for (const source of sources) {
        try {
            console.log(`\n📡 ${source.name}...`);
            const feed = await parser.parseURL(source.url);
            let addedCount = 0;
            let checkedCount = 0;
            const maxLookback = 20; 

            for (const item of feed.items) {
                if (addedCount >= source.count) break; 
                if (checkedCount >= maxLookback) break; 
                checkedCount++;

                const existingIndex = flatFeed.findIndex(n => isSameArticle(n, item));
                
                if (existingIndex !== -1) {
                    flatFeed[existingIndex].date = item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString();
                    continue; 
                }

                console.log(`🤖 Neu (${addedCount + 1}/${source.count}): ${item.title.substring(0, 30)}...`);
                const rawContent = item.contentSnippet || item.content || "";
                
                const ai = await analyzeWithPollinations(item.title, rawContent, source.name);
                let imgUrl = item.enclosure?.url || item.itunes?.image || null;

                flatFeed.push({
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
                });
                
                addedCount++;
                await sleep(10000); 
            }
        } catch (e) { console.error(`❌ Fehler bei ${source.name}:`, e.message); }
    }

    flatFeed.sort((a, b) => new Date(b.date) - new Date(a.date));
    fs.writeFileSync('news.json', JSON.stringify(flatFeed, null, 2));

    if (flatFeed.length > 60) {
        console.log(`✂️ Cleanup: Behalte Top 60.`);
        flatFeed = flatFeed.slice(0, 60);
    }

    const finalFeed = await clusterWithAI(flatFeed);
    
    finalFeed.sort((a, b) => new Date(b.date) - new Date(a.date));
    fs.writeFileSync('news.json', JSON.stringify(finalFeed, null, 2));
    console.log(`✅ Fertig! ${finalFeed.length} Themen-Cluster.`);
}

run();
