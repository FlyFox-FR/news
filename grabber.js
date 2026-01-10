const Parser = require('rss-parser');
const axios = require('axios');
const fs = require('fs');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');

const parser = new Parser();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- KONFIGURATION ---
const MAX_DAYS = 4; 
const MAX_ITEMS = 600; 
const MAX_CHARS_SAVE = 30000; 
const MAX_CHARS_AI = process.env.OPENAI_API_KEY ? 15000 : 5500;    

// --- LOGGER STATE ---
let currentRunLog = { 
    timestamp: new Date().toISOString(), 
    ai_provider: process.env.OPENAI_API_KEY ? "OpenAI (GPT-4o-mini) ⭐" : "Pollinations (Free) 🐌",
    total_tokens: 0,
    sources: {} 
};

function logEvent(source, type, detail) {
    if (!currentRunLog.sources[source]) currentRunLog.sources[source] = { added: 0, skipped_cache: 0, skipped_content: 0, error: 0, details: [] };
    const s = currentRunLog.sources[source];
    if (type.startsWith('added')) s.added++;
    if (type === 'cache') s.skipped_cache++;
    if (type === 'content') s.skipped_content++;
    if (type === 'error') s.error++;
    if (detail) s.details.push(detail);
}

// --- HELPER ---
function cleanString(str) { return str ? str.replace(/\s+/g, ' ').trim() : ""; }

// --- SCRAPER (MOZILLA READABILITY ENGINE) ---
async function fetchArticleText(url, sourceName) {
    try {
        // 1. Download
        const { data } = await axios.get(url, { 
            timeout: 10000, 
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' 
            } 
        });
        let html = data;

        // 2. GIFT-LISTE (Poison Check)
        // Bevor wir parsen: Prüfen auf Paywall-Marker oder Fehlerseiten.
        // Besonders wichtig für Spiegel, da Readability sonst den "Leider kein Abo"-Text extrahiert.
        if (sourceName.toLowerCase().includes("spiegel")) {
            const poisonPhrases = [
                'data-paywall="true"',
                'spiegel-plus-logo',
                'Zugriff auf Artikel nicht mehr möglich',
                'Diesen Artikel weiterlesen mit SPIEGEL+',
                'Sie haben bereits ein Digital-Abo',
                'Freier Zugriff auf alle S+-Artikel',
                'isMonthlyProductLoading',
                '€ 4,49 pro Woche',
                'Nur für Neukunden'
            ];
            
            if (poisonPhrases.some(p => html.includes(p))) {
                return null; // Null bedeutet: Fallback auf RSS nutzen
            }
        }

        // 3. JSDOM & READABILITY
        // Wir erstellen ein virtuelles DOM, damit Readability arbeiten kann
        const doc = new JSDOM(html, { url: url });
        const reader = new Readability(doc.window.document);
        const article = reader.parse();

        // 4. VALIDIERUNG
        if (!article || !article.textContent) return null;

        let fullText = article.textContent;

        // 5. CLEANUP (Die "Waschmaschine")
        // Readability lässt oft viele Leerzeilen übrig.
        fullText = fullText.replace(/\n\s*\n/g, '\n\n'); // Max 1 Leerzeile am Stück
        fullText = fullText.replace(/[ \t]+/g, ' ');      // Keine doppelten Leerzeichen
        fullText = fullText.trim();

        // 6. SANITY CHECK
        // Wenn der Text extrem kurz ist (z.B. nur "Impressum"), war es kein Artikel.
        if (fullText.length < 300) return null;

        // Sicherheitscheck: Hat sich Spiegel-Werbung trotzdem eingeschlichen?
        if (sourceName.toLowerCase().includes("spiegel") && fullText.includes("Freier Zugriff auf alle S+-Artikel")) {
            return null;
        }

        if (fullText.length > MAX_CHARS_SAVE) fullText = fullText.substring(0, MAX_CHARS_SAVE);
        return fullText;

    } catch (e) { 
        // Bei Timeout oder Parse-Fehlern -> null zurückgeben für Fallback
        return null; 
    }
}

