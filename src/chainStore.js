const { getSupabaseClient } = require("./supabase");

function hasSupabaseConfig() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function mapDbTxToApp(tx) {
  return {
    fromAddress: tx.from_address,
    toAddress: tx.to_address,
    amount: Number(tx.amount),
    timestamp: tx.timestamp,
    publicKey: tx.public_key,
    signature: tx.signature,
  };
}

async function loadBlockchainState() {
  const client = getSupabaseClient();
  if (!client) {
    return null;
  }

  const { data: blocks, error: blockError } = await client
    .from("blocks")
    .select("id, height, hash, previous_hash, nonce, timestamp, difficulty, mining_reward")
    .order("height", { ascending: true });

  if (blockError) {
    throw new Error(`Failed to load blocks: ${blockError.message}`);
  }

  if (!blocks || blocks.length === 0) {
    return null;
  }

  const blockIds = blocks.map((block) => block.id);
  const { data: txRows, error: txError } = await client
    .from("transactions")
    .select("id, block_id, tx_order, from_address, to_address, amount, timestamp, is_pending, public_key, signature")
    .in("block_id", blockIds)
    .eq("is_pending", false)
    .order("block_id", { ascending: true })
    .order("tx_order", { ascending: true });

  if (txError) {
    throw new Error(`Failed to load confirmed transactions: ${txError.message}`);
  }

  const { data: pendingRows, error: pendingError } = await client
    .from("transactions")
    .select("id, from_address, to_address, amount, timestamp, public_key, signature")
    .eq("is_pending", true)
    .order("id", { ascending: true });

  if (pendingError) {
    throw new Error(`Failed to load pending transactions: ${pendingError.message}`);
  }

  const txByBlockId = new Map();
  for (const tx of txRows || []) {
    if (!txByBlockId.has(tx.block_id)) {
      txByBlockId.set(tx.block_id, []);
    }
    txByBlockId.get(tx.block_id).push(mapDbTxToApp(tx));
  }

  const chain = blocks.map((block) => ({
    timestamp: block.timestamp,
    transactions: txByBlockId.get(block.id) || [],
    previousHash: block.previous_hash,
    nonce: Number(block.nonce),
    hash: block.hash,
  }));

  const pendingTransactions = (pendingRows || []).map((tx) => mapDbTxToApp(tx));

  return {
    chain,
    pendingTransactions,
    difficulty: Number(blocks[0].difficulty),
    miningReward: Number(blocks[0].mining_reward),
  };
}

async function seedBlockchain(blockchain) {
  await replaceBlockchainState(blockchain);
}

async function addPendingTransaction(transaction) {
  const client = getSupabaseClient();
  if (!client) {
    return;
  }

  const { error } = await client.from("transactions").insert({
    block_id: null,
    tx_order: 0,
    from_address: transaction.fromAddress,
    to_address: transaction.toAddress,
    amount: transaction.amount,
    timestamp: transaction.timestamp,
    is_pending: true,
    public_key: transaction.publicKey,
    signature: transaction.signature,
  });

  if (error) {
    throw new Error(`Failed to store pending transaction: ${error.message}`);
  }
}

async function saveMinedBlock({ block, height, difficulty, miningReward }) {
  const client = getSupabaseClient();
  if (!client) {
    return;
  }

  const txPayload = block.transactions.map((tx, index) => ({
    tx_order: index,
    from_address: tx.fromAddress,
    to_address: tx.toAddress,
    amount: tx.amount,
    timestamp: tx.timestamp,
    public_key: tx.publicKey,
    signature: tx.signature,
  }));

  const { error } = await client.rpc("append_mined_block", {
    p_height: height,
    p_hash: block.hash,
    p_previous_hash: block.previousHash,
    p_nonce: block.nonce,
    p_timestamp: block.timestamp,
    p_difficulty: difficulty,
    p_mining_reward: miningReward,
    p_transactions: txPayload,
  });

  if (error) {
    throw new Error(`Failed to store mined block atomically: ${error.message}`);
  }
}

async function replaceBlockchainState(blockchain) {
  const client = getSupabaseClient();
  if (!client) {
    return;
  }

  const { error: deleteTxError } = await client.from("transactions").delete().gte("id", 0);
  if (deleteTxError) {
    throw new Error(`Failed to reset transactions: ${deleteTxError.message}`);
  }

  const { error: deleteBlockError } = await client.from("blocks").delete().gte("id", 0);
  if (deleteBlockError) {
    throw new Error(`Failed to reset blocks: ${deleteBlockError.message}`);
  }

  const blockRows = blockchain.chain.map((block, index) => ({
    height: index,
    hash: block.hash,
    previous_hash: block.previousHash,
    nonce: block.nonce,
    timestamp: block.timestamp,
    difficulty: blockchain.difficulty,
    mining_reward: blockchain.miningReward,
  }));

  const { data: insertedBlocks, error: insertBlockError } = await client
    .from("blocks")
    .insert(blockRows)
    .select("id, height")
    .order("height", { ascending: true });

  if (insertBlockError) {
    throw new Error(`Failed to insert blocks: ${insertBlockError.message}`);
  }

  const idByHeight = new Map((insertedBlocks || []).map((row) => [row.height, row.id]));
  const txRows = [];

  blockchain.chain.forEach((block, height) => {
    const blockId = idByHeight.get(height);
    for (let i = 0; i < block.transactions.length; i += 1) {
      const tx = block.transactions[i];
      txRows.push({
        block_id: blockId,
        tx_order: i,
        from_address: tx.fromAddress,
        to_address: tx.toAddress,
        amount: tx.amount,
        timestamp: tx.timestamp,
        is_pending: false,
        public_key: tx.publicKey,
        signature: tx.signature,
      });
    }
  });

  blockchain.pendingTransactions.forEach((tx) => {
    txRows.push({
      block_id: null,
      tx_order: 0,
      from_address: tx.fromAddress,
      to_address: tx.toAddress,
      amount: tx.amount,
      timestamp: tx.timestamp,
      is_pending: true,
      public_key: tx.publicKey,
      signature: tx.signature,
    });
  });

  if (txRows.length > 0) {
    const { error: insertTxError } = await client.from("transactions").insert(txRows);
    if (insertTxError) {
      throw new Error(`Failed to insert transactions: ${insertTxError.message}`);
    }
  }
}

module.exports = {
  hasSupabaseConfig,
  loadBlockchainState,
  seedBlockchain,
  addPendingTransaction,
  saveMinedBlock,
  replaceBlockchainState,
};
