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

app.get('/', (req, res) => {
  res.send('Florist AI POC running');
});

app.post('/incoming-call', (req, res) => {
  const host = req.headers.host;
  res.set('Content-Type', 'text/xml');
  res.send([
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    '  <Connect action="https://' + host + '/enqueue-to-flex">',
    '    <ConversationRelay',
    '      url="wss://' + host + '/ai-session"',
    '      welcomeGreeting="Thank you for calling. How can I help you today?"',
    '    />',
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
    floristId: handoffData.floristId || '',
    floristName: handoffData.floristName || '',
    taskChannel: 'voice'
  };
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
            sentiment: {
              type: 'string',
              enum: ['positive', 'neutral', 'frustrated']
            },
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
          ws.send(JSON.stringify({
            type: 'end',
            handoffData: JSON.stringify({
              reason: args.reason,
              callSummary: args.callSummary,
              sentiment: args.sentiment,
              orderDetails: args.orderDetails || {}
            })
          }));
        } else {
          var reply = choice.message.content;
          messages.push({ role: 'assistant', content: reply });
          ws.send(JSON.stringify({
            type: 'text',
            token: reply,
            last: true
          }));
        }
      }
    } catch (err) {
      console.error('Error handling message:', err);
    }
  });

  ws.on('close', function() {
    console.log('ConversationRelay disconnected');
  });

  ws.on('error', function(err) {
    console.error('WebSocket error:', err);
  });
});

var PORT = process.env.PORT || 3000;
server.listen(PORT, function() {
  console.log('Server running on port ' + PORT);
});
