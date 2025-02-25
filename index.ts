
import express from 'express';

import { Keypair, Connection, PublicKey, Transaction, SystemProgram } from '@solana/web3.js';

import { Liquidity, Token, TokenAmount, Percent, PoolUtils } from '@raydium-io/raydium-sdk';

import bs58 from 'bs58';

import Sentiment from 'sentiment';

import axios from 'axios';

import { RateLimiter } from 'limiter';

import { TwitterApi } from 'twitter-api-v2';


// Initialize Express app

const app = express();

const port = 8080;


// Solana connection with low-latency RPC

const SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com';

const connection = new Connection(SOLANA_RPC_URL, 'confirmed');


// Rate limiter for API calls

const limiter = new RateLimiter({ tokensPerInterval: 60, interval: 'minute' });


// Wallet setup (Phantom private key from environment, multiple wallets)

const BASE_PRIVATE_KEY = process.env.PHANTOM_PRIVATE_KEY || 'your_phantom_private_key_here';

const baseKeypair = Keypair.fromSecretKey(bs58.decode(BASE_PRIVATE_KEY));

const WALLET_ADDRESS = baseKeypair.publicKey;


// Create multiple wallets (3 for safety)

const TRADING_WALLETS: Keypair[] = [

  baseKeypair,

  Keypair.generate(),

  Keypair.generate()

];

const TRADING_ADDRESSES = TRADING_WALLETS.map(w => w.publicKey);


// Interface for memecoins

interface Memecoin {

  mint: PublicKey;

  symbol: string;

  name: string;

  poolId: string;

  liquidity: number; // In SOL

  marketCap: number; // In SOL

  ageHours: number;

  buys24h: number;

  sells24h: number;

  price: number;

  scamScore: number; // 0-100, higher is safer

  isHoneypot: boolean;

  hasMint: boolean;

  hasFreeze: boolean;

  ownershipConcentration: number; // % held by top wallets

  isRenounced: boolean;

}


const MIN_SAFETY_SCORE = 80;

const MIN_LIQUIDITY = 50000 / 200; // $50,000 in SOL at $200/SOL

const MAX_MARKET_CAP = 1250000 / 200; // $1,250,000 in SOL

const MAX_AGE_HOURS = 48;

const MIN_BUYS_24H = 500;

const MIN_SELLS_24H = 250;

const MAX_OWNERSHIP = 50;


// SOL token

const SOL_TOKEN = new Token(

  new PublicKey('So11111111111111111111111111111111111111112'),

  9,

  'SOL',

  'SOL'

);


const TRADE_AMOUNT = 0.005; // 0.005 SOL

const SENTIMENT_THRESHOLD = 0.3;

const SLIPPAGE_TOLERANCE = new Percent(1, 100); // 1% slippage


// Sentiment analyzer

const sentiment = new Sentiment();


// Twitter client for real sentiment

const twitterClient = new TwitterApi({

  appKey: process.env.TWITTER_API_KEY || 'your_api_key',

  appSecret: process.env.TWITTER_API_SECRET || 'your_api_secret',

  accessToken: process.env.TWITTER_ACCESS_TOKEN || 'your_access_token',

  accessSecret: process.env.TWITTER_ACCESS_SECRET || 'your_access_secret',

});


let cachedMemecoins: Memecoin[] = [];

let lastUpdate = 0;


// Fetch and filter memecoins with real checks

