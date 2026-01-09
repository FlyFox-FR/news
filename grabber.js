const Parser = require('rss-parser');
const axios = require('axios');
const fs = require('fs');

const parser = new Parser();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- ALTER FALLBACK ALGORITHMUS (Falls KI versagt) ---
function isRelatedTopicFallback(title1, title2) {
    const clean = t => t.toLowerCase().replace(/[^\w\säöüß]/g, '').split(/\s+/).filter(w => w.length > 3);
    const set1 = clean(title1);
    const set2 = clean(title2);
    let matchWeight = 0, totalWeight = 0;
    set1.forEach(w1 => {
        const w = w1.length * w1.length;
        totalWeight += w;
        if (set2.some(w2 => w2.includes(w1) || w1.includes(w2))) matchWeight += w * 2;
    });
    set2.forEach(w2 => totalWeight += w2.length * w2.length);
    return (matchWeight / totalWeight) > 0.35;
}

function loadExistingNews() {
    try {
        if (fs.existsSync('news.json')) return JSON.parse(fs.readFileSync('news.json', 'utf8'));
    } catch (e) { }
    return [];
}

// 1. TEXT ANALYSE (Wie bisher)
async function analyzeWithPollinations(title, content, sourceName) {
    const safeContent = (content || "").substring(0, 1500).replace(/<[^>]*>/g, "");
    const instruction = `Du bist News-Redakteur. Analysiere: "${title} - ${safeContent}". Antworte mit JSON: { "newTitle": "Sachlich Deutsch", "scoop": "Kernaussage", "bullets": ["Fakt 1", "Fakt 2"] }`;
    const url = `https://text.pollinations.ai/${encodeURIComponent(instruction)}?model=openai&seed=${Math.floor(Math.random() * 10000)}`;

    let retries = 2;
    while (retries > 0) {
        try {
            const response = await axios.get(url, { timeout: 35000 });
            let rawText = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
            rawText = rawText.split("---")[0].replace(/```json|```/g, "").trim();
            const first = rawText.indexOf('{'), last = rawText.lastIndexOf('}');
            if (first !== -1 && last !== -1) rawText = rawText.substring(first, last + 1);
            
            let data = JSON.parse(rawText);
            if (!data.bullets) data.bullets = [];
            return { summary: data.scoop || title, newTitle: data.newTitle || title, bullets: data.bullets, tags: [sourceName, "News"] };
        } catch (error) {
            await sleep(3000); retries--;
        }
    }
    return { summary: title, newTitle: title, bullets: [], tags: [sourceName] };
}

