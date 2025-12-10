const express = require('express');
const path = require('path');
const dotenv = require('dotenv');
const axios = require('axios');
const cookieParser = require('cookie-parser');
const { query } = require('./db');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// --- in-memory stores ---
const tokensByChannel = {}; // { channel: { access_token, refresh_token, broadcaster_id } }
const goalsByChannel = {};  // { channel: { goal } }

app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- DB INIT + LOAD ----------
async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS twitch_tokens (
      channel        text PRIMARY KEY,
      broadcaster_id text NOT NULL,
      access_token   text NOT NULL,
      refresh_token  text NOT NULL
    );
  `);
}

async function loadTokens() {
  try {
    const res = await query(
      'SELECT channel, broadcaster_id, access_token, refresh_token FROM twitch_tokens'
    );
    res.rows.forEach((row) => {
      tokensByChannel[row.channel.toLowerCase()] = {
        access_token: row.access_token,
        refresh_token: row.refresh_token,
        broadcaster_id: row.broadcaster_id
      };
    });
    console.log('Loaded tokens for channels:', Object.keys(tokensByChannel));
  } catch (err) {
    console.error('Failed to load tokens from DB', err);
  }
}

// ---------- HEALTH ----------
app.get('/health', (req, res) => {
  res.send('OK');
});

// ---------- OAUTH START ----------
app.get('/auth/twitch', (req, res) => {
  const channel = req.query.channel;
  if (!channel) {
    return res
      .status(400)
      .send('Missing channel query param, e.g. /auth/twitch?channel=yourchannel');
  }

  const state = Buffer.from(JSON.stringify({ channel })).toString('base64url');

  const params = new URLSearchParams({
    client_id: process.env.TWITCH_CLIENT_ID,
    redirect_uri: process.env.TWITCH_REDIRECT_URI,
    response_type: 'code',
    scope: 'channel:read:subscriptions',
    state
  });

  const url = `https://id.twitch.tv/oauth2/authorize?${params.toString()}`;
  res.redirect(url);
});

// ---------- OAUTH CALLBACK ----------
app.get('/auth/twitch/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    return res.status(400).send(`Twitch error: ${error_description || error}`);
  }

  let channel = null;
  try {
    const decoded = JSON.parse(Buffer.from(state, 'base64url').toString('utf8'));
    channel = decoded.channel.toLowerCase();
  } catch (e) {
    return res.status(400).send('Invalid state');
  }

  try {
    // exchange code for tokens
    const tokenRes = await axios.post(
      'https://id.twitch.tv/oauth2/token',
      new URLSearchParams({
        client_id: process.env.TWITCH_CLIENT_ID,
        client_secret: process.env.TWITCH_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: process.env.TWITCH_REDIRECT_URI
      }),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }
    );

    const { access_token, refresh_token } = tokenRes.data;

    // get broadcaster_id
    const userRes = await axios.get('https://api.twitch.tv/helix/users', {
      headers: {
        'Client-Id': process.env.TWITCH_CLIENT_ID,
        Authorization: `Bearer ${access_token}`
      }
    });

    const user = userRes.data.data[0];

    tokensByChannel[channel] = {
      access_token,
      refresh_token,
      broadcaster_id: user.id
    };

    if (process.env.DATABASE_URL) {
      await query(
        `
        INSERT INTO twitch_tokens (channel, broadcaster_id, access_token, refresh_token)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (channel)
        DO UPDATE SET
          broadcaster_id = EXCLUDED.broadcaster_id,
          access_token   = EXCLUDED.access_token,
          refresh_token  = EXCLUDED.refresh_token
        `,
        [channel, user.id, access_token, refresh_token]
      );
    }

    console.log('Stored tokens for channel', channel, tokensByChannel[channel]);

    res.send(
      `Twitch connected for channel ${channel}. You can now use the overlay with ?channel=${channel}`
    );
  } catch (err) {
    console.error('OAuth callback error', err.response?.data || err.message);
    res.status(500).send('Failed to complete Twitch OAuth. Check server logs.');
  }
});

