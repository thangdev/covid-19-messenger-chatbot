'use strict';

// 1. npm install body-parser express request
// 2. Download and install ngrok from https://ngrok.com/download
// 3. ./ngrok http 8445
// 4. WIT_TOKEN=your_access_token FB_PAGE_ID=your_page_id FB_PAGE_TOKEN=your_page_token FB_VERIFY_TOKEN=verify_token node examples/messenger.js
// 5. Subscribe your page to the Webhooks using verify_token and `https://<your_ngrok_io>/fb` as callback URL.
// 6. Talk to your bot on Messenger!

const bodyParser = require('body-parser');
const express = require('express');
const axios = require('axios');
const request = require('request');

// Webserver parameter
const PORT = process.env.PORT || 8445;

// Wit.ai parameters
const WIT_TOKEN = process.env.WIT_TOKEN;

// Messenger API parameters
const FB_PAGE_ID = process.env.FB_PAGE_ID;
if (!FB_PAGE_ID) {
  throw new Error('missing FB_PAGE_ID');
}
const FB_PAGE_TOKEN = process.env.FB_PAGE_TOKEN;
if (!FB_PAGE_TOKEN) {
  throw new Error('missing FB_PAGE_TOKEN');
}
const FB_VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN;

// Messenger API specific code

// See the Send API reference
// https://developers.facebook.com/docs/messenger-platform/send-api-reference
const fbReq = request.defaults({
  uri: 'https://graph.facebook.com/me/messages',
  method: 'POST',
  json: true,
  qs: { access_token: FB_PAGE_TOKEN },
  headers: { 'Content-Type': 'application/json' },
});

const fbMessage = (recipientId, msg, cb) => {
  const opts = {
    form: {
      recipient: {
        id: recipientId,
      },
      message: {
        text: msg,
      },
    },
  };
  fbReq(opts, (err, resp, data) => {
    if (cb) {
      cb(err || (data.error && data.error.message), data);
    }
  });
};

// See the Webhook reference
// https://developers.facebook.com/docs/messenger-platform/webhook-reference
const getFirstMessagingEntry = (body) => {
  const val =
    body.object == 'page' &&
    body.entry &&
    Array.isArray(body.entry) &&
    body.entry.length > 0 &&
    body.entry[0] &&
    body.entry[0].id === FB_PAGE_ID &&
    body.entry[0].messaging &&
    Array.isArray(body.entry[0].messaging) &&
    body.entry[0].messaging.length > 0 &&
    body.entry[0].messaging[0];
  return body.entry[0].messaging[0];
};

const sessions = {};

const findOrCreateSession = (fbid) => {
  let sessionId;
  // Let's see if we already have a session for the user fbid
  Object.keys(sessions).forEach((k) => {
    if (sessions[k].fbid === fbid) {
      // Yep, got it!
      sessionId = k;
    }
  });
  if (!sessionId) {
    // No session found for user fbid, let's create a new one
    sessionId = new Date().toISOString();
    sessions[sessionId] = { fbid: fbid, context: {} };
  }
  return sessionId;
};

const firstEntityValue = (entities, entity) => {
  const val =
    entities &&
    entities[entity] &&
    Array.isArray(entities[entity]) &&
    entities[entity].length > 0 &&
    entities[entity][0].value;
  if (!val) {
    return null;
  }
  return typeof val === 'object' ? val.value : val;
};

const actions = {
  say(sessionId, context, message, cb) {
    const recipientId = sessions[sessionId].fbid;
    if (recipientId) {
      fbMessage(recipientId, message, (err, data) => {
        if (err) {
          console.log(
            'Oops! An error occurred while forwarding the response to',
            recipientId,
            ':',
            err
          );
        }

        cb();
      });
    } else {
      console.log("Oops! Couldn't find user for session:", sessionId);
      cb();
    }
  },
  merge(sessionId, context, entities, message, cb) {
    cb(context);
  },
  error(sessionId, context, error) {
    console.log(error.message);
  },
  ['blank'](sessionId, context, cb) {
    context.return = 'return String';
    cb(context);
  },
};

const senderAction = async (senderId, action) => {
  return await axios({
    method: 'post',
    url: `https://graph.facebook.com/v2.6/me/messages?access_token=${FB_PAGE_TOKEN}`,
    data: {
      recipient: {
        id: senderId,
      },
      sender_action: action,
    },
  });
};

const app = express();
app.set('port', PORT);
app.listen(app.get('port'));
app.use(bodyParser.json());

// Webhook setup
app.get('/fb', (req, res) => {
  console.log('success');
  if (!FB_VERIFY_TOKEN) {
    throw new Error('missing FB_VERIFY_TOKEN');
  }
  if (
    req.query['hub.mode'] === 'subscribe' &&
    req.query['hub.verify_token'] === FB_VERIFY_TOKEN
  ) {
    res.send(req.query['hub.challenge']);
  } else {
    res.sendStatus(400);
  }
});
// test api workinSg
app.get('/', (req, res) => {
  res.send('server is working');
});

// Message handler
app.post('/fb', async (req, res) => {
  // Parsing the Messenger API response
  const messaging = getFirstMessagingEntry(req.body);

  if (messaging && messaging.message) {
    // We retrieve the Facebook user ID of the sender
    const sender = messaging.sender.id;
    // We retrieve the user's current session, or create one if it doesn't exist
    // This is needed for our bot to figure out the conversation history
    const sessionId = findOrCreateSession(sender);
    // We retrieve the message content
    const msg = messaging.message.text;
    const atts = messaging.message.attachments;

    if (msg) {
      await senderAction(sender, 'mark_seen');
      const query = msg.split(' ').join('%20');
      const witResponse = await axios.get(
        'https://api.wit.ai/message?v=20200906&q=' + query,
        {
          headers: {
            Authorization: 'Bearer ' + WIT_TOKEN, //the token is a variable which holds the token
          },
        }
      );
      console.log(witResponse.data.entities['wit$location:location']);
      senderAction(sender, 'typing_on');
      if (witResponse.data.entities['wit$location:location'] === undefined) {
        fbMessage(
          sender,
          'Sorry bro, I dont really understand what you mean.\nTry type something like: Covid-19 virus stats in vietnam'
        );
        senderAction(sender, 'typing_off');

        res.sendStatus(200);
        return;
      }
      const country =
        witResponse.data.entities['wit$location:location'][0].body;

      const confirmedCase = await axios.get(
        `https://api.covid19api.com/total/dayone/country/${country}/status/confirmed`
      );
      const recoveredCase = await axios.get(
        `https://api.covid19api.com/total/dayone/country/${country}/status/recovered`
      );
      const deathsCase = await axios.get(
        `https://api.covid19api.com/total/dayone/country/${country}/status/deaths`
      );

      const confirmedCaseRes =
        confirmedCase.data[confirmedCase.data.length - 1].Cases;
      const recoveredCaseRes =
        recoveredCase.data[recoveredCase.data.length - 1].Cases;
      const deathsCaseRes =
        '' + deathsCase.data[deathsCase.data.length - 1].Cases;
      const date = confirmedCase.data[confirmedCase.data.length - 1].Date;

      await fbMessage(
        sender,
        `This is Covid-19 disease stats in ${country}:\n
        Confirmed cases: ${confirmedCaseRes}
        Recovered cases: ${recoveredCaseRes}
        Death cases: ${deathsCaseRes}
        Last updated: ${date}`
      );
      fbMessage(
        sender,
        'IMPORTANT! Wear masks with two or more layers to stop the spread of COVID-19!! 😷'
      );
      res.sendStatus(200);
    }
  }
});
