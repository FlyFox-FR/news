const Parser = require('rss-parser');
const axios = require('axios');
const fs = require('fs');

const parser = new Parser();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- HELPER: TEXT BEREINIGUNG ---
function cleanString(str) {
    if (!str) return "";
    return str.replace(/\s+/g, ' ').trim();
}

// --- HELPER: HTML TAGS ENTFERNEN ---
function stripTags(html) {
    return html.replace(/<[^>]+>/g, "").trim();
}

// --- CORE: INTELLIGENTER SCRAPER ---
async function fetchArticleText(url) {
    try {
        const { data } = await axios.get(url, { 
            timeout: 8000, // Etwas mehr Zeit für große Seiten
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' 
            }
        });

        let html = data;

        // 1. Müll entfernen (Scripts, Styles, Navigation, Footer, Werbung)
        // Wir entfernen komplette Blöcke, die oft stören
        const junkTags = ['script', 'style', 'nav', 'footer', 'header', 'aside', 'form', 'iframe', 'noscript'];
        junkTags.forEach(tag => {
            const regex = new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
            html = html.replace(regex, '');
        });

        // 2. Fokus auf den Hauptinhalt
        // Versuche, den <article> oder <main> Bereich zu finden. Das eliminiert Sidebars fast immer.
        const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i) || 
                             html.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ||
                             html.match(/<div[^>]*class="[^"]*(content|article|body|entry)[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

        // Wenn wir einen Hauptbereich finden, nutzen wir nur den. Sonst bleiben wir beim Body.
        let contentScope = articleMatch ? articleMatch[1] : html;

        // 3. Absätze extrahieren (<p>)
        // Wir suchen spezifisch nach <p> Tags, da News-Artikel fast immer darin stehen.
        const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
        let paragraphs = [];
        let match;

        while ((match = pRegex.exec(contentScope)) !== null) {
            let rawText = match[1];
            
            // Text säubern (Tags innerhalb des p entfernen, z.B. <a> oder <b>)
            let cleanText = stripTags(rawText);

            // 4. Qualitäts-Filter für jeden Absatz
            // Wir wollen keine "Mehr zum Thema"-Links, Social Media Buttons oder Einzeiler
            if (isValidParagraph(cleanText)) {
                paragraphs.push(cleanText);
            }
        }

        // Wenn wir über <p> nichts gefunden haben (selten), versuchen wir Blocksatz
        if (paragraphs.length < 2) {
            return stripTags(contentScope).substring(0, 5000); // Fallback: Einfach alles textuelle
        }

        // Zusammenfügen mit doppelten Zeilenumbrüchen für Lesbarkeit
        return paragraphs.join('\n\n').substring(0, 15000); // Limit auf 15k Zeichen erhöht

    } catch (e) {
        console.log(`⚠️ Skip Text für ${url}: ${e.message}`);
        return "";
    }
}

// Filtert Müll-Absätze heraus
function isValidParagraph(text) {
    if (text.length < 50) return false; // Zu kurz (oft Menüpunkte oder Bildunterschriften)
    if (text.includes("Copyright")) return false;
    if (text.includes("Alle Rechte vorbehalten")) return false;
    if (text.includes("Mehr zum Thema")) return false;
    if (text.includes("Lesen Sie auch")) return false;
    if (text.includes("Melden Sie sich an")) return false;
    return true;
}

// Prüft auf Duplikate
function isSameArticle(item1, item2) {
    if (item1.link === item2.link) return true;
    const t1 = cleanString(item1.originalTitle || item1.title).toLowerCase();
    const t2 = cleanString(item2.title).toLowerCase();
    return t1 === t2 || (t1.includes(t2) && t1.length - t2.length < 10);
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
    const clean1 = cleanString(title1).toLowerCase();
    const clean2 = cleanString(title2).toLowerCase();
    
    const stopWords = ["und", "der", "die", "das", "mit", "von", "für", "auf", "den", "im", "in", "ist", "hat", "zu", "eine", "ein", "bei", "nach", "gegen", "über", "video"];
    const getWords = (t) => t.split(' ').filter(w => w.length > 3 && !stopWords.includes(w));
    
    const words1 = getWords(clean1);
    const words2 = getWords(clean2);
    
    let matches = 0;
    words1.forEach(w1 => { if (words2.some(w2 => w2.includes(w1) || w1.includes(w2))) matches++; });
    
    // Strengere Matching-Regeln
    if (words1.length < 3 || words2.length < 3) return false; 
    return matches >= 2;
}

function loadExistingNews() {
    try {
        if (fs.existsSync('news.json')) return JSON.parse(fs.readFileSync('news.json', 'utf8'));
    } catch (e) { }
    return [];
}

