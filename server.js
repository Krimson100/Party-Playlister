require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const querystring = require('querystring');

const app = express();
const port = process.env.PORT || 5500;

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const SERVICE_REFRESH_TOKEN = process.env.SERVICE_REFRESH_TOKEN;

// Validate required environment variables
if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
    console.error('ERROR: Missing required environment variables. Check your .env file.');
    process.exit(1);
}

app.use(cors());
app.use(express.json());

async function getAccessToken() {
    if (!SERVICE_REFRESH_TOKEN) {
        throw new Error("Missing SERVICE_REFRESH_TOKEN. Visit /login first.");
    }
    const response = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
            'Authorization': 'Basic ' + (Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64')),
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: querystring.stringify({
            grant_type: 'refresh_token',
            refresh_token: SERVICE_REFRESH_TOKEN
        })
    });
    const data = await response.json();
    
    if (!response.ok) {
        throw new Error(`Spotify API error: ${data.error_description || data.error}`);
    }
    
    return data.access_token;
}

app.get('/login', (req, res) => {
    const scope = 'playlist-modify-public playlist-modify-private';
    res.redirect('https://accounts.spotify.com/authorize?' +
        querystring.stringify({
            response_type: 'code',
            client_id: CLIENT_ID,
            scope: scope,
            redirect_uri: REDIRECT_URI
        }));
});

app.get('/callback', async (req, res) => {
    const code = req.query.code || null;
    
    if (!code) {
        return res.status(400).send('<h1>Error: No authorization code received</h1>');
    }
    
    try {
        const response = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: {
                'Authorization': 'Basic ' + (Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64')),
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: querystring.stringify({
                code: code,
                redirect_uri: REDIRECT_URI,
                grant_type: 'authorization_code'
            })
        });
        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.error_description || 'Failed to get tokens');
        }
        
        res.send(`
            <h1>Copy this Refresh Token:</h1>
            <p style="word-break:break-all; background:#eee; padding:10px; font-family:monospace;">
                ${data.refresh_token}
            </p>
            <p>Add this to your .env file as SERVICE_REFRESH_TOKEN and restart the server.</p>
        `);
    } catch (error) {
        res.status(500).send(`<h1>Error: ${error.message}</h1>`);
    }
});

app.get('/api/search-artists', async (req, res) => {
    try {
        const token = await getAccessToken();
        const q = req.query.q;
        
        if (!q) {
            return res.status(400).json({ error: 'Query parameter "q" is required' });
        }
        
        const response = await fetch(
            `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=artist&limit=5`,
            { headers: { 'Authorization': `Bearer ${token}` } }
        );
        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.error?.message || 'Spotify API error');
        }
        
        res.json(data.artists ? data.artists.items : []);
    } catch (e) {
        console.error('Search error:', e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/generate', async (req, res) => {
    const { name, artists, songCount, startYear, endYear } = req.body;
    
    // Validation
    if (!name || !artists || !Array.isArray(artists) || artists.length === 0) {
        return res.status(400).json({ error: 'Invalid request: name and artists are required' });
    }
    
    if (songCount && (songCount < 1 || songCount > 100)) {
        return res.status(400).json({ error: 'Song count must be between 1 and 100' });
    }
    
    try {
        const token = await getAccessToken();
        
        let allTracks = [];
        for (const artist of artists) {
            let yearFilter = (startYear && endYear) ? ` year:${startYear}-${endYear}` : "";
            const query = `artist:"${artist}"${yearFilter}`;
            
            const searchRes = await fetch(
                `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=15`,
                { headers: { 'Authorization': `Bearer ${token}` } }
            );
            const searchData = await searchRes.json();
            
            if (!searchRes.ok) {
                console.error('Spotify search error:', searchData);
                continue;
            }
            
            if (searchData.tracks) allTracks.push(...searchData.tracks.items);
        }

        const selectedUris = allTracks
            .sort(() => 0.5 - Math.random())
            .slice(0, songCount || 20)
            .map(t => t.uri);

        if (selectedUris.length === 0) {
            return res.status(404).json({ error: 'No songs found for these artists/years.' });
        }

        const meRes = await fetch('https://api.spotify.com/v1/me', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const meData = await meRes.json();
        
        if (!meRes.ok) {
            throw new Error('Failed to get user information');
        }

        const createRes = await fetch(`https://api.spotify.com/v1/users/${meData.id}/playlists`, {
            method: 'POST',
            headers: { 
                'Authorization': `Bearer ${token}`, 
                'Content-Type': 'application/json' 
            },
            body: JSON.stringify({ 
                name: name || 'New Vibe Playlist', 
                public: true 
            })
        });
        const playlistData = await createRes.json();
        
        if (!createRes.ok) {
            throw new Error('Failed to create playlist');
        }

        await fetch(`https://api.spotify.com/v1/playlists/${playlistData.id}/tracks`, {
            method: 'POST',
            headers: { 
                'Authorization': `Bearer ${token}`, 
                'Content-Type': 'application/json' 
            },
            body: JSON.stringify({ uris: selectedUris })
        });

        res.json({ 
            url: playlistData.external_urls.spotify, 
            name: playlistData.name 
        });
    } catch (e) {
        console.error('Playlist generation error:', e);
        res.status(500).json({ error: 'Failed to generate playlist: ' + e.message });
    }
});

app.listen(port, () => {
    console.log(`✅ Server running at http://localhost:${port}`);
    console.log(`📝 Visit http://localhost:${port}/login to authenticate (if needed)`);
});