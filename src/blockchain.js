const crypto = require("crypto");

class Block {
  constructor(timestamp, transactions, previousHash = "") {
    this.timestamp = timestamp;
    this.transactions = transactions;
    this.previousHash = previousHash;
    this.nonce = 0;
    this.hash = this.calculateHash();
  }

  calculateHash() {
    return crypto
      .createHash("sha256")
      .update(
        `${this.previousHash}${this.timestamp}${JSON.stringify(
          this.transactions
        )}${this.nonce}`
      )
      .digest("hex");
  }

  mineBlock(difficulty) {
    const target = "0".repeat(difficulty);
    while (!this.hash.startsWith(target)) {
      this.nonce += 1;
      this.hash = this.calculateHash();
    }
  }

  static fromObject(data) {
    const block = new Block(
      data.timestamp,
      Array.isArray(data.transactions) ? data.transactions : [],
      data.previousHash || ""
    );
    block.nonce = Number.isInteger(data.nonce) ? data.nonce : Number(data.nonce) || 0;
    block.hash = typeof data.hash === "string" ? data.hash : block.calculateHash();
    return block;
  }
}

class Blockchain {
  constructor({ difficulty = 3, miningReward = 100 } = {}) {
    this.chain = [this.createGenesisBlock()];
    this.difficulty = difficulty;
    this.pendingTransactions = [];
    this.miningReward = miningReward;
  }

  static deriveAddressFromPublicKey(publicKey) {
    return crypto.createHash("sha256").update(publicKey).digest("hex");
  }

  static buildTransactionPayload(transaction) {
    return JSON.stringify({
      fromAddress: transaction.fromAddress,
      toAddress: transaction.toAddress,
      amount: Number(transaction.amount),
      timestamp: transaction.timestamp,
    });
  }

  static verifyTransactionSignature(transaction) {
    if (transaction.fromAddress === null) {
      return true;
    }

    if (!transaction.publicKey || !transaction.signature) {
      return false;
    }

    const expectedAddress = Blockchain.deriveAddressFromPublicKey(transaction.publicKey);
    if (expectedAddress !== transaction.fromAddress) {
      return false;
    }

    const payload = Blockchain.buildTransactionPayload(transaction);
    const signature = Buffer.from(transaction.signature, "base64");
    const data = Buffer.from(payload);

    try {
      if (crypto.verify(null, data, transaction.publicKey, signature)) {
        return true;
      }
    } catch {
      // Fall through to hashed verify for non-ed25519 keys.
    }

    try {
      const verifier = crypto.createVerify("SHA256");
      verifier.update(payload);
      verifier.end();
      return verifier.verify(transaction.publicKey, signature);
    } catch {
      return false;
    }
  }

  createGenesisBlock() {
    return new Block(new Date("2026-01-01").toISOString(), [], "0");
  }

  getLatestBlock() {
    return this.chain[this.chain.length - 1];
  }

  getPendingOutgoingAmount(address) {
    return this.pendingTransactions.reduce((sum, tx) => {
      if (tx.fromAddress === address) {
        return sum + tx.amount;
      }
      return sum;
    }, 0);
  }

  getSpendableBalance(address) {
    return this.getBalanceOfAddress(address) - this.getPendingOutgoingAmount(address);
  }

  addTransaction(transaction) {
    const { fromAddress, toAddress, amount, publicKey, signature } = transaction;
    const txAmount = Number(amount);
    const txTimestamp = transaction.timestamp || new Date().toISOString();

    if (!toAddress || typeof toAddress !== "string") {
      throw new Error("Transaction must include a valid toAddress.");
    }
    if (!fromAddress || typeof fromAddress !== "string") {
      throw new Error("Transaction must include a valid fromAddress.");
    }
    if (typeof txAmount !== "number" || Number.isNaN(txAmount) || txAmount <= 0) {
      throw new Error("Amount must be a number greater than 0.");
    }
    if (!Number.isFinite(new Date(txTimestamp).getTime())) {
      throw new Error("Transaction timestamp is invalid.");
    }

    const pendingTx = {
      fromAddress,
      toAddress,
      amount: txAmount,
      timestamp: txTimestamp,
      publicKey: publicKey || null,
      signature: signature || null,
    };

    if (!pendingTx.publicKey || !pendingTx.signature) {
      throw new Error("Signed transactions require publicKey and signature.");
    }
    if (!Blockchain.verifyTransactionSignature(pendingTx)) {
      throw new Error("Transaction signature is invalid.");
    }
    if (this.getSpendableBalance(pendingTx.fromAddress) < pendingTx.amount) {
      throw new Error("Insufficient balance for this transaction.");
    }

    this.pendingTransactions.push(pendingTx);
    return pendingTx;
  }

