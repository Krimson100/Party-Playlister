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

// Validate required environment variables
if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
    console.error('ERROR: Missing required environment variables. Check your .env file.');
    process.exit(1);
}

// Session middleware to store user tokens
app.use(session({
    secret: process.env.SESSION_SECRET || 'your-secret-key-change-this',
    resave: false,
    saveUninitialized: true,
    cookie: { 
        secure: false, // Set to true if using HTTPS
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 3600000 // 1 hour
    }
}));

app.use(cors({
    origin: true,
    credentials: true
}));
app.use(express.json());

// Middleware to check if user is authenticated
function requireAuth(req, res, next) {
    if (!req.session.accessToken) {
        return res.status(401).json({ 
            error: 'Not authenticated',
            needsAuth: true 
        });
    }
    next();
}

// Refresh access token if needed
async function getValidAccessToken(session) {
    // If we have a valid access token, use it
    if (session.accessToken && session.expiresAt && Date.now() < session.expiresAt) {
        return session.accessToken;
    }
    
    // Otherwise, refresh it
    if (!session.refreshToken) {
        throw new Error('No refresh token available');
    }
    
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
    
    if (!response.ok) {
        throw new Error(`Spotify API error: ${data.error_description || data.error}`);
    }
    
    // Update session with new token
    session.accessToken = data.access_token;
    session.expiresAt = Date.now() + (data.expires_in * 1000);
    
    return data.access_token;
}

// Login route - redirects to Spotify auth
app.get('/login', (req, res) => {
    const scope = 'playlist-modify-public playlist-modify-private';
    const state = Math.random().toString(36).substring(7);
    
    // Save state before redirect
    req.session.state = state;
    req.session.save((err) => {
        if (err) {
            console.error('Session save error:', err);
        }
        console.log('Login initiated, state saved:', state, 'Session ID:', req.sessionID);
        
        res.redirect('https://accounts.spotify.com/authorize?' +
            querystring.stringify({
                response_type: 'code',
                client_id: CLIENT_ID,
                scope: scope,
                redirect_uri: REDIRECT_URI,
                state: state,
                show_dialog: true // Force Spotify to show account selection
            }));
    });
});

// Callback route - handles Spotify redirect
app.get('/callback', async (req, res) => {
    const code = req.query.code || null;
    const state = req.query.state || null;
    const error = req.query.error || null;
    
    console.log('Callback received - Session ID:', req.sessionID);
    console.log('Callback details:', { 
        hasCode: !!code, 
        receivedState: state, 
        sessionState: req.session?.state,
        stateMatch: state === req.session?.state,
        error 
    });
    
    if (error) {
        return res.status(400).send(`<h1>Spotify Authorization Error</h1><p>${error}</p><p>User denied access or another error occurred.</p>`);
    }
    
    if (!code) {
        return res.status(400).send('<h1>Error: No authorization code received</h1>');
    }
    
    // More lenient state check
    if (!req.session.state) {
        console.warn('WARNING: No state in session, but proceeding with auth');
    } else if (state !== req.session.state) {
        console.error('State mismatch:', { received: state, expected: req.session.state });
        return res.status(400).send('<h1>Error: State mismatch</h1><p>Please try logging in again.</p>');
    }
    
    try {
        console.log('Exchanging code for tokens...');
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
            console.error('Token exchange failed:', data);
            throw new Error(data.error_description || 'Failed to get tokens');
        }
        
        console.log('Tokens received successfully');
        
        // Store tokens in session
        req.session.accessToken = data.access_token;
        req.session.refreshToken = data.refresh_token;
        req.session.expiresAt = Date.now() + (data.expires_in * 1000);
        
        // Clear state after successful auth
        delete req.session.state;
        
        // Save session before responding
        req.session.save((err) => {
            if (err) {
                console.error('Session save error:', err);
            }
            
            // Redirect back to frontend
            res.send(`
                <script>
                    console.log('Auth success, notifying parent window');
                    window.opener.postMessage({ type: 'spotify-auth-success' }, '*');
                    setTimeout(() => window.close(), 1000);
                </script>
                <h1>Success! ✓</h1>
                <p>You can close this window or it will close automatically.</p>
            `);
        });
    } catch (error) {
        console.error('Callback error:', error);
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
    
    console.log('Auth status check:', { hasUserAuth, hasSession: !!req.session });
    
    res.json({ 
        authenticated: hasUserAuth,
        expiresAt: req.session?.expiresAt
    });
});

// Search artists (requires auth)
app.get('/api/search-artists', requireAuth, async (req, res) => {
    try {
        const token = await getValidAccessToken(req.session);
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

// Generate playlist (requires auth)
app.post('/api/generate', requireAuth, async (req, res) => {
    const { name, artists, songCount, startYear, endYear } = req.body;
    
    // Validation
    if (!name || !artists || !Array.isArray(artists) || artists.length === 0) {
        return res.status(400).json({ error: 'Invalid request: name and artists are required' });
    }
    
    if (songCount && (songCount < 1 || songCount > 100)) {
        return res.status(400).json({ error: 'Song count must be between 1 and 100' });
    }
    
    try {
        const token = await getValidAccessToken(req.session);
        
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

// Serve static files
app.use(express.static(__dirname));

// Serve index.html for root route
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});


app.listen(port, () => {
    console.log(`✅ Server running at http://127.0.0.1:${port}`);
    console.log(`📝 Visit http://127.0.0.1:${port}/login to authenticate`);
});