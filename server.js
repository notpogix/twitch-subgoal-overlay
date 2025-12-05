const express = require('express');
const path = require('path');
const dotenv = require('dotenv');
const axios = require('axios');
const cookieParser = require('cookie-parser');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// --- simple in-memory stores ---
/**
 * tokensByChannel = {
 *   channel_name_lowercase: {
 *     access_token,
 *     refresh_token,
 *     broadcaster_id
 *   }
 * }
 */
const tokensByChannel = {};
// goalsByChannel = { channel_name_lowercase: { goal: number } }
const goalsByChannel = {};

app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

// health
app.get('/health', (req, res) => {
  res.send('OK');
});

// ---- OAuth: start ----
app.get('/auth/twitch', (req, res) => {
  // ?channel=channelName must be provided so we know who this is for
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

// OAuth callback
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

    // get broadcaster_id from /users [web:1][web:77]
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

    console.log('Stored tokens for channel', channel, tokensByChannel[channel]);

    res.send(
      `Twitch connected for channel ${channel}. You can now use the overlay with ?channel=${channel}`
    );
  } catch (err) {
    console.error('OAuth callback error', err.response?.data || err.message);
    res.status(500).send('Failed to complete Twitch OAuth. Check server logs.');
  }
});
// ---- OAuth: end ----

// helper: get current subs from Twitch [web:1][web:83]
async function getCurrentSubsForChannel(channel) {
  const key = channel.toLowerCase();
  const tokenInfo = tokensByChannel[key];
  if (!tokenInfo) {
    // no OAuth done yet for this channel
    return null;
  }

  const { access_token, broadcaster_id } = tokenInfo;

  try {
    const res = await axios.get('https://api.twitch.tv/helix/subscriptions', {
      params: { broadcaster_id },
      headers: {
        'Client-Id': process.env.TWITCH_CLIENT_ID,
        Authorization: `Bearer ${access_token}`
      }
    });

    // endpoint returns total count in `total` field [web:1][web:83]
    const total = res.data.total ?? res.data.data?.length ?? 0;
    return total;
  } catch (err) {
    console.error('Error fetching subs for', channel, err.response?.data || err.message);
    return null;
  }
}

// set goal from external callers (e.g. StreamElements) [web:46]
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

// subgoal API used by overlay
app.get('/api/subgoal', async (req, res) => {
  const channel = (req.query.channel || 'test').toLowerCase();

  const goal = goalsByChannel[channel]?.goal || 50;

  const current = await getCurrentSubsForChannel(channel);
  if (current === null) {
    // no token or error → fall back to 0
    return res.json({ current: 0, goal });
  }

  res.json({ current, goal });
});

// serve overlay HTML
app.get('/overlay/subgoal', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'overlay', 'subgoal.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