  minePendingTransactions(minerAddress) {
    if (!minerAddress || typeof minerAddress !== "string") {
      throw new Error("Miner address is required.");
    }

    const rewardTransaction = {
      fromAddress: null,
      toAddress: minerAddress,
      amount: this.miningReward,
      timestamp: new Date().toISOString(),
      publicKey: null,
      signature: null,
    };

    const blockTransactions = [...this.pendingTransactions, rewardTransaction];
    const block = new Block(
      new Date().toISOString(),
      blockTransactions,
      this.getLatestBlock().hash
    );
    block.mineBlock(this.difficulty);
    this.chain.push(block);
    this.pendingTransactions = [];

    return block;
  }

  getBalanceOfAddress(address) {
    let balance = 0;

    for (const block of this.chain) {
      for (const tx of block.transactions) {
        if (tx.fromAddress === address) {
          balance -= tx.amount;
        }
        if (tx.toAddress === address) {
          balance += tx.amount;
        }
      }
    }

    return balance;
  }

  getCumulativeWork(chainData = null) {
    const data = chainData || this.chain;
    const minedBlockCount = Math.max(0, data.length - 1);
    return (2n ** BigInt(this.difficulty)) * BigInt(minedBlockCount);
  }

  isChainValid() {
    return this.isValidChainData(
      this.chain.map((block) => ({
        timestamp: block.timestamp,
        transactions: block.transactions,
        previousHash: block.previousHash,
        nonce: block.nonce,
        hash: block.hash,
      }))
    );
  }

  isValidChainData(chainData) {
    if (!Array.isArray(chainData) || chainData.length === 0) {
      return false;
    }

    const blocks = chainData.map((block) => Block.fromObject(block));
    const genesis = blocks[0];
    const expectedGenesis = this.createGenesisBlock();

    if (
      genesis.timestamp !== expectedGenesis.timestamp ||
      genesis.previousHash !== expectedGenesis.previousHash ||
      genesis.hash !== expectedGenesis.hash
    ) {
      return false;
    }

    const balances = new Map();

    for (let i = 1; i < blocks.length; i += 1) {
      const currentBlock = blocks[i];
      const previousBlock = blocks[i - 1];

      if (currentBlock.hash !== currentBlock.calculateHash()) {
        return false;
      }

      if (currentBlock.previousHash !== previousBlock.hash) {
        return false;
      }

      if (!currentBlock.hash.startsWith("0".repeat(this.difficulty))) {
        return false;
      }

      let rewardCount = 0;
      for (const tx of currentBlock.transactions) {
        if (!tx.toAddress || typeof tx.toAddress !== "string") {
          return false;
        }
        if (typeof tx.amount !== "number" || Number.isNaN(tx.amount) || tx.amount <= 0) {
          return false;
        }

        if (tx.fromAddress === null) {
          rewardCount += 1;
          if (tx.amount !== this.miningReward) {
            return false;
          }
        } else {
          if (!Blockchain.verifyTransactionSignature(tx)) {
            return false;
          }

          const senderBalance = balances.get(tx.fromAddress) || 0;
          if (senderBalance < tx.amount) {
            return false;
          }
          balances.set(tx.fromAddress, senderBalance - tx.amount);
        }

        const receiverBalance = balances.get(tx.toAddress) || 0;
        balances.set(tx.toAddress, receiverBalance + tx.amount);
      }

      if (rewardCount !== 1) {
        return false;
      }
    }

    return true;
  }

  replaceChain(chainData) {
    if (!Array.isArray(chainData)) {
      return false;
    }

    if (!this.isValidChainData(chainData)) {
      return false;
    }

    const remoteWork = this.getCumulativeWork(chainData);
    const localWork = this.getCumulativeWork(this.chain);

    if (remoteWork <= localWork) {
      return false;
    }

    this.chain = chainData.map((block) => Block.fromObject(block));
    this.pendingTransactions = [];
    return true;
  }

  exportState() {
    return {
      chain: this.chain.map((block) => ({
        timestamp: block.timestamp,
        transactions: block.transactions,
        previousHash: block.previousHash,
        nonce: block.nonce,
        hash: block.hash,
      })),
      pendingTransactions: this.pendingTransactions,
      difficulty: this.difficulty,
      miningReward: this.miningReward,
    };
  }

  loadState(state) {
    if (!state || !Array.isArray(state.chain) || state.chain.length === 0) {
      throw new Error("Invalid blockchain state.");
    }

    this.chain = state.chain.map((block) => Block.fromObject(block));
    this.pendingTransactions = Array.isArray(state.pendingTransactions)
      ? state.pendingTransactions
      : [];
    this.difficulty =
      Number.isInteger(state.difficulty) && state.difficulty > 0
        ? state.difficulty
        : this.difficulty;
    this.miningReward =
      Number.isFinite(state.miningReward) && state.miningReward > 0
        ? state.miningReward
        : this.miningReward;
  }
}

module.exports = { Block, Blockchain };

