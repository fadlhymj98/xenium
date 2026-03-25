require("dotenv").config();
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const { Blockchain } = require("./src/blockchain");
const {
  hasSupabaseConfig,
  loadBlockchainState,
  seedBlockchain,
  addPendingTransaction,
  saveMinedBlock,
  replaceBlockchainState,
} = require("./src/chainStore");

const app = express();
app.use(cors());
app.use(express.json());

const blockchain = new Blockchain({
  difficulty: Number(process.env.DIFFICULTY || 3),
  miningReward: Number(process.env.MINING_REWARD || 100),
});

const usingSupabase = hasSupabaseConfig();
const p2pSharedSecret = process.env.P2P_SHARED_SECRET || "";
const enforceHttpsPeers = String(process.env.ENFORCE_HTTPS_PEERS || "false").toLowerCase() === "true";
const allowedPeerHosts = new Set(
  (process.env.PEER_ALLOWLIST || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
);
const rateLimitWindowMs = Number(process.env.P2P_RATE_LIMIT_WINDOW_MS || 60_000);
const rateLimitMaxRequests = Number(process.env.P2P_RATE_LIMIT_MAX || 30);

function normalizeNodeUrl(url) {
  if (!url || typeof url !== "string") {
    return null;
  }

  try {
    const parsed = new URL(url);
    if (enforceHttpsPeers && parsed.protocol !== "https:") {
      return null;
    }
    if (allowedPeerHosts.size > 0 && !allowedPeerHosts.has(parsed.hostname.toLowerCase())) {
      return null;
    }
    parsed.pathname = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function parseBigInt(value, fallback = 0n) {
  try {
    if (typeof value === "bigint") {
      return value;
    }
    if (typeof value === "number") {
      return BigInt(Math.trunc(value));
    }
    if (typeof value === "string" && value.length > 0) {
      return BigInt(value);
    }
    return fallback;
  } catch {
    return fallback;
  }
}

const peerNodes = new Set();
const initialPeers = (process.env.PEER_NODES || "")
  .split(",")
  .map((item) => normalizeNodeUrl(item.trim()))
  .filter(Boolean);
initialPeers.forEach((peer) => peerNodes.add(peer));

const selfNodeUrl = normalizeNodeUrl(process.env.SELF_NODE_URL || "");
if (selfNodeUrl) {
  peerNodes.delete(selfNodeUrl);
}

const p2pRateMap = new Map();
function p2pRateLimit(req, res, next) {
  const now = Date.now();
  const key = `${req.ip}:${req.path}`;
  const entry = p2pRateMap.get(key);

  if (!entry || now - entry.windowStart > rateLimitWindowMs) {
    p2pRateMap.set(key, { windowStart: now, count: 1 });
    return next();
  }

  if (entry.count >= rateLimitMaxRequests) {
    return res.status(429).json({ error: "Too many requests for P2P endpoint." });
  }

  entry.count += 1;
  return next();
}

function requireP2pToken(req, res, next) {
  if (!p2pSharedSecret) {
    return next();
  }

  const token = req.get("x-p2p-token");
  if (!token || token !== p2pSharedSecret) {
    return res.status(401).json({ error: "Unauthorized P2P request." });
  }

  return next();
}

app.get("/", (_req, res) => {
  res.json({
    message: "Simple blockchain API is running.",
    storage: usingSupabase ? "supabase" : "memory",
    peers: Array.from(peerNodes),
    endpoints: [
      "GET /chain",
      "GET /pending",
      "POST /transactions/new",
      "POST /mine",
      "GET /balance/:address",
      "GET /validate",
      "POST /nodes/register",
      "GET /nodes",
      "POST /sync",
      "POST /wallet/new",
    ],
  });
});

app.get("/chain", (_req, res) => {
  res.json({
    length: blockchain.chain.length,
    cumulativeWork: blockchain.getCumulativeWork().toString(),
    difficulty: blockchain.difficulty,
    miningReward: blockchain.miningReward,
    chain: blockchain.chain,
  });
});

app.get("/pending", (_req, res) => {
  res.json({
    count: blockchain.pendingTransactions.length,
    pendingTransactions: blockchain.pendingTransactions,
  });
});

app.post("/wallet/new", (_req, res) => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const address = Blockchain.deriveAddressFromPublicKey(publicKeyPem);

  res.status(201).json({
    message: "Wallet generated for testing.",
    wallet: {
      address,
      publicKey: publicKeyPem,
      privateKey: privateKeyPem,
    },
  });
});

app.post("/transactions/new", async (req, res) => {
  try {
    const { fromAddress, toAddress, amount, timestamp, publicKey, signature } = req.body;
    const pendingTx = blockchain.addTransaction({
      fromAddress,
      toAddress,
      amount: Number(amount),
      timestamp,
      publicKey,
      signature,
    });
    await addPendingTransaction(pendingTx);
    res.status(201).json({
      message: "Transaction added to pending list.",
      pendingCount: blockchain.pendingTransactions.length,
      spendableBalance:
        pendingTx.fromAddress !== null
          ? blockchain.getSpendableBalance(pendingTx.fromAddress)
          : null,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/mine", async (req, res) => {
  const pendingSnapshot = [...blockchain.pendingTransactions];

  try {
    const { minerAddress } = req.body;
    const block = blockchain.minePendingTransactions(minerAddress);
    await saveMinedBlock({
      block,
      height: blockchain.chain.length - 1,
      difficulty: blockchain.difficulty,
      miningReward: blockchain.miningReward,
    });
    res.status(201).json({
      message: "Block mined successfully.",
      block,
      chainLength: blockchain.chain.length,
      cumulativeWork: blockchain.getCumulativeWork().toString(),
      minerBalance: blockchain.getBalanceOfAddress(minerAddress),
    });
  } catch (error) {
    blockchain.chain.pop();
    blockchain.pendingTransactions = pendingSnapshot;
    res.status(400).json({ error: error.message });
  }
});

app.get("/balance/:address", (req, res) => {
  const { address } = req.params;
  const balance = blockchain.getBalanceOfAddress(address);
  const spendable = blockchain.getSpendableBalance(address);
  res.json({ address, balance, spendable });
});

app.get("/validate", (_req, res) => {
  res.json({ valid: blockchain.isChainValid() });
});

app.get("/nodes", (_req, res) => {
  res.json({ count: peerNodes.size, nodes: Array.from(peerNodes) });
});

app.post("/nodes/register", p2pRateLimit, requireP2pToken, (req, res) => {
  const { nodes } = req.body;
  if (!Array.isArray(nodes)) {
    return res.status(400).json({ error: "nodes must be an array of URLs." });
  }

  const added = [];
  for (const rawNode of nodes) {
    const node = normalizeNodeUrl(rawNode);
    if (!node) {
      continue;
    }
    if (selfNodeUrl && node === selfNodeUrl) {
      continue;
    }
    if (!peerNodes.has(node)) {
      peerNodes.add(node);
      added.push(node);
    }
  }

  return res.status(201).json({
    message: "Nodes registered.",
    added,
    total: peerNodes.size,
    nodes: Array.from(peerNodes),
  });
});

app.post("/sync", p2pRateLimit, requireP2pToken, async (_req, res) => {
  try {
    let bestChain = null;
    let bestWork = blockchain.getCumulativeWork();
    let sourceNode = null;

    for (const node of peerNodes) {
      try {
        const response = await fetch(`${node}/chain`);
        if (!response.ok) {
          continue;
        }
        const data = await response.json();
        if (!Array.isArray(data.chain)) {
          continue;
        }
        if (Number(data.difficulty) !== blockchain.difficulty) {
          continue;
        }

        const candidateWork = parseBigInt(
          data.cumulativeWork,
          blockchain.getCumulativeWork(data.chain)
        );

        if (
          candidateWork > bestWork ||
          (candidateWork === bestWork && data.chain.length > (bestChain ? bestChain.length : blockchain.chain.length))
        ) {
          bestChain = data.chain;
          bestWork = candidateWork;
          sourceNode = node;
        }
      } catch {
        // Ignore unreachable peers.
      }
    }

    if (!bestChain) {
      return res.json({
        message: "No stronger peer chain available.",
        replaced: false,
        chainLength: blockchain.chain.length,
      });
    }

    const replaced = blockchain.replaceChain(bestChain);
    if (!replaced) {
      return res.json({
        message: "Local chain remains authoritative.",
        replaced: false,
        chainLength: blockchain.chain.length,
      });
    }

    await replaceBlockchainState(blockchain);
    return res.json({
      message: "Chain replaced from peer.",
      replaced: true,
      sourceNode,
      chainLength: blockchain.chain.length,
      cumulativeWork: blockchain.getCumulativeWork().toString(),
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

async function bootstrap() {
  if (!usingSupabase) {
    return;
  }

  const state = await loadBlockchainState();
  if (state) {
    blockchain.loadState(state);
    return;
  }

  await seedBlockchain(blockchain);
}

const port = Number(process.env.PORT || 4000);
bootstrap()
  .then(() => {
    app.listen(port, () => {
      // eslint-disable-next-line no-console
      console.log(
        `Blockchain API listening on port ${port} (${usingSupabase ? "supabase" : "memory"} storage)`
      );
    });
  })
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error(`Startup failed: ${error.message}`);
    process.exit(1);
  });
