const Parser = require('rss-parser');
const axios = require('axios');
const fs = require('fs');

const parser = new Parser();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- HELPER: HTML ENTITIES DECODIEREN ---
function decodeEntities(text) {
    if (!text) return "";
    return text
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&szlig;/g, 'ß')
        .replace(/&auml;/g, 'ä')
        .replace(/&ouml;/g, 'ö')
        .replace(/&uuml;/g, 'ü')
        .replace(/&Auml;/g, 'Ä')
        .replace(/&Ouml;/g, 'Ö')
        .replace(/&Uuml;/g, 'Ü')
        .replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(dec));
}

// --- HELPER: HTML TAGS ENTFERNEN ---
function stripTags(html) {
    return html.replace(/<[^>]+>/g, "").trim();
}

// --- CORE: PRÄZISER SCRAPER ---
async function fetchArticleText(url) {
    try {
        const { data } = await axios.get(url, { 
            timeout: 8000, 
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' 
            }
        });

        let html = data;

        const junkTags = ['script', 'style', 'nav', 'footer', 'header', 'aside', 'form', 'iframe', 'noscript', 'button', 'input', 'figure', 'figcaption', 'style'];
        junkTags.forEach(tag => {
            const regex = new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
            html = html.replace(regex, '');
        });

        const containerMatch = html.match(/<article[^>]*>([\s\\S]*?)<\/article>/i) || html.match(/<main[^>]*>([\s\\S]*?)<\/main>/i);
        if (!containerMatch) return ""; 

        let contentScope = containerMatch[1];
        let paragraphs = extractParagraphs(contentScope);
        let fullText = paragraphs.join('\n\n');
        
        fullText = decodeEntities(fullText);
        if (fullText.length > 15000) fullText = fullText.substring(0, 15000);
        
        return fullText;
    } catch (e) { return ""; }
}

function extractParagraphs(htmlContent) {
    const pRegex = /<p[^>]*>([\s\\S]*?)<\/p>/gi;
    let paragraphs = [];
    let match;
    while ((match = pRegex.exec(htmlContent)) !== null) {
        let rawText = match[1];
        let cleanText = stripTags(rawText);
        if (isValidParagraph(cleanText)) paragraphs.push(cleanText);
    }
    return paragraphs;
}

function isValidParagraph(text) {
    text = text.trim();
    if (text.length < 50) return false; 
    const lower = text.toLowerCase();
    const blacklist = [
        "alle rechte vorbehalten", "mehr zum thema", "lesen sie auch", 
        "melden sie sich an", "newsletter", "anzeige", "datenschutz", 
        "impressum", "quelle:", "bild:", "foto:", "video:", 
        "akzeptieren", "cookie", "javascript", "werbung", "zum seitenanfang",
        "copyright", "©"
    ];
    if (blacklist.some(bad => lower.includes(bad))) return false;
    return true;
}

// --- UTILS ---
function cleanString(str) {
    if (!str) return "";
    return str.replace(/\s+/g, ' ').trim();
}

function isSameArticle(item1, item2) {
    if (item1.link === item2.link) return true;
    const t1 = cleanString(item1.originalTitle || item1.title).toLowerCase();
    const t2 = cleanString(item2.title).toLowerCase();
    return t1 === t2 || (t1.includes(t2) && t1.length - t2.length < 10);
}

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

function isRelatedTopicAlgorithmic(title1, title2) {
    const clean1 = cleanString(title1).toLowerCase();
    const clean2 = cleanString(title2).toLowerCase();
    const stopWords = ["und", "der", "die", "das", "mit", "von", "für", "auf", "den", "im", "in", "ist", "hat", "zu", "eine", "ein", "bei", "nach", "gegen", "über", "video", "liveblog", "ticker"];
    const getWords = (t) => t.split(' ').filter(w => w.length > 3 && !stopWords.includes(w));
    const words1 = getWords(clean1);
    const words2 = getWords(clean2);
    let matches = 0;
    words1.forEach(w1 => { if (words2.some(w2 => w2.includes(w1) || w1.includes(w2))) matches++; });
    if (words1.length < 3 || words2.length < 3) return false; 
    return matches >= 2;
}

function loadExistingNews() {
    try {
        if (fs.existsSync('news.json')) return JSON.parse(fs.readFileSync('news.json', 'utf8'));
    } catch (e) { }
    return [];
}

