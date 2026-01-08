const Parser = require('rss-parser');
const axios = require('axios');
const fs = require('fs');

const parser = new Parser();

// Konfiguration
const AI_MODEL = "mistralai/Mistral-7B-Instruct-v0.3"; 
const HF_TOKEN = process.env.HF_TOKEN; 
const NEWS_COUNT_PER_SOURCE = 4; // Nicht zu hoch setzen wegen API-Limits

// Hilfsfunktion: Pause (um Rate-Limits zu vermeiden)
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Funktion: KI-Zusammenfassung
async function summarizeWithAI(title, content) {
    if (!HF_TOKEN) return content; // Fallback ohne Token

    // Prompt: Strikt Anweisung für Deutsch und Kürze
    const prompt = `<s>[INST] Du bist ein Nachrichten-Redakteur. Fasse die folgende Nachricht in einem einzigen, kurzen deutschen Satz zusammen. Antworte NUR mit der Zusammenfassung, ohne Einleitung.
    
    Titel: ${title}
    Inhalt: ${content}
    
    Zusammenfassung: [/INST]`;

    try {
        const response = await axios.post(
            `https://api-inference.huggingface.co/models/${AI_MODEL}`,
            { 
                inputs: prompt,
                parameters: {
                    max_new_tokens: 100, // Begrenzt die Antwortlänge
                    return_full_text: false // Gibt nur die Antwort zurück, nicht den Prompt
                }
            },
            {
                headers: { Authorization: `Bearer ${HF_TOKEN}` },
                timeout: 15000 // 15 Sekunden Timeout
            }
        );

        let summary = response.data[0]?.generated_text || content;
        return summary.trim();

    } catch (error) {
        console.log(`⚠️ KI-Fehler bei "${title.substring(0, 20)}...":`, error.response?.status || error.message);
        return content; // Fallback auf Originaltext
    }
}

async function getNews() {
    console.log("🚀 Starte News-Abruf...");
    let allNews = [];

    // --- QUELLE 1: TAGESSCHAU ---
    try {
        console.log("Lade Tagesschau...");
        const tagesschau = await axios.get('https://www.tagesschau.de/api2/news/');
        const tsItems = tagesschau.data.news.slice(0, NEWS_COUNT_PER_SOURCE);

        for (const item of tsItems) {
            const originalText = item.firstSentence || item.title;
            const summary = await summarizeWithAI(item.title, originalText);
            
            allNews.push({
                source: 'Tagesschau',
                title: item.title,
                text: summary,
                link: item.shareURL,
                img: item.teaserImage?.imageVariants?.['16x9-1920'] || null,
                date: item.date
            });
            await sleep(1500); // Pause für die API
        }
    } catch (e) { console.error("❌ Fehler Tagesschau", e.message); }

    // --- QUELLE 2: ZDF ---
    try {
        console.log("Lade ZDF...");
        const feed = await parser.parseURL('https://www.zdf.de/rss/zdf/nachrichten');
        const zdfItems = feed.items.slice(0, NEWS_COUNT_PER_SOURCE);

        for (const item of zdfItems) {
            const originalText = item.contentSnippet || item.title;
            const summary = await summarizeWithAI(item.title, originalText);

            allNews.push({
                source: 'ZDF',
                title: item.title,
                text: summary,
                link: item.link,
                img: item.enclosure?.url || null, // ZDF packt Bilder oft hier rein
                date: item.pubDate
            });
            await sleep(1500);
        }
    } catch (e) { console.error("❌ Fehler ZDF", e.message); }

    // Speichern
    fs.writeFileSync('news.json', JSON.stringify(allNews, null, 2));
    console.log(`✅ Fertig! ${allNews.length} Nachrichten gespeichert.`);
}

getNews();