// 1. INHALTS-ANALYSE
async function analyzeWithPollinations(title, fullText, sourceName) {
    // Kontext massiv erweitert auf 6000 Zeichen für die KI
    const context = fullText && fullText.length > 200 ? fullText.substring(0, 6000) : title;
    
    const instruction = `Du bist News-Redakteur.
    Analysiere diesen Text: "${context.replace(/"/g, "'").substring(0, 4500)}"
    
    Antworte NUR mit validem JSON.
    ANWEISUNG:
    1. Sprache: ZWINGEND DEUTSCH.
    2. Titel: Sachlich, kurz, KEIN Clickbait.
    3. Scoop: Eine prägnante Zusammenfassung (max 2 Sätze).
    4. Bullets: 3-4 wichtigste Fakten (Zahlen, Orte, Namen).

    Format:
    {
      "newTitle": "Titel",
      "scoop": "Zusammenfassung",
      "bullets": ["Punkt 1", "Punkt 2", "Punkt 3"]
    }`
    
    const url = `https://text.pollinations.ai/${encodeURIComponent(instruction)}?model=openai&seed=${Math.floor(Math.random() * 10000)}`;

    let retries = 2;
    while (retries > 0) {
        try {
            const response = await axios.get(url, { timeout: 45000 });
            let rawText = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);

            try {
                const deepSeekObj = JSON.parse(rawText);
                if (deepSeekObj.content) rawText = deepSeekObj.content;
            } catch (e) { }

            rawText = rawText.split("--- Support")[0].replace(/```json|```/g, "").trim();
            const firstOpen = rawText.indexOf('{');
            const lastClose = rawText.lastIndexOf('}');
            if (firstOpen !== -1 && lastClose !== -1) rawText = rawText.substring(firstOpen, lastClose + 1);

            let data;
            try { data = JSON.parse(rawText); } catch (e) { throw new Error("JSON Error"); }
            if (!data.bullets) data.bullets = [];
            
            return { 
                summary: data.scoop || title, 
                newTitle: data.newTitle || title, 
                bullets: data.bullets, 
                tags: [sourceName, "News"] 
            };

        } catch (error) {
            await sleep(2000); retries--;
        }
    }
    return { summary: title, newTitle: title, bullets: [], tags: [sourceName] };
}

// 2. KI CLUSTERING
async function clusterBatchWithAI(batchArticles, batchIndex) {
    console.log(`📦 Batch ${batchIndex + 1}: KI sortiert ${batchArticles.length} Artikel...`);
    // Wir senden nur Titel an die KI zum Clustern, um Token zu sparen
    const listForAI = batchArticles.map((a, index) => `ID ${index}: ${a.newTitle || a.title}`).join("\n");
    
    const instruction = `Gruppiere Nachrichten zum EXAKT gleichen Ereignis. 
    Antworte NUR JSON: [[ID, ID], [ID]]. 
    Ignoriere thematisch ähnliche, aber unterschiedliche Events.
    Liste:\n${listForAI}`;
    
    const url = `https://text.pollinations.ai/${encodeURIComponent(instruction)}?model=openai&seed=${Math.floor(Math.random() * 1000)}`;

    try {
        const response = await axios.get(url, { timeout: 60000 });
        let rawText = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
        try { const j = JSON.parse(rawText); if (j.content) rawText = j.content; } catch (e) {}
        
        const arrayMatch = rawText.match(/\[\s*\[[\d\s,\[\]]*\]\s*\]/s);
        let groups = arrayMatch ? JSON.parse(arrayMatch[0]) : null;

        if (!Array.isArray(groups)) throw new Error("Kein Array");

        let localClusters = [];
        let usedIndices = new Set();

        groups.forEach(groupIndices => {
            if (!Array.isArray(groupIndices)) return;
            let validIndices = groupIndices.filter(i => batchArticles[i] !== undefined);
            if (validIndices.length === 0) return;

            // Wähle Artikel mit Bild als Hauptartikel
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

// --- PIPELINE ---
async function runClusteringPipeline(allArticles) {
    const BATCH_SIZE = 15;
    let finalClusters = [];

    for (let i = 0; i < allArticles.length; i += BATCH_SIZE) {
        const batch = allArticles.slice(i, i + BATCH_SIZE);
        const batchClusters = await clusterBatchWithAI(batch, Math.floor(i / BATCH_SIZE));
        
        for (const newCluster of batchClusters) {
            let matched = false;
            for (const existingCluster of finalClusters) {
                // Hier nutzen wir den strengeren Algorithmus
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
        await sleep(1000);
    }
    return finalClusters;
}

// --- MAIN ---
async function run() {
    console.log("🚀 Start News-Bot v3 (Deep Scrape)...");
    
    let sources = [];
    try { sources = JSON.parse(fs.readFileSync('sources.json', 'utf8')); } 
    catch(e) { sources = [{ name: "Tagesschau", url: "https://www.tagesschau.de/xml/rss2/", count: 3 }]; }

    let existingNews = loadExistingNews();
    existingNews = pruneNews(existingNews);

    let flatFeed = [];
    existingNews.forEach(item => {
        let clean = { ...item }; delete clean.related; flatFeed.push(clean);
        if (item.related) item.related.forEach(c => flatFeed.push(c));
    });

    for (const source of sources) {
        try {
            console.log(`\n📡 ${source.name}...`);
            const feed = await parser.parseURL(source.url);
            let added = 0;

            for (const item of feed.items) {
                if (added >= source.count) break;

                const exists = flatFeed.some(n => isSameArticle(n, item));
                if (exists) continue;

                console.log(`   📄 Lade Text: ${item.title.substring(0, 40)}...`);
                
                // DER NEUE SCRAPER CALL
                const fullText = await fetchArticleText(item.link);
                console.log(`      ✅ ${fullText.length} Zeichen extrahiert.`);

                const ai = await analyzeWithPollinations(item.title, fullText, source.name);
                
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
                    content: fullText, // Der saubere, lange Text
                    related: []
                });
                added++;
                await sleep(4000); 
            }
        } catch (e) { console.error(`   ❌ Error ${source.name}: ${e.message}`); }
    }

    flatFeed = pruneNews(flatFeed);
    flatFeed.sort((a, b) => new Date(b.date) - new Date(a.date));
    if (flatFeed.length > 60) flatFeed = flatFeed.slice(0, 60);

    const finalFeed = await runClusteringPipeline(flatFeed);
    
    fs.writeFileSync('news.json', JSON.stringify(finalFeed, null, 2));
    console.log(`✅ Fertig! ${finalFeed.length} Cluster gespeichert.`);
}

run();
