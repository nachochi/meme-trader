import express from 'express';
import { Keypair } from '@solana/web3.js';
import { Connection, PublicKey } from '@solana/web3.js';
import { Liquidity, Token, TokenAmount, Percent } from '@raydium-io/raydium-sdk';
import { Market, MARKET_STATE_LAYOUT_V3 } from '@project-serum/serum';
import bs58 from 'bs58';
import Sentiment from 'sentiment';

// Initialize Express app
const app = express();
const port = 8080;

// Solana connection
const SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com';
const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

// Wallet setup (Phantom private key from environment)
const PRIVATE_KEY = process.env.PHANTOM_PRIVATE_KEY || 'your_phantom_private_key_here';
const keypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const WALLET_ADDRESS = keypair.publicKey;

// Token pair (SOL/SRM as example, replace SRM with your memecoin)
const SOL_TOKEN = new Token(
  new PublicKey('So11111111111111111111111111111111111111112'), // Wrapped SOL
  9, // Decimals
  'SOL',
  'SOL'
);
const SRM_TOKEN = new Token(
  new PublicKey('SRMuApVNtYWHWHHBgyiTSDd8BkUGrAscgtSJBhgmxGZm'), // Replace with your memecoin
  6, // Adjust decimals for your token
  'SRM',
  'SRM'
);
const SYMBOL = 'SRM/SOL';
const TRADE_AMOUNT = 0.01; // 0.01 SOL (~$2 at $200/SOL)
const SENTIMENT_THRESHOLD = 0.2;

// Sentiment analyzer
const sentiment = new Sentiment();

// Fetch price from Raydium pool
async function fetchPrice(): Promise<number | string> {
  try {
    const poolKeys = await fetch('https://api.raydium.io/v2/sdk/liquidity/mainnet.json')
      .then(res => res.json())
      .then(data => data.official.find((p: any) => 
        (p.baseMint === SOL_TOKEN.mint.toBase58() && p.quoteMint === SRM_TOKEN.mint.toBase58()) ||
        (p.baseMint === SRM_TOKEN.mint.toBase58() && p.quoteMint === SOL_TOKEN.mint.toBase58())
      ));
    if (!poolKeys) throw new Error('Pool not found');

    const market = await Market.load(connection, new PublicKey(poolKeys.marketId), {}, new PublicKey(poolKeys.openOrders));
    const { bids, asks } = await market.loadOrderbook(connection);
    const midPrice = (bids[0]?.price + asks[0]?.price) / 2 || 0.05; // Fallback to mock
    return midPrice; // SRM per SOL
  } catch (e) {
    return `Error fetching price: ${e.message}`;
  }
}

// Fetch mock sentiment (replace with X API if desired)
async function fetchSentiment(): Promise<number | string> {
  try {
    const mockPosts = ["SRM is pumping!", "Sell this junk", "To the moon!"];
    const scores = mockPosts.map(post => sentiment.analyze(post).comparative);
    return scores.reduce((a, b) => a + b, 0) / scores.length || 0;
  } catch (e) {
    return `Error fetching sentiment: ${e.message}`;
  }
}

// Check SOL and token balance
async function checkBalance(): Promise<{ SOL: number; SRM: number } | string> {
  try {
    const solBalance = await connection.getBalance(WALLET_ADDRESS) / 1_000_000_000; // Lamports to SOL
    const tokenAccounts = await connection.getTokenAccountsByOwner(WALLET_ADDRESS, { mint: SRM_TOKEN.mint });
    const srmBalance = tokenAccounts.value.length > 0
      ? (await connection.getTokenAccountBalance(tokenAccounts.value[0].pubkey)).value.uiAmount || 0
      : 0;
    return { SOL: solBalance, SRM: srmBalance };
  } catch (e) {
    return `Error fetching balance: ${e.message}`;
  }
}

// Execute trade on Raydium
async function executeTrade(action: 'buy' | 'sell'): Promise<string> {
  try {
    const poolKeys = await fetch('https://api.raydium.io/v2/sdk/liquidity/mainnet.json')
      .then(res => res.json())
      .then(data => data.official.find((p: any) => 
        (p.baseMint === SOL_TOKEN.mint.toBase58() && p.quoteMint === SRM_TOKEN.mint.toBase58()) ||
        (p.baseMint === SRM_TOKEN.mint.toBase58() && p.quoteMint === SOL_TOKEN.mint.toBase58())
      ));
    if (!poolKeys) throw new Error('Pool not found');

    const amountIn = action === 'buy'
      ? new TokenAmount(SOL_TOKEN, TRADE_AMOUNT * 10 ** SOL_TOKEN.decimals, false)
      : new TokenAmount(SRM_TOKEN, 0.1 * 10 ** SRM_TOKEN.decimals, false); // 0.1 SRM
    const tokenOut = action === 'buy' ? SRM_TOKEN : SOL_TOKEN;

    const { transaction, signers } = await Liquidity.makeSwapTransaction({
      connection,
      poolKeys,
      userKeys: {
        tokenAccounts: await connection.getTokenAccountsByOwner(WALLET_ADDRESS, { programId: TOKEN_PROGRAM_ID }),
        payer: WALLET_ADDRESS,
      },
      amountIn,
      amountOut: new TokenAmount(tokenOut, 0), // Min amount out (slippage protection)
      fixedSide: 'in',
      slippage: new Percent(5, 100), // 5% slippage
    });

    transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    transaction.sign(keypair, ...signers);
    const txid = await connection.sendRawTransaction(transaction.serialize());
    return `${action.capitalize()} tx sent: ${txid}`;
  } catch (e) {
    return `Error executing ${action}: ${e.message}`;
  }
}

// Automated trading logic
async function autoTrade(): Promise<string> {
  const [price, sentiment, balance] = await Promise.all([fetchPrice(), fetchSentiment(), checkBalance()]);
  
  if (typeof price === 'number' && typeof sentiment === 'number' && typeof balance !== 'string') {
    if (sentiment > SENTIMENT_THRESHOLD && balance.SOL >= TRADE_AMOUNT) {
      return await executeTrade('buy');
    } else if (sentiment < -SENTIMENT_THRESHOLD && balance.SRM > 0) {
      return await executeTrade('sell');
    } else {
      return "No trade: Sentiment or balance not favorable";
    }
  }
  return "Auto trade skipped due to error";
}

// API Endpoints
app.get('/price', async (req, res) => {
  const price = await fetchPrice();
  res.json({ symbol: SYMBOL, price });
});

app.get('/sentiment', async (req, res) => {
  const sentimentScore = await fetchSentiment();
  res.json({ sentiment: sentimentScore });
});

app.get('/balance', async (req, res) => {
  const balance = await checkBalance();
  res.json(balance);
});

app.get('/trade/:action', async (req, res) => {
  const action = req.params.action as 'buy' | 'sell';
  if (action !== 'buy' && action !== 'sell') {
    return res.json({ status: 'Invalid action' });
  }
  const result = await executeTrade(action);
  res.json({ status: result });
});

app.get('/auto_trade', async (req, res) => {
  const result = await autoTrade();
  res.json({ status: result });
});

// Serve static frontend
app.use(express.static('public'));

// Start server
app.listen(port, () => {
  console.log(`Server running at http://0.0.0.0:${port}`);
});
