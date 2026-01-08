<!DOCTYPE html>
<html lang="de">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Daily Briefing</title>
    
    <!-- Premium Fonts -->
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Merriweather:ital,wght@0,300;0,400;0,700;1,400&display=swap" rel="stylesheet">
    
    <style>
        :root {
            --bg: #0b0b0c;
            --surface: #161618;
            --surface-hover: #1f1f22;
            --text-primary: #f2f2f2;
            --text-secondary: #a0a0a0;
            --accent: #3b82f6; /* Modernes Blau */
            --border: #27272a;
        }

        body {
            font-family: 'Inter', sans-serif;
            background-color: var(--bg);
            color: var(--text-primary);
            margin: 0;
            padding: 0;
            -webkit-font-smoothing: antialiased;
        }

        /* --- HEADER --- */
        header {
            background: rgba(11, 11, 12, 0.8);
            backdrop-filter: blur(16px);
            -webkit-backdrop-filter: blur(16px);
            position: sticky;
            top: 0;
            z-index: 50;
            border-bottom: 1px solid var(--border);
            padding: 1rem 1.5rem;
        }

        .header-inner {
            max-width: 1100px;
            margin: 0 auto;
            display: flex;
            flex-direction: column;
            gap: 1rem;
        }

        .brand {
            font-family: 'Merriweather', serif;
            font-size: 1.5rem;
            font-weight: 700;
            letter-spacing: -0.5px;
        }

        .filters {
            display: flex;
            gap: 0.8rem;
            overflow-x: auto;
            padding-bottom: 5px;
            scrollbar-width: none; /* Firefox */
        }
        .filters::-webkit-scrollbar { display: none; } /* Chrome */

        .chip {
            background: var(--surface);
            border: 1px solid var(--border);
            color: var(--text-secondary);
            padding: 0.5rem 1rem;
            border-radius: 99px;
            font-size: 0.85rem;
            font-weight: 500;
            cursor: pointer;
            white-space: nowrap;
            transition: all 0.2s;
        }
        .chip:hover { border-color: #555; color: #fff; }
        .chip.active { background: var(--text-primary); color: var(--bg); border-color: var(--text-primary); }

        /* --- GRID LAYOUT --- */
        .container {
            max-width: 1100px;
            margin: 2rem auto;
            padding: 0 1.5rem;
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
            gap: 2rem;
            padding-bottom: 4rem;
        }

        /* --- NEWS CARD --- */
        .card {
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 12px;
            overflow: hidden;
            display: flex;
            flex-direction: column;
            transition: transform 0.2s, box-shadow 0.2s;
            cursor: pointer;
            position: relative;
        }
        .card:hover {
            transform: translateY(-4px);
            box-shadow: 0 12px 24px rgba(0,0,0,0.3);
            border-color: #444;
        }

        /* Hero Card (Erstes Element über 2 Spalten) */
        @media (min-width: 768px) {
            .card.hero {
                grid-column: span 2;
                flex-direction: row;
            }
            .card.hero .card-img {
                width: 50%;
                height: auto;
            }
            .card.hero .card-content {
                width: 50%;
                justify-content: center;
                padding: 2.5rem;
            }
            .card.hero .card-title {
                font-size: 1.8rem;
            }
        }

        .card-img {
            width: 100%;
            height: 200px;
            object-fit: cover;
            background: #202022;
        }

        .card-content {
            padding: 1.5rem;
            display: flex;
            flex-direction: column;
            flex: 1;
        }

        .card-meta {
            display: flex;
            justify-content: space-between;
            font-size: 0.75rem;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--text-secondary);
            font-weight: 600;
            margin-bottom: 0.8rem;
        }

        .card-title {
            font-family: 'Merriweather', serif;
            font-size: 1.25rem;
            font-weight: 700;
            line-height: 1.4;
            margin: 0 0 1rem 0;
            color: var(--text-primary);
        }

        .card-excerpt {
            font-size: 0.95rem;
            line-height: 1.6;
            color: #d1d5db;
            display: -webkit-box;
            -webkit-line-clamp: 3;
            -webkit-box-orient: vertical;
            overflow: hidden;
        }

        /* --- READER OVERLAY (Article View) --- */
        #reader {
            position: fixed;
            top: 0; left: 0; width: 100%; height: 100%;
            background: var(--bg);
            z-index: 1000;
            display: none;
            overflow-y: auto;
            animation: fadeIn 0.3s ease;
        }
        @keyframes fadeIn { from { opacity: 0; transform: scale(0.98); } to { opacity: 1; transform: scale(1); } }
        
        #reader.active { display: block; }

        .reader-nav {
            position: sticky; top: 0;
            padding: 1rem 1.5rem;
            display: flex; justify-content: flex-end;
            background: rgba(11, 11, 12, 0.9);
            backdrop-filter: blur(10px);
        }

        .close-btn {
            background: rgba(255,255,255,0.1);
            border: none; color: #fff;
            width: 40px; height: 40px; border-radius: 50%;
            font-size: 1.2rem; cursor: pointer;
            display: flex; align-items: center; justify-content: center;
            transition: background 0.2s;
        }
        .close-btn:hover { background: rgba(255,255,255,0.2); }

        .article-container {
            max-width: 700px;
            margin: 0 auto;
            padding: 0 1.5rem 4rem 1.5rem;
        }

        .article-img {
            width: 100%;
            height: auto;
            border-radius: 12px;
            margin-bottom: 2rem;
            max-height: 400px; object-fit: cover;
        }

        .article-meta {
            color: var(--accent);
            font-weight: 700;
            text-transform: uppercase;
            font-size: 0.85rem;
            margin-bottom: 0.5rem;
        }

        .article-title {
