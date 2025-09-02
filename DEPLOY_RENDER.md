# Deploying to Render

## Prerequisites
- GitHub account
- Render account (sign up at render.com)
- Bot already tested locally

## Deployment Steps

### 1. Push to GitHub
```bash
git add .
git commit -m "Add Render deployment configuration"
git push origin main
```

### 2. Connect to Render
1. Go to [Render Dashboard](https://dashboard.render.com)
2. Click "New +" → "Background Worker"
3. Connect your GitHub repository
4. Select the FlashPendle repository

### 3. Configure Environment Variables
In Render dashboard, add these **secret** environment variables:
- `PRIVATE_KEY`: Your wallet private key (⚠️ Mark as SECRET!)
- `ARBITRUM_RPC_URL`: Your Arbitrum RPC endpoint (recommend Alchemy/Infura for reliability)

The other variables are already in `render.yaml`.

### 4. Deploy
1. Click "Create Background Worker"
2. Render will build and deploy automatically
3. Monitor logs in the Render dashboard

## Monitoring

### Health Check
Your bot exposes a health endpoint at:
```
https://[your-service].onrender.com/health
```

Returns:
```json
{
  "status": "healthy",
  "uptime": 3600,
  "lastCheck": "2025-09-02T14:00:00.000Z",
  "opportunitiesFound": 42,
  "executedTrades": 3,
  "wallet": "0x9eB5...",
  "contract": "0x3894...",
  "isRunning": true
}
```

### Logs
View real-time logs in Render dashboard under "Logs" tab.

## Cost
- **Starter Plan**: $7/month per service
- Includes 750 hours/month (enough for 24/7 operation)
- Auto-scaling not needed for this bot

## Security Notes
1. **NEVER commit `.env` with private key**
2. Use Render's secret environment variables
3. Consider using a dedicated wallet with limited funds
4. Monitor wallet balance regularly

## Troubleshooting

### Bot not finding opportunities
- Normal - markets are usually efficient
- Check during high volatility periods
- Verify market addresses are current

### High gas costs
- Increase `MIN_PROFIT_BPS` in environment variables
- Use a more reliable RPC with better gas estimation

### Connection errors
- Upgrade to paid RPC provider (Alchemy/Infura)
- Check Arbitrum network status

## Updating the Bot
1. Push changes to GitHub
2. Render auto-deploys on push (if enabled)
3. Or manually deploy from Render dashboard

## Stopping the Bot
1. Go to Render dashboard
2. Click "Suspend" to stop temporarily
3. Or "Delete" to remove completely