// --- LOGIC ---
function isSameArticle(item1, item2) {
    if (item1.link === item2.link) return true;
    const t1 = cleanString(item1.originalTitle || item1.title).toLowerCase();
    const t2 = cleanString(item2.title).toLowerCase();
    return t1 === t2 || (t1.includes(t2) && t1.length - t2.length < 10);
}

function pruneNews(newsArray) {
    const now = new Date();
    const retentionMs = MAX_DAYS * 24 * 60 * 60 * 1000; 
    return newsArray.filter(item => (now - new Date(item.date)) < retentionMs);
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
    try { if (fs.existsSync('news.json')) return JSON.parse(fs.readFileSync('news.json', 'utf8')); } catch (e) { }
    return [];
}

// --- AI ENGINE (ANALYSIS) ---
async function analyzeArticle(title, fullText, sourceName) {
    const context = fullText && fullText.length > 200 ? fullText.substring(0, MAX_CHARS_AI) : title;
    const safeTitle = title.replace(/"/g, "'");
    const safeContext = context.replace(/"/g, "'");

    const systemPrompt = `Du bist ein sehr erfahrener Nachrichten-Redakteur für eine Qualitätszeitung.
    Deine Aufgabe: Fasse den vorliegenden Artikeltext prägnante und absolut faktengetreu zusammen.
    
    REGELN:
    1. Sprache: Perfektes Deutsch, grammatikalisch einwandfrei (Duden-Standard).
    2. Stil: Sachlich, neutral, journalistisch. Keine eigene Meinung.
    3. Inhalt: Fasse NUR zusammen, was im Text steht. Erfinde NIEMALS Fakten oder Zusammenhänge (keine Halluzinationen).
    4. Wenn der Input-Text unverständlich ist oder abbricht, gib eine sehr kurze, generische Zusammenfassung basierend auf dem Titel.

    Antworte NUR mit diesem JSON Format:
    {
      "newTitle": "Ein sachlicher, kurzer Titel (max 80 Zeichen)",
      "scoop": "Die Kernaussage in 1-2 Sätzen. Konzentriere dich auf das 'Was' und 'Wer'.",
      "bullets": ["Wichtiges Detail 1", "Wichtiges Detail 2", "Wichtiges Detail 3"]
    }`;

    // A) OPENAI (PREMIUM LANE)
    if (process.env.OPENAI_API_KEY) {
        try {
            const response = await axios.post('https://api.openai.com/v1/chat/completions', {
                model: "gpt-4o-mini",
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: `Titel: "${safeTitle}". Inhalt: "${safeContext}"` }
                ],
                temperature: 0.1, 
                response_format: { type: "json_object" }
            }, { headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' } });
            
            if(response.data.usage) currentRunLog.total_tokens += response.data.usage.total_tokens;

            const data = JSON.parse(response.data.choices[0].message.content);
            if (!data.bullets) data.bullets = [];
            return { summary: data.scoop || title, newTitle: data.newTitle || title, bullets: data.bullets, tags: [sourceName, "News"] };

        } catch (e) { 
            console.error(`❌ OpenAI Error bei "${title.substring(0,20)}...":`, e.message);
            return null; // Skip bei Fehler
        }
    }

    // B) POLLINATIONS (Fallback - nur ohne API Key)
    const shortPrompt = `Du bist Redakteur. Schreibe perfektes Deutsch. JSON: {"newTitle": "...", "scoop": "...", "bullets": ["..."]}. Text: ${safeTitle} - ${safeContext}`;
    const shortPromptEncoded = encodeURIComponent(shortPrompt.substring(0, 1500)); 
    const url = `https://text.pollinations.ai/${shortPromptEncoded}?model=openai&seed=${Math.floor(Math.random() * 10000)}`;
    
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
            let data = JSON.parse(rawText);
            if (!data.bullets) data.bullets = [];
            return { summary: data.scoop || title, newTitle: data.newTitle || title, bullets: data.bullets, tags: [sourceName, "News"] };
        } catch (error) { await sleep(2000); retries--; }
    }
    return { summary: title, newTitle: title, bullets: [], tags: [sourceName] };
}

