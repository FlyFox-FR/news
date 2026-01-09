async function analyzeWithPollinations(title, content, sourceName) {
    // Text kürzen, HTML entfernen
    const safeContent = (content || "").substring(0, 1500).replace(/<[^>]*>/g, "");

    // --- DER NEUE, INTELLIGENTE PROMPT ---
    // Wir zwingen die KI, den Inhalt zu verstehen, statt nur zu kürzen.
    const instruction = `Du bist ein News-Analyst. 
    Analysiere diesen Text: "${title} - ${safeContent}"
    
    Aufgabe: Schreibe EINEN einzigen, informativen Satz auf Deutsch, der die Kernaussage und die Konsequenz erklärt. 
    WICHTIG: 
    1. Keine Einleitungen wie "Der Text sagt" oder "Es geht um".
    2. Schreibe aktiv und direkt.
    3. Erkläre das "Warum", nicht nur das "Was".`;
    
    // URL Encoding
    const url = `https://text.pollinations.ai/${encodeURIComponent(instruction)}?model=openai&seed=${Math.floor(Math.random() * 1000)}`;

    let retries = 3;
    while (retries > 0) {
        try {
            const response = await axios.get(url, { timeout: 30000 });
            
            let summary = response.data;
            if (typeof summary !== 'string') summary = JSON.stringify(summary);
            
            // Putzen
            summary = summary.trim().replace(/^["']|["']$/g, ''); // Anführungszeichen weg
            summary = summary.replace(/^Zusammenfassung:\s*/i, ''); // "Zusammenfassung:" weg

            if (summary.length < 10) throw new Error("Zu kurz");

            return { 
                summary: summary, 
                context: "", 
                tags: [sourceName, "News"] 
            };

        } catch (error) {
            const status = error.response?.status;
            
            if (status === 429) {
                console.log(`🛑 Zu schnell für Pollinations! Kühle 30 Sekunden ab...`);
                await sleep(30000); 
                retries--;
                continue; 
            }

            console.error(`⚠️ Fehler: ${error.message}. Warte kurz...`);
            await sleep(5000);
            retries--;
        }
    }

    return { summary: title, context: "", tags: [sourceName] };
}
