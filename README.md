# State Aggregator for Municipal Officials

Operational intelligence system for Massachusetts municipal officials. Monitors state legislation and agency guidance, translating it into clear, actionable operational impact analysis.

## Purpose

Reduce risk, cognitive load, and uncertainty for municipal officials by providing role-specific, action-oriented interpretation of state actions. **Clarity, accuracy, and trust over completeness or speed.**

## What It Does

- Monitors MA Legislature bills for significant actions
- Extracts bill history and identifies new developments
- Analyzes operational impact for municipal government
- Generates plain-English briefs for town managers, clerks, finance directors, etc.
- Deduplicates using SHA-256 hashing
- Filters noise by only analyzing significant legislative actions

## Quick Start

### Deploy to Railway

1. Fork or clone this repository
2. Go to https://railway.app
3. Login with GitHub
4. Click "New Project" → "Deploy from GitHub repo"
5. Select this repository
6. Add environment variable: `ANTHROPIC_API_KEY` (get from https://console.anthropic.com/)
7. Deploy!

### API Endpoints

**POST /api/collect** - Collect and analyze bills
**GET /api/briefs** - Get all briefs
**GET /api/briefs/:id** - Get single brief
**GET /health** - Health check

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Your Anthropic API key |
| `PORT` | No | Server port (default: 3001) |

## Cost Estimates

**Hosting (Railway):** $5-8/month  
**Anthropic API:** $30-60/month (depends on usage)  
**Total:** ~$35-70/month

## License

MIT
