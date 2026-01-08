const Parser = require('rss-parser');
const axios = require('axios');
const fs = require('fs');

const parser = new Parser();

async function getNews() {
    let allNews = [];

    // 1. Tagesschau (JSON)
    try {
        const tagesschau = await axios.get('https://www.tagesschau.de/api2/news/');
        // Wir nehmen die ersten 5 News
        const tsItems = tagesschau.data.news.slice(0, 5).map(item => ({
            source: 'Tagesschau',
            title: item.title,
            link: item.shareURL, // oder item.detailsweb
            img: item.teaserImage?.imageVariants?.['16x9-1920'] || null,
            date: item.date
        }));
        allNews = [...allNews, ...tsItems];
    } catch (e) { console.error("Fehler Tagesschau", e); }

    // 2. ZDF Nachrichten (RSS)
    try {
        const feed = await parser.parseURL('https://www.zdf.de/rss/zdf/nachrichten');
        const zdfItems = feed.items.slice(0, 5).map(item => ({
            source: 'ZDF',
            title: item.title,
            link: item.link,
            img: item.enclosure?.url || null, // RSS Bilder sind oft hier
            date: item.pubDate
        }));
        allNews = [...allNews, ...zdfItems];
    } catch (e) { console.error("Fehler ZDF", e); }

    // Alles speichern in 'news.json'
    fs.writeFileSync('news.json', JSON.stringify(allNews, null, 2));
    console.log("News erfolgreich aktualisiert!");
}

getNews();