async function analyzeWithPollinations(title, fullText, sourceName) {
    const context = fullText && fullText.length > 500 ? fullText.substring(0, 5000) : title;
    
    const instruction = `Du bist News-Redakteur.
    Analysiere diesen Text: "${context.replace(/"/g, "'").substring(0, 4000)}"
    
    Antworte NUR mit validem JSON.
    ANWEISUNG:
    1. Sprache: ZWINGEND DEUTSCH.
    2. Titel: Sachlich, neutral (kein Clickbait).
    3. Scoop: Sehr kurze Zusammenfassung (max 2 Sätze).
    4. Bullets: Die 3 wichtigsten Fakten.

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
            try { const deepSeekObj = JSON.parse(rawText); if (deepSeekObj.content) rawText = deepSeekObj.content; } catch (e) { }
            
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
        } catch (error) { await sleep(2000); retries--; }
    }
    return { summary: title, newTitle: title, bullets: [], tags: [sourceName] };
}

async function clusterBatchWithAI(batchArticles, batchIndex) {
    console.log(`📦 Batch ${batchIndex + 1}: KI sortiert ${batchArticles.length} Artikel...`);
    const listForAI = batchArticles.map((a, index) => `ID ${index}: ${a.newTitle || a.title}`).join("\n");
    const instruction = `Gruppiere Nachrichten zum EXAKT gleichen Ereignis. 
    Antworte NUR JSON: [[ID, ID], [ID]]. 
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
            let bestParentIndex = validIndices.findIndex(idx => batchArticles[idx].img) !== -1 ? validIndices.findIndex(idx => batchArticles[idx].img) : 0;
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
        batchArticles.forEach((item, index) => { if (!usedIndices.has(index)) { item.related = []; localClusters.push(item); } });
        return localClusters;
    } catch (e) { return batchArticles.map(a => { a.related = []; return a; }); }
}

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
                    } else { existingCluster.related.push(newCluster, ...(newCluster.related || [])); }
                    matched = true; break;
                }
            }
            if (!matched) finalClusters.push(newCluster);
        }
        await sleep(1000);
    }
    return finalClusters;
}

// --- MAIN LOOP MIT DEBUG-LOGS ---
async function run() {
    console.log("🚀 Start News-Bot v4.1 (Debug Mode)...");
    
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
            console.log(`\n📡 ${source.name} (Ziel: ${source.count} Artikel)...`);
            const feed = await parser.parseURL(source.url);
            let added = 0;
            let skipped = 0;

            for (const item of feed.items) {
                if (added >= source.count) break;
                if (skipped >= 5) { console.log(`   🛑 Zu viele Skips (${skipped}) bei ${source.name}. Breche Quelle ab.`); break; }

                const exists = flatFeed.some(n => isSameArticle(n, item));
                if (exists) {
                    console.log(`   ⏩ Skip (Cache): ${item.title.substring(0, 40)}...`);
                    skipped++;
                    continue;
                }

                let fullText = "";
                if (source.scrape !== false) {
                    fullText = await fetchArticleText(item.link);
                    if (fullText.length < 500) {
                        console.log(`   ❌ Skip (zu wenig Text: ${fullText.length}): ${item.title.substring(0, 40)}...`);
                        skipped++;
                        continue;
                    }
                } else {
                    fullText = (item.contentSnippet || item.content || "").substring(0, 5000);
                }
                
                console.log(`   ✅ Verarbeite: ${item.title.substring(0, 40)}... (${fullText.length} Zeichen)`);
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
                    content: fullText, 
                    related: []
                });
                added++;
                skipped = 0;
                await sleep(4000); 
            }
        } catch (e) { console.error(`   ❌ Error ${source.name}: ${e.message}`); }
    }

    flatFeed = pruneNews(flatFeed);
    flatFeed.sort((a, b) => new Date(b.date) - new Date(a.date));
    if (flatFeed.length > 120) {
        console.log(`✂️ Cleanup: Behalte Top 120.`);
        flatFeed = flatFeed.slice(0, 120);
    }

    const finalFeed = await runClusteringPipeline(flatFeed);
    fs.writeFileSync('news.json', JSON.stringify(finalFeed, null, 2));
    console.log(`✅ Fertig! ${finalFeed.length} Cluster gespeichert.`);
}

run();
