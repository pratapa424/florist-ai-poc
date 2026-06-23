const express = require('express');
const { WebSocketServer } = require('ws');
const OpenAI = require('openai');
const http = require('http');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---- POC in-memory transcript store (resets on redeploy) ----
// In production this is your real database / florist API.
const transcripts = {};

function saveTranscript(id, record) {
  transcripts[id] = record;
  console.log('Saved transcript for', id, '-> fetch at /get-transcript?id=' + id);
}

// ---- Simulated florists (keypad digit -> florist) ----
const FLORISTS = {
  '1': { name: 'Flowers by Jane', phone: '+15551110001', tfid: '00006655' },
  '2': { name: 'City Florist',    phone: '+15551110002', tfid: '11223360' }
};

app.get('/', (req, res) => res.send('Florist AI POC running'));

// Your app calls this to load the full transcript by ID
app.get('/get-transcript', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*'); // POC only - lock down in prod
  const id = req.query.id;
  const record = transcripts[id];
  if (!record) return res.status(404).json({ error: 'not found', id: id });
  res.json(record);
});

// Optional: POST a transcript from an external service
app.post('/save-transcript', (req, res) => {
  const id = req.body.id;
  if (!id) return res.status(400).json({ error: 'id required' });
  saveTranscript(id, req.body.record || {});
  res.json({ ok: true, id: id });
});

// Step 1 - ask which florist (simulates florist-phone lookup)
app.post('/incoming-call', (req, res) => {
  const host = req.headers.host;
  res.set('Content-Type', 'text/xml');
  res.send([
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    '  <Gather input="dtmf" numDigits="1" timeout="6" action="https://' + host + '/start-ai" method="POST">',
    '    <Say>Press 1 for Flowers by Jane. Press 2 for City Florist.</Say>',
    '  </Gather>',
    '  <Redirect method="POST">https://' + host + '/start-ai?Digits=1</Redirect>',
    '</Response>'
  ].join('\n'));
});

// Step 2 - resolve florist + tfid, then start the AI
app.post('/start-ai', (req, res) => {
  const host = req.headers.host;
  const digit = req.body.Digits || req.query.Digits || '1';
  const florist = FLORISTS[digit] || FLORISTS['1'];
  console.log('Digit:', digit, '-> florist:', florist.name, 'tfid:', florist.tfid);

  res.set('Content-Type', 'text/xml');
  res.send([
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    '  <Connect action="https://' + host + '/enqueue-to-flex">',
    '    <ConversationRelay url="wss://' + host + '/ai-session" welcomeGreeting="Thank you for calling ' + florist.name + '. How can I help you today?">',
    '      <Parameter name="tfid" value="' + florist.tfid + '" />',
    '      <Parameter name="floristName" value="' + florist.name + '" />',
    '      <Parameter name="floristPhone" value="' + florist.phone + '" />',
    '    </ConversationRelay>',
    '  </Connect>',
    '</Response>'
  ].join('\n'));
});

app.post('/enqueue-to-flex', (req, res) => {
  const handoffData = JSON.parse(req.body.HandoffData || '{}');
  const workflowSid = process.env.TWILIO_WORKFLOW_SID;

  const taskAttributes = {
    customerPhone: req.body.From || '',
    callSummary: handoffData.callSummary || '',
    sentiment: handoffData.sentiment || 'neutral',
    escalationReason: handoffData.reason || 'Customer requested agent',
    orderDetails: handoffData.orderDetails || {},
    floristId: handoffData.tfid || '',
    floristName: handoffData.floristName || '',
    conversationId: handoffData.conversationId || '',  // <-- reference to full transcript
    taskChannel: 'voice'
  };

  console.log('Enqueue task attributes:', JSON.stringify(taskAttributes));

  res.set('Content-Type', 'text/xml');
  res.send([
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    '  <Enqueue workflowSid="' + workflowSid + '">',
    '    <Task>' + JSON.stringify(taskAttributes) + '</Task>',
    '  </Enqueue>',
    '</Response>'
  ].join('\n'));
});

wss.on('connection', function(ws) {
  console.log('ConversationRelay connected');

  var sessionTfid = '';
  var sessionFloristName = '';
  var sessionFloristPhone = '';
  var sessionCustomerPhone = '';
  var conversationId = '';

  var messages = [
    {
      role: 'system',
      content: 'You are a helpful florist assistant. Help customers with orders, delivery questions, and general inquiries. If the customer is frustrated or asks for a human agent, use the transferToAgent function.'
    }
  ];

  var tools = [
    {
      type: 'function',
      function: {
        name: 'transferToAgent',
        description: 'Transfer to human agent when customer requests it',
        parameters: {
          type: 'object',
          properties: {
            reason: { type: 'string' },
            callSummary: { type: 'string' },
            sentiment: { type: 'string', enum: ['positive', 'neutral', 'frustrated'] },
            orderDetails: { type: 'object' }
          },
          required: ['reason', 'callSummary', 'sentiment']
        }
      }
    }
  ];

  ws.on('message', async function(data) {
    try {
      var msg = JSON.parse(data);
      console.log('Received type:', msg.type);

      if (msg.type === 'setup') {
        var params = msg.customParameters || {};
        sessionTfid = params.tfid || '';
        sessionFloristName = params.floristName || '';
        sessionFloristPhone = params.floristPhone || '';
        sessionCustomerPhone = msg.from || '';
        conversationId = msg.callSid || ('conv-' + Date.now());
        console.log('Session started. conversationId:', conversationId, 'tfid:', sessionTfid);
        return;
      }

      if (msg.type === 'prompt') {
        messages.push({ role: 'user', content: msg.voicePrompt });

        var response = await openai.chat.completions.create({
          model: 'gpt-4',
          messages: messages,
          tools: tools,
          tool_choice: 'auto'
        });

        var choice = response.choices[0];

        if (choice.finish_reason === 'tool_calls') {
          var args = JSON.parse(choice.message.tool_calls[0].function.arguments);

          // Build the full transcript from the conversation so far
          var transcript = messages
            .filter(function(m) { return m.role === 'user' || m.role === 'assistant'; })
            .map(function(m) { return { role: m.role, text: m.content }; });

          // Save full payload server-side (Pattern B)
          saveTranscript(conversationId, {
            conversationId: conversationId,
            tfid: sessionTfid,
            floristName: sessionFloristName,
            floristPhone: sessionFloristPhone,
            customerPhone: sessionCustomerPhone,
            sentiment: args.sentiment,
            escalationReason: args.reason,
            callSummary: args.callSummary,
            orderDetails: args.orderDetails || {},
            transcript: transcript,
            savedAt: new Date().toISOString()
          });

          // Only the reference + small fields travel with the task
          ws.send(JSON.stringify({
            type: 'end',
            handoffData: JSON.stringify({
              reason: args.reason,
              callSummary: args.callSummary,
              sentiment: args.sentiment,
              orderDetails: args.orderDetails || {},
              tfid: sessionTfid,
              floristName: sessionFloristName,
              conversationId: conversationId
            })
          }));
        } else {
          var reply = choice.message.content;
          messages.push({ role: 'assistant', content: reply });
          ws.send(JSON.stringify({ type: 'text', token: reply, last: true }));
        }
      }
    } catch (err) {
      console.error('Error handling message:', err);
    }
  });

  ws.on('close', function() { console.log('ConversationRelay disconnected'); });
  ws.on('error', function(err) { console.error('WebSocket error:', err); });
});

var PORT = process.env.PORT || 3000;
server.listen(PORT, function() { console.log('Server running on port ' + PORT); });
