require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const querystring = require('querystring');
const session = require('express-session');

const app = express();
const port = process.env.PORT || 5500;

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const SERVICE_REFRESH_TOKEN = process.env.SERVICE_REFRESH_TOKEN; // Your personal token for demo mode

// Validate required environment variables
if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
    console.error('ERROR: Missing required environment variables. Check your .env file.');
    process.exit(1);
}

// Session middleware to store user tokens
app.use(session({
    secret: process.env.SESSION_SECRET || 'your-secret-key-change-this',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: false, // Set to true if using HTTPS
        maxAge: 3600000 // 1 hour
    }
}));

app.use(cors({
    origin: true,
    credentials: true
}));
app.use(express.json());

// Get access token - tries user token first, falls back to service token
async function getAccessToken(session) {
    // If user is logged in, use their token
    if (session && session.accessToken && session.expiresAt && Date.now() < session.expiresAt) {
        return { token: session.accessToken, mode: 'user' };
    }
    
    // If user has a refresh token, refresh it
    if (session && session.refreshToken) {
        try {
            const response = await fetch('https://accounts.spotify.com/api/token', {
                method: 'POST',
                headers: {
                    'Authorization': 'Basic ' + (Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64')),
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: querystring.stringify({
                    grant_type: 'refresh_token',
                    refresh_token: session.refreshToken
                })
            });
            
            const data = await response.json();
            
            if (response.ok) {
                session.accessToken = data.access_token;
                session.expiresAt = Date.now() + (data.expires_in * 1000);
                return { token: data.access_token, mode: 'user' };
            }
        } catch (e) {
            console.error('Error refreshing user token:', e);
        }
    }
    
    // Fall back to service token (demo mode)
    if (SERVICE_REFRESH_TOKEN) {
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
        
        return { token: data.access_token, mode: 'demo' };
    }
    
    throw new Error('No authentication available. Please log in or configure SERVICE_REFRESH_TOKEN.');
}

// Login route - redirects to Spotify auth
app.get('/login', (req, res) => {
    const scope = 'playlist-modify-public playlist-modify-private';
    const state = Math.random().toString(36).substring(7);
    req.session.state = state;
    
    res.redirect('https://accounts.spotify.com/authorize?' +
        querystring.stringify({
            response_type: 'code',
            client_id: CLIENT_ID,
            scope: scope,
            redirect_uri: REDIRECT_URI,
            state: state
        }));
});

// Callback route - handles Spotify redirect
app.get('/callback', async (req, res) => {
    const code = req.query.code || null;
    const state = req.query.state || null;
    
    if (!code || state !== req.session.state) {
        return res.status(400).send('<h1>Error: Invalid state or no authorization code</h1>');
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
        
        // Store tokens in session
        req.session.accessToken = data.access_token;
        req.session.refreshToken = data.refresh_token;
        req.session.expiresAt = Date.now() + (data.expires_in * 1000);
        
        // Redirect back to frontend
        res.send(`
            <script>
                window.opener.postMessage({ type: 'spotify-auth-success' }, '*');
                window.close();
            </script>
            <h1>Success! You can close this window.</h1>
        `);
    } catch (error) {
        res.status(500).send(`<h1>Error: ${error.message}</h1>`);
    }
});

// Logout route
app.get('/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// Check auth status
app.get('/api/auth-status', (req, res) => {
    const hasUserAuth = !!(req.session && req.session.accessToken && req.session.expiresAt && Date.now() < req.session.expiresAt);
    const hasDemoMode = !!SERVICE_REFRESH_TOKEN;
    
    console.log('Auth status check:', { hasUserAuth, hasDemoMode, hasSession: !!req.session });
    
    res.json({ 
        authenticated: hasUserAuth,
        mode: hasUserAuth ? 'user' : (hasDemoMode ? 'demo' : 'none'),
        expiresAt: req.session?.expiresAt,
        demoAvailable: hasDemoMode
    });
});

// Search artists
app.get('/api/search-artists', async (req, res) => {
    try {
        const { token, mode } = await getAccessToken(req.session);
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
        
        res.json({
            artists: data.artists ? data.artists.items : [],
            mode: mode // Let frontend know if using demo or user mode
        });
    } catch (e) {
        console.error('Search error:', e);
        res.status(500).json({ error: e.message });
    }
});

// Generate playlist
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
        const { token, mode } = await getAccessToken(req.session);
        
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
            name: playlistData.name,
            mode: mode // Let frontend know if playlist was created in demo or user mode
        });
    } catch (e) {
        console.error('Playlist generation error:', e);
        res.status(500).json({ error: 'Failed to generate playlist: ' + e.message });
    }
});

app.use(express.static('.'));
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

app.listen(port, () => {
    console.log(`✅ Server running at http://localhost:${port}`);
    console.log(`📝 Visit http://localhost:${port}/login to authenticate`);
    if (SERVICE_REFRESH_TOKEN) {
        console.log(`🎵 Demo mode ENABLED (using service account)`);
    } else {
        console.log(`⚠️  Demo mode DISABLED (no SERVICE_REFRESH_TOKEN found)`);
    }
});