// --- AI ENGINE (CLUSTERING) ---
async function clusterBatchWithAI(batchArticles, batchIndex) {
    console.log(`📦 Batch ${batchIndex + 1}: KI sortiert ${batchArticles.length} Artikel...`);
    const listForAI = batchArticles.map((a, index) => `ID ${index}: ${a.newTitle || a.title}`).join("\n");
    
    const systemPrompt = `Gruppiere Nachrichten zum EXAKT gleichen Ereignis.
    Antworte NUR mit einem JSON Array von Arrays mit IDs: [[0, 2], [1], [3, 4]].
    Jede ID muss genau einmal vorkommen.`;

    if (process.env.OPENAI_API_KEY) {
        try {
            const response = await axios.post('https://api.openai.com/v1/chat/completions', {
                model: "gpt-4o-mini",
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: `Liste der Artikel:\n${listForAI}` }
                ],
                temperature: 0.1,
                response_format: { type: "json_object" }
            }, { headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' } });

            if(response.data.usage) currentRunLog.total_tokens += response.data.usage.total_tokens;
            const content = JSON.parse(response.data.choices[0].message.content);
            let groups = Array.isArray(content) ? content : Object.values(content)[0];
            return processGroups(groups, batchArticles);
        } catch (e) { 
            console.error("OpenAI Cluster Error:", e.message);
            return batchArticles.map(a => { a.related = []; return a; });
        }
    }

    const url = `https://text.pollinations.ai/${encodeURIComponent(systemPrompt + " Liste:\n" + listForAI)}?model=openai&seed=${Math.floor(Math.random() * 1000)}`;
    try {
        const response = await axios.get(url, { timeout: 60000 });
        let rawText = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
        try { const j = JSON.parse(rawText); if (j.content) rawText = j.content; } catch (e) {}
        const arrayMatch = rawText.match(/\[\s*\[[\d\s,\[\]]*\]\s*\]/s);
        let groups = arrayMatch ? JSON.parse(arrayMatch[0]) : null;
        return processGroups(groups, batchArticles);
    } catch (e) { return batchArticles.map(a => { a.related = []; return a; }); }
}

function processGroups(groups, batchArticles) {
    if (!Array.isArray(groups)) return batchArticles.map(a => { a.related = []; return a; });
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
        validIndices.forEach((idx, i) => { if (i !== bestParentIndex && !usedIndices.has(idx)) { parent.related.push(batchArticles[idx]); usedIndices.add(idx); } });
        localClusters.push(parent);
    });
    batchArticles.forEach((item, index) => { if (!usedIndices.has(index)) { item.related = []; localClusters.push(item); } });
    return localClusters;
}

async function runClusteringPipeline(allArticles) {
    const BATCH_SIZE = process.env.OPENAI_API_KEY ? 60 : 15;
    console.log(`🧩 Clustering Batch Size: ${BATCH_SIZE}`);
    let finalClusters = [];
    for (let i = 0; i < allArticles.length; i += BATCH_SIZE) {
        const batch = allArticles.slice(i, i + BATCH_SIZE);
        const batchClusters = await clusterBatchWithAI(batch, Math.floor(i / BATCH_SIZE));
        for (const newCluster of batchClusters) {
            let matched = false;
            for (const existingCluster of finalClusters) {
                if (isRelatedTopicAlgorithmic(existingCluster.title, newCluster.title)) {
                    if (!existingCluster.img && newCluster.img) { newCluster.related.push(existingCluster, ...(existingCluster.related || [])); finalClusters[finalClusters.indexOf(existingCluster)] = newCluster; } 
                    else { existingCluster.related.push(newCluster, ...(newCluster.related || [])); }
                    matched = true; break;
                }
            }
            if (!matched) finalClusters.push(newCluster);
        }
        await sleep(1000);
    }
    return finalClusters;
}