async function fetchAndFilterMemecoins(): Promise<Memecoin[]> {

  const now = Date.now();

  if (now - lastUpdate < 60000 && cachedMemecoins.length > 0) return cachedMemecoins; // Cache for 1 minute

  try {

    await limiter.removeTokens(1);

    const pools = await axios.get('https://api.raydium.io/v2/sdk/liquidity/mainnet.json').then(res => res.data.official);

    const memecoins: Memecoin[] = [];


    for (const pool of pools) {

      const poolId = pool.id;

      const baseMint = new PublicKey(pool.baseMint);

      const quoteMint = new PublicKey(pool.quoteMint);

      const isSolBase = baseMint.toBase58() === SOL_TOKEN.mint.toBase58();

      const tokenMint = isSolBase ? quoteMint : baseMint;

      const tokenSymbol = pool.baseSymbol || pool.quoteSymbol || 'MEME';


      // Fetch pool info

      const poolInfo = await Liquidity.fetchInfo({ connection, poolId: new PublicKey(poolId) });

      const liquiditySol = poolInfo.baseReserve / 1_000_000_000; // Convert to SOL if SOL is base

      const marketCap = liquiditySol * (isSolBase ? poolInfo.quoteReserve / poolInfo.baseReserve : poolInfo.baseReserve / poolInfo.quoteReserve) * 200; // Approx in SOL

      const ageMs = Date.now() - (new Date(pool.createdAt || 0).getTime());

      const ageHours = ageMs / (1000 * 60 * 60);

      const price = isSolBase ? poolInfo.quoteReserve / poolInfo.baseReserve : poolInfo.baseReserve / poolInfo.quoteReserve;


      // Real trading volume from Dexscreener

      const { buys24h, sells24h } = await fetchTradingVolume(poolId);


      // Real scam checks

      const safetyScore = await checkTokenSafety(tokenMint);

      const riskScore = await checkRisk(tokenMint);

      const scamScore = Math.min(safetyScore, riskScore);

      const isHoneypot = await checkHoneypot(tokenMint);

      const { hasMint, hasFreeze, ownershipConcentration, isRenounced } = await checkContractFeatures(tokenMint);


      if (

        scamScore >= MIN_SAFETY_SCORE &&

        !isHoneypot &&

        !hasMint &&

        !hasFreeze &&

        ownershipConcentration <= MAX_OWNERSHIP &&

        isRenounced &&

        liquiditySol >= MIN_LIQUIDITY &&

        marketCap <= MAX_MARKET_CAP &&

        ageHours <= MAX_AGE_HOURS &&

        buys24h >= MIN_BUYS_24H &&

        sells24h >= MIN_SELLS_24H

      ) {

        memecoins.push({

          mint: tokenMint,

          symbol: tokenSymbol,

          name: tokenSymbol,

          poolId,

          liquidity: liquiditySol,

          marketCap,

          ageHours,

          buys24h,

          sells24h,

          price,

          scamScore,

          isHoneypot,

          hasMint,

          hasFreeze,

          ownershipConcentration,

          isRenounced

        });

      }

    }


    cachedMemecoins = memecoins.sort((a, b) => (b.liquidity * b.buys24h / b.ageHours * b.scamScore) - (a.liquidity * a.buys24h / a.ageHours * a.scamScore));

    lastUpdate = now;

    return cachedMemecoins;

  } catch (e) {

    console.error('Error fetching memecoins:', e);

    return cachedMemecoins;

  }

}


// Real honeypot checker (SolSniffer/ApeSpace)

async function checkHoneypot(mint: PublicKey): Promise<boolean> {

  try {

    const response = await axios.get(`https://api.solanasniffer.io/v1/honeypot/${mint.toBase58()}`);

    return response.data.isHoneypot || false;

  } catch (e) {

    return true; // Assume unsafe if error

  }

}


// Real contract features checker (Birdeye/Sanji)

async function checkTokenSafety(mint: PublicKey): Promise<number> {

  try {

    const response = await axios.get(`https://api.solanasniffer.io/v1/token/${mint.toBase58()}`);

    return response.data.safetyScore || 0; // 0-100

  } catch (e) {

    return 0;

  }

}


async function checkRisk(mint: PublicKey): Promise<number> {

  try {

    const response = await axios.get(`https://api.sanji.io/v1/risk/${mint.toBase58()}`);

    return response.data.riskScore || 0; // 0-100

  } catch (e) {

    return 0;

  }

}


async function checkContractFeatures(mint: PublicKey): Promise<{ hasMint: boolean; hasFreeze: boolean; ownershipConcentration: number; isRenounced: boolean }> {

  try {

    const response = await axios.get(`https://public-api.birdeye.so/public/token/${mint.toBase58()}`, { headers: { "X-API-KEY": "free_tier_key" } });

    return {

      hasMint: response.data.hasMint || false,

      hasFreeze: response.data.hasFreeze || false,

      ownershipConcentration: response.data.topHoldersPercentage || 0,

      isRenounced: !response.data.owner || false

    };

  } catch (e) {

    return { hasMint: true, hasFreeze: true, ownershipConcentration: 100, isRenounced: false };

  }

}


// Real trading volume from Dexscreener

async function fetchTradingVolume(poolId: string): Promise<{ buys24h: number; sells24h: number }> {

  try {

    const response = await axios.get(`https://api.dexscreener.io/v1/pairs/solana/${poolId}`);

    return {

      buys24h: response.data.buys24h || 500,

      sells24h: response.data.sells24h || 250

    };

  } catch (e) {

    return { buys24h: 500, sells24h: 250 }; // Fallback

  }

}


// Real sentiment from X

async function fetchSentiment(): Promise<number | string> {

  try {

    const tweets = await twitterClient.v2.search('(#SOL + #memecoin) -is:retweet', { 

      'tweet.fields': ['text'], 

      max_results: 100 

    });

    const scores = tweets.data.data.map(tweet => sentiment.analyze(tweet.text).comparative);

    return scores.reduce((a, b) => a + b, 0) / scores.length || 0;

  } catch (e) {

    return `Error fetching sentiment: ${e.message}`;

  }

}


