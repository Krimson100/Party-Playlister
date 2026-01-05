const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const querystring = require('querystring');

const app = express();
const port = 8000;

// --- CONFIGURATION ---
// 1. Fill these in from your Spotify Dashboard
const CLIENT_ID = 'a0e5a70475c642a4a68021b0c9dccb52';
const CLIENT_SECRET = '38e19ec90c724ae7b0c7b0ce4fd86fc5';
const REDIRECT_URI = 'http://127.0.0.1:8000/callback'; 

// 2. This is the token you get from Step 4. 
// Initially, leave it empty. Run the server, go to http://localhost:3001/login.
let SERVICE_REFRESH_TOKEN = ''; 

app.use(cors());
app.use(express.json());

/**
 * HELPER: Get a fresh access token using the Refresh Token
 */
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
    return data.access_token;
}

/**
 * ONE-TIME SETUP: Visit http://localhost:3001/login to get your token
 */
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
    res.send(`<h1>Copy this Refresh Token:</h1><p style="word-break:break-all; background:#eee; padding:10px;">${data.refresh_token}</p><p>Paste this into SERVICE_REFRESH_TOKEN in server.js and restart the server.</p>`);
});

// --- API ENDPOINTS ---

app.get('/api/search-artists', async (req, res) => {
    try {
        const token = await getAccessToken();
        const q = req.query.q;
        const response = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=artist&limit=5`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await response.json();
        res.json(data.artists ? data.artists.items : []);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/generate', async (req, res) => {
    const { name, artists, songCount, startYear, endYear } = req.body;
    
    try {
        const token = await getAccessToken();
        
        let allTracks = [];
        for (const artist of artists) {
            // If years are provided, add them to the query
            let yearFilter = (startYear && endYear) ? ` year:${startYear}-${endYear}` : "";
            const query = `artist:"${artist}"${yearFilter}`;
            
            const searchRes = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=15`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const searchData = await searchRes.json();
            if (searchData.tracks) allTracks.push(...searchData.tracks.items);
        }

        const selectedUris = allTracks
            .sort(() => 0.5 - Math.random())
            .slice(0, songCount)
            .map(t => t.uri);

        if (selectedUris.length === 0) return res.status(404).json({ error: 'No songs found for these artists/years.' });

        const meRes = await fetch('https://api.spotify.com/v1/me', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const meData = await meRes.json();

        const createRes = await fetch(`https://api.spotify.com/v1/users/${meData.id}/playlists`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name || 'New Vibe Playlist', public: true })
        });
        const playlistData = await createRes.json();

        await fetch(`https://api.spotify.com/v1/playlists/${playlistData.id}/tracks`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ uris: selectedUris })
        });

        res.json({ url: playlistData.external_urls.spotify, name: playlistData.name });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Failed to generate playlist.' });
    }
});

app.listen(port, () => console.log(`Server running at http://localhost:${port}`));