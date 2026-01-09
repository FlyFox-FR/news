const Parser = require('rss-parser');
const axios = require('axios');
const fs = require('fs');
const cheerio = require('cheerio');

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

// --- NEU: VOLLTEXT EXTRAKTION ---
async function fetchFullText(url) {
    try {
        const response = await axios.get(url, { 
            timeout: 10000, 
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } 
        });
        const $ = cheerio.load(response.data);
        $('script, style, nav, footer, header, ads, .ads, .paywall').remove();
        
        let text = $('article').text() || $('.article-body').text() || $('main').text() || $('body').text();
        text = text.replace(/\s+/g, ' ').trim();
        
        if (text.length < 500) return null; // Wahrscheinlich Paywall oder Fehler
        return text.substring(0, 3500); // Limit für JSON Größe
    } catch (e) { return null; }
}

// --- NEU: DAILY BRIEFING GENERIEREN ---
async function generateDailyBriefing(clusters) {
    const titles = clusters.slice(0, 12).map(c => c.title).join(" | ");
    const prompt = `Fasse die aktuelle Weltlage basierend auf diesen Schlagzeilen in maximal 3 prägnanten, professionellen Sätzen zusammen. Sprache: Deutsch. Schlagzeilen: ${titles}`;
    
    try {
        const res = await axios.get(`https://text.pollinations.ai/${encodeURIComponent(prompt)}?model=openai&seed=${Math.floor(Math.random()*100)}`);
        return res.data;
    } catch (e) { return "Hier sind die aktuellsten Nachrichten für dich zusammengefasst."; }
}

// --- PRUNING ---
function pruneData(dataObj) {
    const now = new Date();
    const twentyFourHours = 24 * 60 * 60 * 1000;
    
    // 1. Ganze Artikel löschen die älter als 48h sind
    const cutoffOld = now - (twentyFourHours * 2);
    dataObj.news = dataObj.news.filter(item => new Date(item.date) > cutoffOld);

    // 2. Volltexte löschen die älter als 24h sind (Speicherplatz sparen)
    const cutoffFullText = now - twentyFourHours;
    dataObj.news = dataObj.news.map(item => {
        if (new Date(item.date) < cutoffFullText) delete item.fullText;
        if (item.related) {
            item.related = item.related.map(r => {
                if (new Date(r.date) < cutoffFullText) delete r.fullText;
                return r;
            });
        }
        return item;
    });
    return dataObj;
}

// --- KI ANALYSE ---
async function analyzeWithPollinations(title, content, sourceName) {
    const safeContent = (content || "").substring(0, 1000);
    const instruction = `Analysiere: "${title} - ${safeContent}". Antworte NUR JSON: {"newTitle":"...","scoop":"...","bullets":["..."]}. Sprache: Deutsch.`;
    const url = `https://text.pollinations.ai/${encodeURIComponent(instruction)}?model=openai`;

    try {
        const response = await axios.get(url, { timeout: 30000 });
        let rawText = response.data;
        rawText = rawText.replace(/```json|```/g, "").trim();
        const data = JSON.parse(rawText);
        return { summary: data.scoop || title, newTitle: data.newTitle || title, bullets: data.bullets || [] };
    } catch (e) {
        return { summary: title, newTitle: title, bullets: [] };
    }
}

async function run() {
    console.log("🚀 Starte News-Engine...");
    
    let sources = [];
    try { sources = JSON.parse(fs.readFileSync('sources.json', 'utf8')); } 
    catch(e) { sources = [{ name: "Tagesschau", url: "https://www.tagesschau.de/xml/rss2/", count: 3 }]; }

    let newsDB = { briefing: "", news: [] };
    if (fs.existsSync('news.json')) {
        newsDB = JSON.parse(fs.readFileSync('news.json', 'utf8'));
        if (!newsDB.news) newsDB = { briefing: "", news: newsDB }; // Migration
    }

    // 1. Pruning
    newsDB = pruneData(newsDB);
    let flatFeed = [];
    newsDB.news.forEach(item => {
        let cleanItem = { ...item };
        delete cleanItem.related;
        flatFeed.push(cleanItem);
        if (item.related) item.related.forEach(child => flatFeed.push(child));
    });

    // 2. Neue Artikel holen
    for (const source of sources) {
        try {
            console.log(`📡 ${source.name}...`);
            const feed = await parser.parseURL(source.url);
            let added = 0;
            for (const item of feed.items) {
                if (added >= source.count) break;
                if (flatFeed.some(n => isSameArticle(n, item))) continue;

                const fullText = await fetchFullText(item.link);
                const ai = await analyzeWithPollinations(item.title, fullText || item.contentSnippet, source.name);

                flatFeed.push({
                    id: Math.random().toString(36).substr(2, 9),
                    source: source.name,
                    title: ai.newTitle,
                    link: item.link,
                    date: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
                    text: ai.summary,
                    bullets: ai.bullets,
                    fullText: fullText,
                    img: item.enclosure?.url || null
                });
                added++;
                await sleep(5000);
            }
        } catch (e) { console.error(e.message); }
    }

    // 3. Briefing & Speichern
    flatFeed.sort((a, b) => new Date(b.date) - new Date(a.date));
    const finalFeed = flatFeed.slice(0, 100); // Cluster-Logik hier vereinfacht für Stabilität
    const briefing = await generateDailyBriefing(finalFeed);

    const output = {
        briefing: briefing,
        news: finalFeed,
        lastUpdate: new Date().toISOString()
    };

    fs.writeFileSync('news.json', JSON.stringify(output, null, 2));
    console.log("✅ Update abgeschlossen.");
}

run();