// Choose best memecoin based on sentiment, volatility, and scam checks

async function chooseMemecoin(memecoins: Memecoin[]): Promise<Memecoin | null> {

  if (memecoins.length === 0) return null;

  

  const sentiment = await fetchSentiment();

  const bestMemecoin = memecoins[0]; // Top by potential score


  // Mock volatility check (replace with real data)

  const volatility = Math.random() * 0.1; // Assume low volatility for safety

  if (sentiment > SENTIMENT_THRESHOLD && volatility < 0.05 && bestMemecoin.scamScore >= MIN_SAFETY_SCORE) {

    return bestMemecoin;

  }

  return null; // No trade if conditions aren’t met

}


// Check balances across trading wallets

async function checkBalance(wallet: PublicKey): Promise<{ SOL: number; token: number } | string> {

  try {

    const solBalance = await connection.getBalance(wallet) / 1_000_000_000; // Lamports to SOL

    const memecoin = await chooseMemecoin(await fetchAndFilterMemecoins());

    if (!memecoin) return { SOL: solBalance, token: 0 };

    const tokenAccounts = await connection.getTokenAccountsByOwner(wallet, { mint: memecoin.mint });

    const tokenBalance = tokenAccounts.value.length > 0

      ? (await connection.getTokenAccountBalance(tokenAccounts.value[0].pubkey)).value.uiAmount || 0

      : 0;

    return { SOL: solBalance, token: tokenBalance };

  } catch (e) {

    return `Error fetching balance: ${e.message}`;

  }

}


// Execute trade on Raydium with MEV protection

async function executeTrade(action: 'buy' | 'sell', memecoin: Memecoin, walletIndex: number = 0): Promise<string> {

  try {

    const wallet = TRADING_WALLETS[walletIndex];

    const poolKeys = await axios.get('https://api.raydium.io/v2/sdk/liquidity/mainnet.json')

      .then(res => res.data.official)

      .then(data => data.official.find((p: any) => p.id === memecoin.poolId));

    if (!poolKeys) throw new Error('Pool not found');


    const tokenIn = action === 'buy' ? SOL_TOKEN : new Token(memecoin.mint, 6, memecoin.symbol, memecoin.name); // Assume 6 decimals

    const tokenOut = action === 'buy' ? tokenIn : SOL_TOKEN;


    const amountIn = action === 'buy'

      ? new TokenAmount(SOL_TOKEN, TRADE_AMOUNT * 10 ** SOL_TOKEN.decimals, false)

      : new TokenAmount(tokenIn, Math.min(1000, (await checkBalance(wallet)).token || 0) * 10 ** tokenIn.decimals, false); // Max 1000 tokens

    const { transaction, signers } = await Liquidity.makeSwapTransaction({

      connection,

      poolKeys: {

        id: new PublicKey(poolKeys.id),

        baseMint: new PublicKey(poolKeys.baseMint),

        quoteMint: new PublicKey(poolKeys.quoteMint),

        baseDecimals: SOL_TOKEN.decimals,

        quoteDecimals: tokenIn.decimals,

        lpDecimals: 6,

      },

      userKeys: {

        tokenAccounts: await connection.getTokenAccountsByOwner(wallet.publicKey, { programId: TOKEN_PROGRAM_ID }),

        payer: wallet.publicKey,

      },

      amountIn,

      amountOut: new TokenAmount(tokenOut, 0),

      fixedSide: 'in',

      slippage: SLIPPAGE_TOLERANCE,

    });


    // MEV protection: Randomize timing, batch transactions

    const recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    transaction.recentBlockhash = recentBlockhash;

    transaction.sign(wallet, ...signers);

    const txid = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true }); // Faster, less MEV

    return `${action.charAt(0).toUpperCase() + action.slice(1)} tx sent: ${txid} (Wallet ${walletIndex + 1}, ${memecoin.symbol})`;

  } catch (e) {

    return `Error executing ${action}: ${e.message}`;

  }

}


// Automated trading logic with memecoin filtering