// ---------- TOKEN REFRESH HELPER ----------
async function refreshAccessToken(channel, tokenInfo) {
  if (!tokenInfo?.refresh_token) {
    console.error('No refresh_token for channel', channel);
    return null;
  }

  try {
    const res = await axios.post(
      'https://id.twitch.tv/oauth2/token',
      new URLSearchParams({
        client_id: process.env.TWITCH_CLIENT_ID,
        client_secret: process.env.TWITCH_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: tokenInfo.refresh_token
      }),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }
    );

    const { access_token, refresh_token } = res.data;

    // update in memory
    tokensByChannel[channel] = {
      ...tokenInfo,
      access_token,
      refresh_token
    };

    // update in DB
    if (process.env.DATABASE_URL) {
      await query(
        `
        UPDATE twitch_tokens
        SET access_token = $2, refresh_token = $3
        WHERE channel = $1
        `,
        [channel, access_token, refresh_token]
      );
    }

    console.log('Refreshed token for channel', channel);
    return tokensByChannel[channel];
  } catch (err) {
    console.error(
      'Failed to refresh token for channel',
      channel,
      err.response?.data || err.message
    );
    return null;
  }
}

// ---------- SUB COUNT HELPER ----------
async function getCurrentSubsForChannel(channel) {
  const key = channel.toLowerCase();
  let tokenInfo = tokensByChannel[key];
  if (!tokenInfo) {
    return null;
  }

  const doRequest = async (access_token) => {
    const res = await axios.get('https://api.twitch.tv/helix/subscriptions', {
      params: { broadcaster_id: tokenInfo.broadcaster_id },
      headers: {
        'Client-Id': process.env.TWITCH_CLIENT_ID,
        Authorization: `Bearer ${access_token}`
      }
    });
    const total = res.data.total ?? res.data.data?.length ?? 0;
    return total;
  };

  try {
    return await doRequest(tokenInfo.access_token);
  } catch (err) {
    // if token is invalid/expired, try refresh once
    if (err.response?.status === 401) {
      console.warn('401 for channel', channel, '- trying refresh');
      const refreshed = await refreshAccessToken(key, tokenInfo);
      if (!refreshed) {
        return null;
      }
      try {
        return await doRequest(refreshed.access_token);
      } catch (err2) {
        console.error(
          'Error fetching subs after refresh for',
          channel,
          err2.response?.data || err2.message
        );
        return null;
      }
    }

    console.error('Error fetching subs for', channel, err.response?.data || err.message);
    return null;
  }
}

// ---------- SET GOAL ----------
app.all('/api/setgoal', (req, res) => {
  const channel = (req.body.channel || req.query.channel || '').toLowerCase();
  const goalStr = req.body.goal || req.query.goal;

  if (!channel) {
    return res.status(400).send('Missing channel');
  }
  if (!goalStr) {
    return res.status(400).send('Missing goal');
  }

  const goal = parseInt(goalStr, 10);
  if (Number.isNaN(goal) || goal <= 0) {
    return res.status(400).send('Goal must be a positive integer');
  }

  goalsByChannel[channel] = { goal };
  console.log('Set goal for', channel, 'to', goal);
  res.send(`Sub goal updated to ${goal}`);
});

// ---------- SUBGOAL API ----------
app.get('/api/subgoal', async (req, res) => {
  const channel = (req.query.channel || 'test').toLowerCase();

  const goal = goalsByChannel[channel]?.goal || 50;

  const current = await getCurrentSubsForChannel(channel);
  if (current === null) {
    return res.json({ current: 0, goal });
  }

  res.json({ current, goal });
});

// ---------- OVERLAY ----------
app.get('/overlay/subgoal', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'overlay', 'subgoal.html'));
});

// ---------- STARTUP ----------
async function start() {
  if (process.env.DATABASE_URL) {
    try {
      await initDb();
      await loadTokens();
    } catch (err) {
      console.error('Failed to init/load DB', err);
    }
  } else {
    console.warn('DATABASE_URL not set; starting without DB persistence.');
  }

  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start app', err);
  process.exit(1);
});
