import os
from fastapi import FastAPI
import uvicorn
import asyncio
import aiohttp
from solana.rpc.async_api import AsyncClient
from solana.keypair import Keypair
from solana.publickey import PublicKey
from solana.transaction import Transaction
from solders.system_program import TransferParams, transfer
from solders.signature import Signature
from spl.token.async_client import AsyncToken
from spl.token.constants import TOKEN_PROGRAM_ID
from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer
import base58
import json

# Initialize FastAPI app
app = FastAPI()

# Solana client setup
SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com"
client = AsyncClient(SOLANA_RPC_URL)

# Wallet setup (Phantom private key from environment)
PRIVATE_KEY = os.getenv('PHANTOM_PRIVATE_KEY', 'your_phantom_private_key_here')
keypair = Keypair.from_secret_key(base58.b58decode(PRIVATE_KEY))
WALLET_ADDRESS = keypair.public_key

# Token pair (SOL/SRM as example, replace SRM with your memecoin)
SOL_ADDRESS = PublicKey("So11111111111111111111111111111111111111112")  # Wrapped SOL
SRM_ADDRESS = PublicKey("SRMuApVNtYWHWHHBgyiTSDd8BkUGrAscgtSJBhgmxGZm")  # Replace with your memecoin
SYMBOL = "SRM/SOL"
TRADE_AMOUNT = 0.01  # 0.01 SOL (~$2 at $200/SOL)

# Sentiment analyzer
analyzer = SentimentIntensityAnalyzer()
SENTIMENT_THRESHOLD = 0.2

# Fetch price (mocked; real Raydium price fetching requires additional setup)
async def fetch_price():
    try:
        # Placeholder: Use Birdeye.so or Raydium API for real price in production
        async with aiohttp.ClientSession() as session:
            async with session.get(f"https://api.birdeye.so/v1/price?address={SRM_ADDRESS}") as resp:
                data = await resp.json()
                return data['data']['value'] if 'data' in data else 0.05  # SRM per SOL fallback
    except Exception as e:
        return f"Error fetching price: {str(e)}"

# Fetch mock sentiment (replace with real X API if available)
async def fetch_sentiment():
    async with aiohttp.ClientSession() as session:
        mock_posts = ["SRM is pumping!", "Sell this junk", "To the moon!"]
        scores = [analyzer.polarity_scores(post)['compound'] for post in mock_posts]
        avg_sentiment = sum(scores) / len(scores) if scores else 0
        return avg_sentiment

# Check SOL and token balance
async def check_balance():
    try:
        sol_balance = await client.get_balance(WALLET_ADDRESS)
        sol_balance_lamports = sol_balance.value
        token_client = AsyncToken(client, SRM_ADDRESS, TOKEN_PROGRAM_ID, keypair)
        token_account = await token_client.get_accounts(WALLET_ADDRESS)
        token_balance = 0
        if token_account.value:
            token_balance = (await token_client.get_balance(token_account.value[0].pubkey)).value.ui_amount
        return {
            "SOL": sol_balance_lamports / 1_000_000_000,  # Convert lamports to SOL
            "SRM": token_balance or 0
        }
    except Exception as e:
        return f"Error fetching balance: {str(e)}"

# Execute trade (simplified Raydium swap placeholder)
async def execute_trade(action):
    try:
        tx = Transaction()
        if action == "buy":
            # Simplified: Send SOL to a mock Raydium pool
            tx.add(transfer(TransferParams(
                from_pubkey=WALLET_ADDRESS,
                to_pubkey=PublicKey("RaydiumPoolAddressHere"),  # Replace with actual pool
                lamports=int(TRADE_AMOUNT * 1_000_000_000)
            )))
        elif action == "sell":
            token_client = AsyncToken(client, SRM_ADDRESS, TOKEN_PROGRAM_ID, keypair)
            token_account = (await token_client.get_accounts(WALLET_ADDRESS)).value[0].pubkey
            tx.add(token_client.transfer(
                source=token_account,
                dest=PublicKey("RaydiumPoolAddressHere"),  # Replace with actual pool
                owner=keypair,
                amount=int(0.1 * 1_000_000_000)  # 0.1 SRM, adjust decimals
            ))

        recent_blockhash = (await client.get_latest_blockhash()).value.blockhash
        tx.recent_blockhash = recent_blockhash
        tx.sign(keypair)
        raw_tx = bytes(tx)
        signature = await client.send_raw_transaction(raw_tx)
        return f"{action.capitalize()} tx sent: {str(signature.value)}"
    except Exception as e:
        return f"Error executing {action}: {str(e)}"

# Automated trading logic
async def auto_trade():
    price = await fetch_price()
    sentiment = await fetch_sentiment()
    balance = await check_balance()
    
    if isinstance(price, float) and isinstance(sentiment, float) and isinstance(balance, dict):
        if sentiment > SENTIMENT_THRESHOLD and balance["SOL"] >= TRADE_AMOUNT:
            return await execute_trade("buy")
        elif sentiment < -SENTIMENT_THRESHOLD and balance["SRM"] > 0:
            return await execute_trade("sell")
        else:
            return "No trade: Sentiment or balance not favorable"
    return "Auto trade skipped due to error"

# API Endpoints
@app.get("/price")
async def get_price():
    price = await fetch_price()
    return {"symbol": SYMBOL, "price": price}

@app.get("/sentiment")
async def get_sentiment():
    sentiment = await fetch_sentiment()
    return {"sentiment": sentiment}

@app.get("/balance")
async def get_balance():
    balance = await check_balance()
    return balance

@app.get("/trade/{action}")
async def manual_trade(action: str):
    if action in ["buy", "sell"]:
        result = await execute_trade(action)
        return {"status": result}
    return {"status": "Invalid action"}

@app.get("/auto_trade")
async def run_auto_trade():
    result = await auto_trade()
    return {"status": result}

# Run the server
if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8080)
