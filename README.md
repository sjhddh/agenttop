# AgentTop

`AgentTop` is a terminal-first dashboard for monitoring LLM API usage in real-time.

## Features

- Transparent proxy for OpenAI and Anthropic requests
- Real-time token throughput chart
- Model-level cost breakdown
- Live request log with latency and token stats
- Session cost LCD display

## Run

```bash
npm install
npm run build
npm start
```

Or in development mode:

```bash
npm run dev
```

Then point your AI tool's base URL to:

`http://localhost:8080/v1`