// --- MAIN LOOP ---
async function run() {
    console.log(`🚀 Start News-Bot v5.6 (Readability Edition)...`);
    
    let sources = [];
    try { sources = JSON.parse(fs.readFileSync('sources.json', 'utf8')); } catch(e) { sources = [{ name: "Tagesschau", url: "https://www.tagesschau.de/xml/rss2/", count: 3 }]; }

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
            let addedCount = 0;
            let checkedCount = 0;

            for (const item of feed.items) {
                if (addedCount >= source.count) {
                    console.log(`   🏁 Ziel erreicht (${addedCount}/${source.count}).`);
                    break;
                }

                checkedCount++;
                const cleanTitle = item.title.substring(0, 40) + "...";

                // 1. CACHE CHECK
                const exists = flatFeed.some(n => isSameArticle(n, item));
                if (exists) { 
                    console.log(`   ⏭️  [CACHE] "${cleanTitle}" schon vorhanden.`);
                    logEvent(source.name, 'cache', item.title);
                    continue; 
                }

                let fullText = "";
                let scrapedLength = 0;
                let usedFallback = false;

                // 2. SCRAPING (MOZILLA READABILITY)
                if (source.scrape !== false) {
                    let scrapedText = await fetchArticleText(item.link, source.name);
                    scrapedLength = scrapedText ? scrapedText.length : 0;
                    
                    if (scrapedLength >= 500) {
                        // A) Scrape erfolgreich
                        fullText = scrapedText;
                        process.stdout.write(`   ✅ [SCRAPE] "${cleanTitle}" geladen (${scrapedLength} Zeichen). `);
                    } else {
                        // B) Scrape fehlgeschlagen/Paywall/zu kurz -> Fallback
                        usedFallback = true;
                        fullText = (item.contentSnippet || item.content || "").trim();
                        process.stdout.write(`   ⚠️ [FALLBACK] "${cleanTitle}" Scrape null/kurz. Nutze RSS (${fullText.length} Zeichen). `);
                    }
                } else {
                    // C) Scrape aus
                    fullText = (item.contentSnippet || item.content || "").trim();
                    process.stdout.write(`   ℹ️ [RSS-ONLY] "${cleanTitle}" config says no scrape. (${fullText.length} Zeichen). `);
                }

                // 3. CHECK EMPTY
                if (!fullText || fullText.length < 50) {
                    console.log(`❌ LEER. Skip.`);
                    logEvent(source.name, 'error', 'Empty content');
                    continue;
                }

                // 4. AI ANALYSE
                const ai = await analyzeArticle(item.title, fullText, source.name);
                
                if (!ai) {
                    console.log("❌ AI FEHLER. Skip.");
                    logEvent(source.name, 'error', `AI Failed: ${item.title}`);
                    continue; 
                }

                const logType = usedFallback ? 'added_fallback' : 'added_full';
                logEvent(source.name, logType, `${item.title} (${fullText.length} chars)`);
                
                console.log("-> Hinzugefügt. 💾");

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
                    related: [],
                    isScraped: !usedFallback
                });
                
                addedCount++;
                await sleep(2000); 
            }
            
            if (addedCount === 0 && checkedCount > 0) {
                console.log(`   ⚠️ Warnung: ${checkedCount} Artikel geprüft, 0 hinzugefügt.`);
            }

        } catch (e) { 
            console.error(`   ❌ CRITICAL ERROR ${source.name}: ${e.message}`); 
            logEvent(source.name, 'error', e.message);
        }
    }

    flatFeed = pruneNews(flatFeed);
    flatFeed.sort((a, b) => new Date(b.date) - new Date(a.date));
    if (flatFeed.length > MAX_ITEMS) flatFeed = flatFeed.slice(0, MAX_ITEMS);

    const finalFeed = await runClusteringPipeline(flatFeed);
    
    fs.writeFileSync('news.json', JSON.stringify(finalFeed, null, 2));
    
    let debugLog = [];
    try { if (fs.existsSync('debug.json')) debugLog = JSON.parse(fs.readFileSync('debug.json', 'utf8')); } catch (e) {}
    debugLog.unshift(currentRunLog); 
    if (debugLog.length > 20) debugLog = debugLog.slice(0, 20); 
    fs.writeFileSync('debug.json', JSON.stringify(debugLog, null, 2));

    console.log(`✅ Fertig! ${finalFeed.length} Cluster gespeichert.`);
}

run();
