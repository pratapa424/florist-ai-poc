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

app.get('/', (req, res) => res.send('Florist AI POC running'));

app.post('/incoming-call', (req, res) => {
  const host = req.headers.host;
  res.set('Content-Type', 'text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Connect action="https://${host}/enqueue-to-flex">
        <ConversationRelay 
          url="wss://${host}/ai-session" 
          welcomeGreeting="Thank you for calling. How can I help you today?"
        />
      </Connect>
    </Response>`);
});

app.post('/enqueue-to-flex', (req, res) => {
  const handoffData = JSON.parse(req.body.HandoffData || '{}');
  const workflowSid = process.env.TWILIO_WORKFLOW_SID;

  res.set('Content-Type', 'text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Enqueue workflowSid="${workflowSid}">
        <Task>${JSON.stringify({
          customerPhone:    req.body.From,
          callSummary:      handoffData.callSummary      || '',
          sentiment:        handoffData.sentiment        || 'neutral',
          escalationReason: handoffData.reason           || 'Customer requested agent',
          orderDetails:     handoffData.orderDetails     || {},
          floristId:        handoffData.floristId        || '',
          floristName:      handoffData.floristName      || '',
          taskChannel:      'voice'
        })}</Task>
      </Enqueue>
    </Response>`);
});

wss.on('connection', (ws) => {
  console.log('ConversationRelay connected');

  let messages = [
    {
      role: 'system',
      content: `You are a helpful florist assistant. 
      Help customers with orders, delivery questions, and general inquiries.
      If the customer is frustrated or asks for a human agent, 
      use the transferToAgent function.`
    }
  ];

  const tools = [
    {
      type: 'function',
      function: {
        name: 'transferToAgent',
        description: 'Transfer to human agent when customer requests it',
        parameters: {
          type: 'object',
          properties: {
            reason:       { type: 'string' },
            callSummary:  { type: 'string' },
            sentiment:    { type: 'string', enum: ['positive', 'neutral', 'frustrated'] },
            orderDetails: { type: 'object' }
          },
          required: ['reason', 'callSummary', 'sentiment']
        }
      }
    }
  ];

  ws.on('message', async (data) => {
    const msg = JSON.parse(data);
    console.log('Received:', msg.type);

    if (msg.type === 'prompt') {
      messages.push({ role: 'user', content: msg.voicePrompt });

      const response = await openai.chat.completions.create({
        model: 'gpt-4',
        messages,
        tools,
        tool_choice: 'auto'
      });

      const choice = response.choices[0];

      if (choice.finish_reason === 'tool_calls') {
        const args = JSON.parse(choice.message.tool_calls[0].function.arguments);
        ws.send(JSON.stringify({
          type: 'end',
          handoffData:
