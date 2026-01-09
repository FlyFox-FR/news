const Parser = require('rss-parser');
const axios = require('axios');
const fs = require('fs');

const parser = new Parser();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- HELPER ---
function cleanString(str) {
    return str.toLowerCase().replace(/[^\w\säöüß]/g, ' ').replace(/\s+/g, ' ').trim();
}

function isSameArticle(item1, item2) {
    if (item1.link === item2.link) return true;
    const t1 = cleanString(item1.originalTitle || item1.title);
    const t2 = cleanString(item2.title);
    return t1 === t2 || (t1.includes(t2) && t1.length - t2.length < 5);
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
    4. Wenn Du wirklich keine harten Fakten, Orte, Namen etc. findest, dann schreibe kein Bulletpoint mit "Keine Orte, Fakten etc... im Text gefunden", sondern dann schreibe etwas zum Inhalt/Kontext des Artikels. Schreibe quasi niemals was du nicht findest. Vergiss nicht, du bist ein professioneller Nachrichten Redakteur.
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

            // DeepSeek Cleaning: Falls es ein JSON mit 'content' ist, packen wir es aus
            try {
                const deepSeekObj = JSON.parse(rawText);
                if (deepSeekObj.content) rawText = deepSeekObj.content;
                else if (deepSeekObj.reasoning_content) {
                    // Falls nur reasoning da ist, ist es Müll, aber wir schauen ob 'content' fehlt
                    // Wir nehmen einfach den rawText weiter, falls das Parsen nicht half
                }
            } catch (e) { /* War kein JSON-Objekt, einfach weitermachen */ }

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

// 2. KI CLUSTERING (MIT DEEPSEEK FIX)
async function clusterBatchWithAI(batchArticles, batchIndex) {
    console.log(`📦 Batch ${batchIndex + 1}: KI sortiert ${batchArticles.length} Artikel...`);

    const listForAI = batchArticles.map((a, index) => `ID ${index}: ${a.newTitle || a.title}`).join("\n");
    
    const instruction = `Gruppiere diese Nachrichten nach EXAKT demselben Ereignis.
    Liste:
    ${listForAI}
    
    Aufgabe: Gib ein JSON Array von Arrays zurück.
    Beispiel: [[0, 5], [1], [2, 3]]
    Regeln:
    1. "Sturm Elli" und "Unwetter im Norden" = GLEICHES EVENT -> Gruppieren.
    2. "Iran Protest" und "Iran Militärübung" = UNTERSCHIEDLICH -> Nicht gruppieren.
    3. Antworte NUR mit dem JSON Array [[...]]. Keine Erklärung.`;

    const url = `https://text.pollinations.ai/${encodeURIComponent(instruction)}?model=openai&seed=${Math.floor(Math.random() * 1000)}`;

    try {
        const response = await axios.get(url, { timeout: 60000 });
        let rawText = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
        
        fs.writeFileSync(`debug_batch_${batchIndex}.txt`, rawText);

        // --- DER DEEPSEEK FIX ---
        // Versuch 1: Ist die Antwort selbst ein JSON-Objekt mit 'reasoning_content'?
        // Wenn ja, wollen wir nur den Teil in 'content' haben.
        try {
            // Wir suchen nach dem Muster {"role": ... } oder ähnlichem
            if (rawText.trim().startsWith('{')) {
                const jsonObj = JSON.parse(rawText);
                // Wenn es das DeepSeek Format ist:
                if (jsonObj.content) {
                    console.log("🕵️ DeepSeek Wrapper erkannt, extrahiere Content...");
                    rawText = jsonObj.content; 
                }
            }
        } catch (e) {
            // War kein JSON-Objekt, also wahrscheinlich direkter Text -> Weitermachen
        }

        // --- DER ARRAY SNIPER ---
        // Jetzt suchen wir im (bereinigten) Text nach [[...]]
        const arrayMatch = rawText.match(/\[\s*\[[\d\s,\[\]]*\]\s*\]/s);
        
        let groups;
        if (arrayMatch) {
            groups = JSON.parse(arrayMatch[0]);
        } else {
            throw new Error("Kein Array-Muster [[...]] gefunden");
        }

        if (!Array.isArray(groups)) throw new Error("Kein Array");

        // Gruppen bauen
        let localClusters = [];
        let usedIndices = new Set();

        groups.forEach(groupIndices => {
            if (!Array.isArray(groupIndices)) return;
            let validIndices = groupIndices.filter(i => batchArticles[i] !== undefined);
            if (validIndices.length === 0) return;

            // Bild-Priorität
            let bestParentIndex = 0; 
            for (let k = 0; k < validIndices.length; k++) {
                if (batchArticles[validIndices[k]].img) {
                    bestParentIndex = k;
                    break; 
                }
            }

            let parentIndex = validIndices[bestParentIndex];
            let parent = batchArticles[parentIndex];
            usedIndices.add(parentIndex);
            parent.related = [];

            for (let i = 0; i < validIndices.length; i++) {
                if (i === bestParentIndex) continue; 
                let childIndex = validIndices[i];
                if (!usedIndices.has(childIndex)) {
                    parent.related.push(batchArticles[childIndex]);
                    usedIndices.add(childIndex);
                }
            }
            localClusters.push(parent);
        });

        // Vergessene Items
        batchArticles.forEach((item, index) => {
            if (!usedIndices.has(index)) {
                item.related = [];
                localClusters.push(item);
            }
        });

        return localClusters;

    } catch (e) {
        console.error(`⚠️ Batch ${batchIndex + 1} fehlgeschlagen (${e.message}). Behalte Items einzeln.`);
        return batchArticles.map(a => { a.related = []; return a; });
    }
}

// --- 3. PIPELINE ---
async function runClusteringPipeline(allArticles) {
    const BATCH_SIZE = 15;
    let finalClusters = [];

    // A. Batching
    for (let i = 0; i < allArticles.length; i += BATCH_SIZE) {
        const batch = allArticles.slice(i, i + BATCH_SIZE);
        const batchClusters = await clusterBatchWithAI(batch, Math.floor(i / BATCH_SIZE));
        
        // B. Gluing (Zusammenkleben)
        console.log(`🧩 Klebe Batch-Ergebnisse zusammen...`);
        
        for (const newCluster of batchClusters) {
            let matched = false;

            for (const existingCluster of finalClusters) {
                if (isRelatedTopicAlgorithmic(existingCluster.title, newCluster.title)) {
                    console.log(`🔗 Batch-Overlap: "${newCluster.title}" -> "${existingCluster.title}"`);
                    
                    if (!existingCluster.img && newCluster.img) {
                        newCluster.related.push(existingCluster);
                        if (existingCluster.related) newCluster.related.push(...existingCluster.related);
                        const idx = finalClusters.indexOf(existingCluster);
                        finalClusters[idx] = newCluster;
                    } else {
                        existingCluster.related.push(newCluster);
                        if (newCluster.related) existingCluster.related.push(...newCluster.related);
                    }
                    matched = true;
                    break;
                }
            }

            if (!matched) {
                finalClusters.push(newCluster);
            }
        }
        await sleep(5000);
    }
    return finalClusters;
}

async function run() {
    console.log("🚀 Starte News-Abruf (DeepSeek Proof)...");
    
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

    // Safety Save
    flatFeed.sort((a, b) => new Date(b.date) - new Date(a.date));
    fs.writeFileSync('news.json', JSON.stringify(flatFeed, null, 2));

    if (flatFeed.length > 60) {
        console.log(`✂️ Cleanup: Behalte Top 60.`);
        flatFeed = flatFeed.slice(0, 60);
    }

    // PIPELINE (Batching + DeepSeek Filter)
    const finalFeed = await runClusteringPipeline(flatFeed);
    
    finalFeed.sort((a, b) => new Date(b.date) - new Date(a.date));
    fs.writeFileSync('news.json', JSON.stringify(finalFeed, null, 2));
    console.log(`✅ Fertig! ${finalFeed.length} Themen-Cluster.`);
}

run();