// 2. AI CLUSTERING (Der neue "Konferenz-Tisch")
async function groupNewsWithAI(flatFeed) {
    console.log("🧠 KI sortiert jetzt die Themen...");

    // Wir bauen eine sehr kurze Liste für die URL (um Platz zu sparen)
    // Format: "0|TitelA| 1|TitelB| ..."
    const inputList = flatFeed.map((item, index) => `${index}|${item.newTitle || item.title}`).join(" || ");
    
    // Wir schneiden ab, falls es zu lang für die URL wird (ca. 2000 Zeichen Puffer)
    const safeInput = inputList.substring(0, 2500);

    const instruction = `Du bist ein News-Aggregator. Gruppiere diese Schlagzeilen nach exaktem Thema.
    Input Format: "ID|Titel || ID|Titel..."
    
    Liste: "${safeInput}"
    
    Aufgabe: Gib ein JSON-Array von Arrays zurück. Jedes innere Array enthält die IDs, die zum SELBEN Ereignis gehören.
    Beispiel Output: [[0, 2], [1], [3, 4]]
    
    WICHTIG:
    1. Jede ID muss vorkommen.
    2. Gruppiere nur, wenn es wirklich dasselbe Ereignis ist (z.B. "Sturm Elli" und "Unwetter im Norden").
    4. Antworte NUR mit dem JSON.`;

    const url = `https://text.pollinations.ai/${encodeURIComponent(instruction)}?model=openai&seed=${Math.floor(Math.random() * 1000)}`;

    try {
        const response = await axios.get(url, { timeout: 45000 });
        let rawText = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
        // Cleaning
        rawText = rawText.replace(/```json|```/g, "").trim();
        const first = rawText.indexOf('['), last = rawText.lastIndexOf(']');
        if (first !== -1 && last !== -1) rawText = rawText.substring(first, last + 1);

        const groups = JSON.parse(rawText);
        
        // Validierung: Ist es wirklich ein Array von Arrays?
        if (!Array.isArray(groups) || !Array.isArray(groups[0])) throw new Error("Format falsch");

        console.log("🧠 KI-Gruppierung erfolgreich:", JSON.stringify(groups));
        
        // --- FEED NEU ZUSAMMENBAUEN ---
        let clusteredFeed = [];
        let usedIndices = new Set();

        groups.forEach(groupIndices => {
            // Filtern: Nur gültige Indizes
            let validIndices = groupIndices.filter(i => flatFeed[i] !== undefined);
            if (validIndices.length === 0) return;

            // Der erste im Cluster ist der Parent (Hauptartikel)
            let parent = flatFeed[validIndices[0]];
            usedIndices.add(validIndices[0]);
            parent.related = [];

            // Die anderen sind Kinder
            for (let i = 1; i < validIndices.length; i++) {
                let childIndex = validIndices[i];
                if (!usedIndices.has(childIndex)) {
                    parent.related.push(flatFeed[childIndex]);
                    usedIndices.add(childIndex);
                }
            }
            clusteredFeed.push(parent);
        });

        // Falls die KI Artikel vergessen hat (sollte nicht passieren, aber sicher ist sicher)
        flatFeed.forEach((item, index) => {
            if (!usedIndices.has(index)) {
                console.log(`⚠️ KI hat Item ${index} vergessen, füge manuell hinzu.`);
                item.related = [];
                clusteredFeed.push(item);
            }
        });

        return clusteredFeed;

    } catch (e) {
        console.error("❌ KI-Clustering fehlgeschlagen:", e.message);
        console.log("fallback auf manuelles Clustering...");
        return manualClusterFallback(flatFeed);
    }
}

// Fallback (dein alter Code), falls KI abstürzt
function manualClusterFallback(allNews) {
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
            if (isRelatedTopicFallback(item.originalTitle, candidate.originalTitle)) {
                group.push(candidate);
                processedIds.add(candidate.id);
            }
        }
        let parent = group[0];
        parent.related = [];
        for (let k = 1; k < group.length; k++) parent.related.push(group[k]);
        clustered.push(parent);
    }
    return clustered;
}

async function run() {
    console.log("🚀 Starte News-Abruf (AI Cluster Edition)...");
    
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
                // Deduplizierung (Exakt gleicher Link oder Titel)
                const existingIndex = flatFeed.findIndex(n => n.link === item.link || n.originalTitle === item.title);
                if (existingIndex !== -1) {
                    flatFeed[existingIndex].date = item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString();
                    continue; 
                }

                console.log(`🤖 Neu: ${item.title.substring(0, 30)}...`);
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
                await sleep(8000); // 8s Pause reicht, da wir am Ende eh nochmal Zeit für Cluster brauchen
            }
        } catch (e) { console.error(`❌ Fehler bei ${source.name}:`, e.message); }
    }

    // --- HIER KOMMT DIE MAGIE ---
    // Wir übergeben ALLES an die KI zum Sortieren
    const finalFeed = await groupNewsWithAI(flatFeed);
    
    // Sortieren (Neueste Cluster oben)
    finalFeed.sort((a, b) => new Date(b.date) - new Date(a.date));

    fs.writeFileSync('news.json', JSON.stringify(finalFeed, null, 2));
    console.log(`✅ Fertig! ${finalFeed.length} Themen-Cluster.`);
}

run();
