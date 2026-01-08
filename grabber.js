const Parser = require('rss-parser');
const axios = require('axios');
const fs = require('fs');

const parser = new Parser();

// Wir nutzen Mistral-7B, das ist schnell und gut in Deutsch
const AI_MODEL = "mistralai/Mistral-7B-Instruct-v0.3";
const HF_TOKEN = process.env.HF_TOKEN; // Holt den Token aus GitHub Secrets

// Funktion: Text an die KI schicken
async function summarizeWithAI(title, description) {
    if (!HF_TOKEN) return description; // Fallback, falls kein Token da ist

    const prompt = `Fasse die folgende Nachricht in einem einzigen, informativen Satz auf Deutsch zusammen. Vermeide Floskeln wie "Der Artikel handelt von".
    
    Nachricht: ${title} - ${description}
    
    Zusammenfassung:`;

    try {
        const response = await axios.post(
            `https://api-inference.huggingface.co/models/${AI_MODEL}`,
            { inputs: prompt },
            {
                headers: { Authorization: `Bearer ${HF_TOKEN}` },
                timeout: 10000 // Max 10 Sekunden warten
            }
        );

        // Die Antwort ist oft etwas wild formatiert, wir versuchen den Text zu extrahieren
        let summary = response.data[0]?.generated_text || description;
        
        // Mistral wiederholt oft den Prompt, wir schneiden ihn ab:
        if (summary.includes("Zusammenfassung:")) {
            summary = summary.split("Zusammenfassung:")[1].trim();
        }
        return summary;

    } catch (error) {
        console.log(`KI-Fehler bei "${title}":`, error.message);
        // Bei Fehler (z.B. API überlastet) geben wir einfach das Original zurück
        return description;
    }
}

async function getNews() {
    let allNews = [];

    // 1. Tagesschau
    try {
        const tagesschau = await axios.get('https://www.tagesschau.de/api2/news/');
        const tsItems = tagesschau.data.news.slice(0, 3); // Nur 3 Stück, um API zu schonen

        for (const item of tsItems) {
            // KI Zusammenfassung abrufen
            const summary = await summarizeWithAI(item.title, item.firstSentence || item.title);
            
            allNews.push({
                source: 'Tagesschau',
                title: item.title,
                text: summary, // Hier ist jetzt die KI-Version
                link: item.shareURL,
                img: item.teaserImage?.imageVariants?.['16x9-1920'] || null,
                date: item.date
            });
            // Kleine Pause, damit wir nicht geblockt werden (Rate Limit)
            await new Promise(r => setTimeout(r, 1000)); 
        }
    } catch (e) { console.error("Fehler Tagesschau", e); }

    // 2. ZDF Nachrichten
    try {
        const feed = await parser.parseURL('https://www.zdf.de/rss/zdf/nachrichten');
        const zdfItems = feed.items.slice(0, 3);

        for (const item of zdfItems) {
            const summary = await summarizeWithAI(item.title, item.contentSnippet || "");

            allNews.push({
                source: 'ZDF',
                title: item.title,
                text: summary,
                link: item.link,
                img: item.enclosure?.url || null,
                date: item.pubDate
            });
            await new Promise(r => setTimeout(r, 1000));
        }
    } catch (e) { console.error("Fehler ZDF", e); }

    fs.writeFileSync('news.json', JSON.stringify(allNews, null, 2));
    console.log("News mit KI-Zusammenfassung aktualisiert!");
}

getNews();