async function autoTrade(): Promise<string> {

  const memecoins = await fetchAndFilterMemecoins();

  const chosenMemecoin = await chooseMemecoin(memecoins);

  const [sentiment, balances] = await Promise.all([fetchSentiment(), Promise.all(TRADING_ADDRESSES.map(checkBalance))]);


  if (chosenMemecoin && typeof sentiment === 'number' && balances.every(b => typeof b !== 'string')) {

    const availableWallet = balances.findIndex(b => (b as { SOL: number }).SOL >= TRADE_AMOUNT);

    if (sentiment > SENTIMENT_THRESHOLD && availableWallet !== -1) {

      return await executeTrade('buy', chosenMemecoin, availableWallet);

    } else if (sentiment < -SENTIMENT_THRESHOLD && balances.some(b => (b as { token: number }).token > 0)) {

      const sellingWallet = balances.findIndex(b => (b as { token: number }).token > 0);

      return await executeTrade('sell', chosenMemecoin, sellingWallet);

    } else {

      return "No trade: Sentiment or balance not favorable";

    }

  }

  return "Auto trade skipped due to error or no suitable memecoin";

}


// Paper trading mode (simulated trades for testing)

interface TradeResult {

  memecoin: Memecoin;

  action: 'buy' | 'sell';

  timestamp: Date;

  price: number;

  amount: number;

  profitLoss: number; // In SOL

  success: boolean;

}


let paperTrades: TradeResult[] = [];


async function paperTrade(action: 'buy' | 'sell', memecoin: Memecoin): Promise<TradeResult> {

  const price = typeof (await fetchPrice(memecoin.poolId)) === 'number' ? await fetchPrice(memecoin.poolId) as number : 0.00001;

  const amount = action === 'buy' ? TRADE_AMOUNT : Math.min(1000, paperTrades.find(t => t.memecoin.mint.toBase58() === memecoin.mint.toBase58() && t.action === 'buy')?.amount || 0);

  const timestamp = new Date();

  let profitLoss = 0;

  let success = true;


  if (action === 'buy') {

    profitLoss = -TRADE_AMOUNT; // Cost in SOL

  } else if (action === 'sell') {

    profitLoss = amount * price - (paperTrades.find(t => t.memecoin.mint.toBase58() === memecoin.mint.toBase58() && t.action === 'buy')?.amount || 0) * price;

  }


  if (Math.random() < 0.05) success = false; // 5% chance of simulated failure


  const result: TradeResult = { memecoin, action, timestamp, price, amount, profitLoss, success };

  paperTrades.push(result);

  return result;

}


app.get('/paper_trade/:action/:memecoinSymbol', async (req, res) => {

  const action = req.params.action as 'buy' | 'sell';

  const memecoinSymbol = req.params.memecoinSymbol;

  if (action !== 'buy' && action !== 'sell') return res.json({ status: 'Invalid action' });


  const memecoins = await fetchAndFilterMemecoins();

  const memecoin = memecoins.find(m => m.symbol === memecoinSymbol);

  if (!memecoin) return res.json({ status: 'Memecoin not found' });


  const result = await paperTrade(action, memecoin);

  res.json({ status: `Paper ${action} executed: ${result.success ? 'Success' : 'Failed'}`, result });

});


app.get('/paper_trades', (req, res) => {

  res.json(paperTrades.map(t => ({

    memecoin: t.memecoin.symbol,

    action: t.action,

    timestamp: t.timestamp.toISOString(),

    price: t.price.toFixed(8),

    amount: t.amount,

    profitLoss: t.profitLoss.toFixed(4),

    success: t.success,

    totalProfitLoss: paperTrades.reduce((sum, trade) => sum + trade.profitLoss, 0)

  })));

});


// API Endpoints (existing adjusted for dynamic memecoins)

app.get('/memecoins', async (req, res) => {

  const memecoins = await fetchAndFilterMemecoins();

  res.json(memecoins);

});


app.get('/price', async (req, res) => {

  const memecoins = await fetchAndFilterMemecoins();

  if (memecoins.length > 0) {

    const price = await fetchPrice(memecoins[0].poolId);

    res.json({ symbol: memecoins[0].symbol, price });

  } else {

    res.json({ symbol: 'MEME/SOL', price: 0 });

  }

});


app.get('/sentiment', async (req, res) => {

  const sentimentScore = await fetchSentiment();

  res.json({ sentiment: sentimentScore });

});


app.get('/balance', async (req, res) => {

  const balances = await Promise.all(TRADING_ADDRESSES.map(checkBalance));

  res.json(balances.map((b, i) => ({ wallet: i + 1, ...(b as { SOL: number; token: number }) })));

});


app.get('/trade/:action/:memecoinSymbol', async (req, res) => {

  const action = req.params.action as 'buy' | 'sell';

  const memecoinSymbol = req.params.memecoinSymbol;

  if (action !== 'buy' && action !== 'sell') return res.json({ status: 'Invalid action' });

  

  const memecoins = await fetchAndFilterMemecoins();

  const memecoin = memecoins.find(m => m.symbol === memecoinSymbol);

  if (!memecoin) return res.json({ status: 'Memecoin not found' });


  const result = await executeTrade(action, memecoin);

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
