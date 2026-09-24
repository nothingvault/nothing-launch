// Everything that talks to the Solana blockchain lives here.
// The rest of the server only calls these functions, so tests can swap in a fake blockchain.
// The launch, split-locking and fee-collecting parts are the same code CALLR ran live on mainnet.
'use strict';
const {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  ComputeBudgetProgram, LAMPORTS_PER_SOL, VersionedTransaction, TransactionMessage, AddressLookupTableProgram, AddressLookupTableAccount
} = require('@solana/web3.js');
const BN = require('bn.js');
const bs58m = require('bs58');
const bs58 = bs58m.default || bs58m;

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const COMPUTE_BUDGET_ID = 'ComputeBudget111111111111111111111111111111';
// Phantom's safety-check program. Its instructions only read and check; they can't move money.
const LIGHTHOUSE_ID = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95';
const nacl = require('tweetnacl');
// A plain-data copy of an instruction, used to check nothing we built was changed.
// (Program, accounts in order, and data. Not the per-account flags: those can come back different after a
// transaction is packed and unpacked, and they decide nothing about where money goes.)
function ixToJson(ix) {
  return { p: ix.programId.toBase58(), k: ix.keys.map(k => k.pubkey.toBase58()), d: Buffer.from(ix.data).toString('base64') };
}
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const PRIORITY_MICROLAMPORTS = Number(process.env.PRIORITY_MICROLAMPORTS || 20000);
const MAX_PRIORITY_MICROLAMPORTS = Number(process.env.MAX_PRIORITY_MICROLAMPORTS || 1000000);
// Paid by the person launching, to the house wallet, inside the one launch approval. It covers the rent
// for the coin's fee sharing record and the network fees for the two steps the house wallet sends to lock the split.
const SPLIT_SETUP_LAMPORTS = Number(process.env.SPLIT_SETUP_LAMPORTS || 7_000_000); // 0.007 SOL
// A Solana wallet with no SOL in it can't be sent less than this (the network's minimum to keep an account open).
const RENT_MIN_LAMPORTS = 890_880;
// pump.fun's kit (version 2.0.0) sends each buy's buyback fee to one of these 8 accounts, picked at random.
// All 8 go in the launch lookup table up front, so whichever one is picked is already there.
const PUMP_BUYBACK_FEE_ACCOUNTS = [
  '5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD', '9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7',
  'GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL', '3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR',
  '5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6', 'EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL',
  '5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD', 'A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW'
];
// How many holders get paid in one transaction. Each transfer is about 50 bytes; this keeps well under the size limit.
const PAYOUTS_PER_TX = 18;
const CU_PER_TRANSFER = 450;
let currentPrice = PRIORITY_MICROLAMPORTS;

function userErr(msg) { const e = new Error(msg); e.status = 400; e.expose = true; return e; }

function keypairFromSecret(secret, label) {
  if (!secret) throw new Error(label + ' secret is missing');
  const s = secret.trim();
  try {
    if (s.startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(s)));
    return Keypair.fromSecretKey(bs58.decode(s));
  } catch (e) {
    throw new Error(label + ' secret could not be read. Use the value printed by "npm run wallets".');
  }
}

function memoIx(text, signer) {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: signer ? [{ pubkey: signer, isSigner: true, isWritable: false }] : [],
    data: Buffer.from(text, 'utf8')
  });
}
function priorityIxs(limit) {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: limit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: currentPrice })
  ];
}
// Network fee for a transaction we sign ourselves: 5,000 lamports per signature plus the tip.
function feeLamports(signatures, cuLimit) {
  return 5000 * signatures + Math.ceil(cuLimit * currentPrice / 1e6);
}
function payoutCuLimit(n) { return 20000 + n * CU_PER_TRANSFER; }

// On Cloudflare each run may only make a fixed number of outside calls. Every call to Solana goes
// through here and is counted; when the budget is spent the call fails with e.budget = true, the
// job stops cleanly, and the next minute picks up where it left off.
// counter = { limit, used, out, deadline }: shared with the database, so every outside call of any kind is
// counted. A timer run also has a deadline, so it always finishes well before the next one needs the lock.
function budgetedFetch(counter, base) {
  const f = async (...args) => {
    if ((counter.limit && counter.used >= counter.limit) || (counter.deadline && Date.now() > counter.deadline)) { counter.out = true; const e = new Error('Out of outside calls for this run; continuing next minute.'); e.budget = true; throw e; }
    counter.used++;
    // Every call gives up after 20 seconds, so one stuck call can't hold up a whole run.
    const [u, init] = args;
    const withTimeout = init && init.signal ? init : { ...(init || {}), signal: AbortSignal.timeout(20000) };
    return (base || globalThis.fetch)(u, withTimeout);
  };
  f.used = () => counter.used;
  Object.defineProperty(f, 'out', { get: () => counter.out });
  return f;
}

function budgetErr(e) { if (e && e.budget) return e; const x = new Error('Out of outside calls for this run; continuing next minute.'); x.budget = true; return x; }

function createChain(config, opts = {}) {
  const counter = opts.counter || { limit: opts.budget || 0, used: 0, out: false };
  const callFetch = budgetedFetch(counter, opts.fetchImpl);
  // web3.js sometimes rewraps errors, which drops the e.budget mark, so the flag is checked too.
  const out = (e) => (e && e.budget) || callFetch.out;
  const connection = new Connection(config.rpcUrl, { commitment: 'confirmed', fetch: callFetch, disableRetryOnRateLimit: true });
  const wallets = {
    pool: keypairFromSecret(config.poolSecret, 'POOL_WALLET'),
    house: keypairFromSecret(config.houseSecret, 'HOUSE_WALLET')
  };
  // The nothing coin's reserved address (made ahead of time). Checked against NOTHING_MINT so a mix-up can't
  // launch nothing at an address the site isn't watching.
  let reserved = null;
  try { reserved = config.nothingMintSecret ? keypairFromSecret(config.nothingMintSecret, 'NOTHING_MINT') : null; } catch (e) { console.error(e.message); }
  if (reserved && reserved.publicKey.toBase58() !== config.nothingMint) { console.error('NOTHING_MINT_SECRET does not match NOTHING_MINT: reserved launch switched off'); reserved = null; }
  let nothingCreator = null;
  try { nothingCreator = config.nothingCreatorSecret ? keypairFromSecret(config.nothingCreatorSecret, 'NOTHING_CREATOR') : null; } catch (e) { console.error(e.message); }
  // Who is listed as a coin's creator on pump.fun (and so can lock its split): nothing's own creator wallet for
  // the nothing coin, the site's wallet for every other coin.
  const creatorFor = (mint) => (nothingCreator && reserved && mint === reserved.publicKey.toBase58() ? nothingCreator : wallets.house);
  let pumpMod = null;
  function pump() { if (!pumpMod) pumpMod = require('@pump-fun/pump-sdk'); return pumpMod; }
  let online = null;
  function onlineSdk() { if (!online) online = new (pump().OnlinePumpSdk)(connection); return online; }
  // pump.fun's current settings and the first-buy math. Kept here so tests can supply them without the network.
  const hooks = {
    async globals() { return { global: await onlineSdk().fetchGlobal(), feeConfig: await onlineSdk().fetchFeeConfig() }; },
    buyAmount({ global, feeConfig, solAmount }) {
      return pump().getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: null, bondingCurve: null, amount: solAmount, quoteMint: require('@solana/spl-token').NATIVE_MINT });
    }
  };

  let priceCheckedAt = 0;
  async function refreshPrice() {
    if (Date.now() - priceCheckedAt < 20000) return;
    priceCheckedAt = Date.now();
    let est = 0;
    try {
      if (/helius/.test(config.rpcUrl)) {
        const r = await callFetch(config.rpcUrl, { signal: AbortSignal.timeout(8000), method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getPriorityFeeEstimate', params: [{ accountKeys: [SystemProgram.programId.toBase58()], options: { priorityLevel: 'High' } }] }) });
        const j = await r.json();
        est = Number(j && j.result && j.result.priorityFeeEstimate) || 0;
      }
      if (!est) {
        const fees = (await connection.getRecentPrioritizationFees()).map(f => f.prioritizationFee).filter(f => f > 0).sort((a, b) => a - b);
        if (fees.length) est = fees[Math.floor(fees.length * 0.75)];
      }
    } catch (e) { if (out(e)) throw budgetErr(e); /* keep the last price */ }
    if (est) currentPrice = Math.min(MAX_PRIORITY_MICROLAMPORTS, Math.max(PRIORITY_MICROLAMPORTS, Math.ceil(est)));
  }

  async function freshTx(feePayer) {
    await refreshPrice();
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    return new Transaction({ feePayer, blockhash, lastValidBlockHeight });
  }
  function toB64(tx) { return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'); }
  function sigOf(raw) { return bs58.encode(VersionedTransaction.deserialize(Uint8Array.from(raw)).signatures[0]); }
  async function statusOf(sig) {
    try {
      const st = (await connection.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0];
      if (!st) return { state: 'unknown' };
      if (st.err) return { state: 'failed', err: st.err };
      if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return { state: 'confirmed' };
      return { state: 'seen' };
    } catch (e) { if (out(e)) throw budgetErr(e); return { state: 'unknown', error: true }; }
  }
  async function heightNow() { try { return await connection.getBlockHeight('confirmed'); } catch (e) { if (out(e)) throw budgetErr(e); return null; } }

  // Send, then keep re-sending every 2 seconds until the network confirms it or the transaction expires.
  // Safe to call again with the same transaction: if it already landed, it just reports that.
  async function sendAndConfirmRaw(raw, blockhashInfo) {
    const sig = sigOf(raw);
    const first = await statusOf(sig);
    if (first.state === 'confirmed') return sig;
    if (first.state === 'failed') throw new Error('Transaction failed on chain: ' + JSON.stringify(first.err));
    try { await connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 0 }); }
    catch (e) {
      if (out(e)) throw budgetErr(e);
      const again = await statusOf(sig);
      if (again.state === 'confirmed') return sig;
      if (!/already been processed|AlreadyProcessed/i.test(e.message || '')) throw e;
    }
    for (;;) {
      await new Promise(r => setTimeout(r, 2000));
      const st = await statusOf(sig);
      if (st.state === 'failed') throw new Error('Transaction failed on chain: ' + JSON.stringify(st.err));
      if (st.state === 'confirmed') return sig;
      const height = await heightNow();
      if (height != null && height > blockhashInfo.lastValidBlockHeight) {
        // Past its deadline. Wait 30 more blocks for every Solana server to catch up, then ask once more.
        // Only a clear "never seen" counts as not sent; anything unclear stays open and is checked again later.
        if (height <= blockhashInfo.lastValidBlockHeight + 30) continue;
        const last = await statusOf(sig);
        if (last.state === 'confirmed') return sig;
        if (last.state === 'failed') throw new Error('Transaction failed on chain: ' + JSON.stringify(last.err));
        if (last.state === 'unknown' && !last.error) {
          const err = new Error('The network did not pick up the transaction in time (nothing was sent). Please try again.');
          err.expired = true;
          throw err;
        }
        throw new Error('Could not confirm the transaction yet. It will be checked again.');
      }
      try { await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }); } catch (e) { if (out(e)) throw budgetErr(e); /* already seen */ }
    }
  }

  // ---------- The launch lookup table ----------
  // A pump.fun launch with a first buy touches 27 accounts. At 32 bytes each, that doesn't fit in a Solana
  // transaction (1,232 bytes max). A lookup table is a short list, saved on Solana, of the accounts that are
  // the same in every launch (pump.fun's programs and settings). A transaction then points at each of them
  // with a 1-byte number instead of the full 32-byte address, and fits easily.
  // The house wallet makes the table once (about 0.002 SOL, mostly a refundable deposit) and adds to it
  // if pump.fun ever changes an account. Where it lives is remembered by opts.altStore.
  const altStore = opts.altStore || (() => { let v = null; return { get: async () => v, set: async (x) => { v = x; } }; })();
  let altCache = null; // { key, account } for this run
  async function tableAccount(address) {
    if (altCache && altCache.key === address) return altCache.account;
    const r = await connection.getAddressLookupTable(new PublicKey(address), { commitment: 'confirmed' });
    if (!r || !r.value) return null;
    altCache = { key: address, account: r.value };
    return r.value;
  }
  async function launchTable(needed) {
    const house = wallets.house;
    let saved = await altStore.get();
    let account = saved && saved.address ? await tableAccount(saved.address) : null;
    if (!account) {
      // make a new table
      const slot = await connection.getSlot('finalized');
      const [ix, address] = AddressLookupTableProgram.createLookupTable({ authority: house.publicKey, payer: house.publicKey, recentSlot: slot });
      const tx = await freshTx(house.publicKey);
      tx.add(...priorityIxs(20000), ix);
      tx.sign(house);
      await sendAndConfirmRaw(tx.serialize(), { blockhash: tx.recentBlockhash, lastValidBlockHeight: tx.lastValidBlockHeight });
      saved = { address: address.toBase58() };
      await altStore.set(saved);
      altCache = null;
      for (let i = 0; i < 10 && !account; i++) { await new Promise(r => setTimeout(r, 1200)); account = await tableAccount(saved.address); }
      if (!account) throw new Error('Launch lookup table not visible yet');
    }
    const have = new Set(account.state.addresses.map(a => a.toBase58()));
    const missing = needed.filter(a => !have.has(a));
    if (missing.length) {
      for (let i = 0; i < missing.length; i += 20) {
        const tx = await freshTx(house.publicKey);
        tx.add(...priorityIxs(20000), AddressLookupTableProgram.extendLookupTable({
          lookupTable: new PublicKey(saved.address), authority: house.publicKey, payer: house.publicKey,
          addresses: missing.slice(i, i + 20).map(a => new PublicKey(a))
        }));
        tx.sign(house);
        await sendAndConfirmRaw(tx.serialize(), { blockhash: tx.recentBlockhash, lastValidBlockHeight: tx.lastValidBlockHeight });
      }
      // Newly added accounts can be used from the next block on. Wait until Solana shows them.
      altCache = null; account = null;
      for (let i = 0; i < 12; i++) {
        await new Promise(r => setTimeout(r, 1200));
        account = await tableAccount(saved.address);
        const now = new Set(account ? account.state.addresses.map(a => a.toBase58()) : []);
        if (account && needed.every(a => now.has(a))) break;
        altCache = null; account = null;
      }
      if (!account) throw new Error('Launch lookup table is still updating. Try again in a moment.');
      await new Promise(r => setTimeout(r, 1000));
    }
    return account;
  }
  // A small lookup table just for one launch, holding the accounts that belong to that one coin (its curve, its
  // fee-split account, the buyer's coin account...). Without it, the launch (create + first buy + locking the split,
  // all in one approval) would be too big for one Solana transaction once Phantom adds its safety checks.
  // The site's wallet pays the table's deposit (about 0.004 SOL) and gets it back a few minutes later (retireTable).
  async function coinTable(addresses, record) {
    const house = wallets.house;
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const slot = await connection.getSlot('finalized');
        const [create, address] = AddressLookupTableProgram.createLookupTable({ authority: house.publicKey, payer: house.publicKey, recentSlot: slot });
        // Written down BEFORE it's sent, so its deposit is always collected later, even if this request is cut off.
        if (record) await record(address.toBase58());
        const tx = await freshTx(house.publicKey);
        tx.add(...priorityIxs(30000), create, AddressLookupTableProgram.extendLookupTable({
          lookupTable: address, authority: house.publicKey, payer: house.publicKey, addresses: addresses.map(a => new PublicKey(a))
        }));
        tx.sign(house);
        await sendAndConfirmRaw(tx.serialize(), { blockhash: tx.recentBlockhash, lastValidBlockHeight: tx.lastValidBlockHeight });
        // Usable from the next block on: wait until Solana shows every address.
        for (let i = 0; i < 12; i++) {
          await new Promise(r => setTimeout(r, i ? 1000 : 600));
          const r = await connection.getAddressLookupTable(address, { commitment: 'confirmed' });
          const have = new Set(r && r.value ? r.value.state.addresses.map(a => a.toBase58()) : []);
          if (r && r.value && addresses.every(a => have.has(a))) {
            // Wallets (Phantom) test the launch on their OWN Solana servers before showing it. A table that is only
            // seconds old may not be there yet, and then Phantom can't check the launch and blocks it. So wait until
            // the table is final (settled on every server, usually 10 to 20 seconds) before handing out the launch.
            for (let j = 0; j < 40; j++) {
              const f = await connection.getAddressLookupTable(address, { commitment: 'finalized' });
              const fin = new Set(f && f.value ? f.value.state.addresses.map(a => a.toBase58()) : []);
              if (f && f.value && addresses.every(a => fin.has(a))) { await new Promise(r2 => setTimeout(r2, 1500)); return f.value; }
              await new Promise(r2 => setTimeout(r2, 1000));
            }
            throw new Error('launch table not final yet');
          }
        }
        throw new Error('launch table not visible yet');
      } catch (e) { if (out(e)) throw e; lastErr = e; await new Promise(r => setTimeout(r, 1200)); }
    }
    throw lastErr;
  }

  // What one launch's own table costs the site wallet: the table's deposit plus the network fees of the three
  // small transactions that make, switch off and close it. The person launching pays this back in the launch.
  let rentCache = {};
  async function setupCost(addressCount) {
    const bytes = 56 + 32 * addressCount;
    if (!rentCache[bytes]) rentCache[bytes] = await connection.getMinimumBalanceForRentExemption(bytes);
    return rentCache[bytes] + feeLamports(1, 30000) + 2 * feeLamports(1, 10000) + 5000;
  }

  // The accounts that are the same in every launch: everything the launch touches except the person
  // launching, the new coin, and accounts that belong to the new coin.
  function sharedAccounts(instructions, perLaunch) {
    const out = new Set();
    for (const ix of instructions) {
      out.add(ix.programId.toBase58());
      for (const k of ix.keys) if (!k.isSigner) out.add(k.pubkey.toBase58());
    }
    for (const a of perLaunch) out.delete(a);
    return [...out];
  }

  // The old transaction format, checked the same way as before.
  async function submitLegacy(entry, signedB64, signer) {
    let tx;
    try { tx = Transaction.from(Buffer.from(signedB64, 'base64')); } catch (e) { throw userErr('The signed transaction could not be read.'); }
    const user = new PublicKey(signer);
    if (!tx.feePayer || !tx.feePayer.equals(user)) throw userErr('The transaction was changed: it is not paid by your wallet.');
    const mint = new PublicKey(entry.mint);
    const extra = [], mine = [];
    for (const ix of tx.instructions) {
      const pid = ix.programId.toBase58();
      if (pid === COMPUTE_BUDGET_ID || pid === LIGHTHOUSE_ID) {
        if (ix.keys.some(k => k.pubkey.equals(mint) && k.isSigner)) throw userErr('The transaction was changed in a way that is not allowed.');
        extra.push(ix);
      } else mine.push(ixToJson(ix));
    }
    if (JSON.stringify(mine) !== JSON.stringify(entry.core)) throw userErr('The signed transaction does not match the one prepared.');
    const userSig = tx.signatures.find(s => s.publicKey.equals(user));
    if (!userSig || !userSig.signature) throw userErr('The transaction was not signed by your wallet.');
    const msg = tx.serializeMessage();
    if (!nacl.sign.detached.verify(msg, userSig.signature, user.toBytes())) throw userErr('Your wallet\'s signature does not match the transaction.');
    const mintKp = entry.reserved ? reserved : Keypair.fromSecretKey(bs58.decode(entry.mintSecret));
    if (!mintKp || mintKp.publicKey.toBase58() !== entry.mint) throw userErr('That launch expired. Start again.');
    tx.partialSign(mintKp); // the site signs second, as Phantom asks
    if (!tx.verifySignatures()) throw userErr('The transaction is missing a signature.');
    let lastValid = entry.lastValidBlockHeight;
    if (tx.recentBlockhash !== entry.blockhash) { const h = await heightNow(); lastValid = (h || 0) + 150; }
    return sendAndConfirmRaw(tx.serialize(), { blockhash: tx.recentBlockhash, lastValidBlockHeight: lastValid });
  }

  return {
    wallets,
    addresses: { pool: wallets.pool.publicKey.toBase58(), house: wallets.house.publicKey.toBase58() },
    connection,
    hooks,
    callsUsed: () => callFetch.used(),
    outOfCalls: () => callFetch.out,
    RENT_MIN_LAMPORTS,
    PAYOUTS_PER_TX,

    reservedMint: reserved ? reserved.publicKey.toBase58() : null,
    nothingCreator: nothingCreator ? nothingCreator.publicKey.toBase58() : null,
    // Does this account exist on Solana yet? (Used to tell whether the nothing coin has been created.)
    async exists(address) { return !!(await connection.getAccountInfo(new PublicKey(address), 'confirmed')); },

    async balance(which) { return connection.getBalance(wallets[which].publicKey, 'confirmed'); },

    // SOL in each wallet (used to skip empty wallets that can't yet receive a tiny amount).
    async solBalances(addresses) {
      const out = {};
      for (let i = 0; i < addresses.length; i += 100) {
        const chunk = addresses.slice(i, i + 100);
        const infos = await connection.getMultipleAccountsInfo(chunk.map(a => new PublicKey(a)), 'confirmed');
        chunk.forEach((a, j) => { out[a] = infos[j] ? infos[j].lamports : 0; });
      }
      return out;
    },

    // Everyone holding a coin right now: { wallet: raw token amount (BigInt) }.
    // Leaves out wallets that belong to programs (pump.fun's bonding curve, trading pools, and so on),
    // because those hold coins for the market, not for a person.
    // Total number of a coin's tokens in existence (raw amount, BigInt).
    async tokenSupply(mint) {
      const r = await connection.getTokenSupply(new PublicKey(mint), 'confirmed');
      return BigInt(r.value.amount);
    },

    async holders(mint) {
      const mintPk = new PublicKey(mint);
      const out = {};
      // Helius (what the site uses) refuses the general "every account of the token program" lookup, so the
      // coin's holders are read with Helius's own paged lookup: 1,000 token accounts per call, until done.
      if (/helius/i.test(config.rpcUrl)) {
        for (let page = 1; page <= 200; page++) {
          const r = await callFetch(config.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 'h' + page, method: 'getTokenAccounts', params: { mint: mintPk.toBase58(), page, limit: 1000, displayOptions: { showZeroBalance: false } } }) });
          let j;
          try { j = await r.json(); } catch (e) { throw new Error('holder lookup: unreadable answer (' + r.status + ')'); }
          if (j.error) throw new Error('holder lookup: ' + (j.error.message || JSON.stringify(j.error)));
          const list = (j.result && j.result.token_accounts) || [];
          for (const t of list) {
            const amount = BigInt(String(t.amount == null ? 0 : t.amount).split('.')[0]);
            if (amount === 0n || !t.owner) continue;
            let ownerPk;
            try { ownerPk = new PublicKey(t.owner); } catch (e) { continue; }
            if (!PublicKey.isOnCurve(ownerPk.toBytes())) continue; // a program's account, not a person's
            out[t.owner] = (out[t.owner] || 0n) + amount;
          }
          if (list.length < 1000) return out;
        }
        throw new Error('holder lookup: more than 200,000 token accounts');
      }
      for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
        const accts = await connection.getProgramAccounts(programId, {
          commitment: 'confirmed',
          filters: [{ memcmp: { offset: 0, bytes: mintPk.toBase58() } }],
          dataSlice: { offset: 32, length: 40 } // owner (32 bytes) + amount (8 bytes)
        });
        for (const a of accts) {
          const d = a.account.data;
          if (!d || d.length < 40) continue;
          const ownerPk = new PublicKey(d.subarray(0, 32));
          const amount = Buffer.from(d.subarray(32, 40)).readBigUInt64LE(0);
          if (amount === 0n) continue;
          if (!PublicKey.isOnCurve(ownerPk.toBytes())) continue; // a program's account, not a person's
          const owner = ownerPk.toBase58();
          out[owner] = (out[owner] || 0n) + amount;
        }
      }
      return out;
    },

    // One transaction from the pool to up to 18 holders. Signed but not sent, so its signature can be saved
    // first and checked later (no double payments). The network fee is split evenly out of what each person gets.
    async buildPoolPayout(list, memo) {
      if (!list.length || list.length > PAYOUTS_PER_TX) throw new Error('Bad payout batch size');
      const from = wallets.pool;
      const tx = await freshTx(from.publicKey);
      const cu = payoutCuLimit(list.length);
      const fee = feeLamports(1, cu);
      const each = Math.ceil(fee / list.length);
      tx.add(...priorityIxs(cu));
      const lines = list.map(p => ({ to: p.to, lamports: p.lamports, sent: p.lamports - each }));
      if (lines.some(l => l.sent <= 0)) throw new Error('A payout is smaller than its share of the network fee');
      for (const l of lines) tx.add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: new PublicKey(l.to), lamports: l.sent }));
      if (memo) tx.add(memoIx(memo, from.publicKey));
      tx.sign(from);
      const raw = tx.serialize();
      return { raw: raw.toString('base64'), sig: sigOf(raw), blockhash: tx.recentBlockhash, lastValidBlockHeight: tx.lastValidBlockHeight, lines, feeLamports: each * list.length };
    },
    async sendBuilt(b) { return sendAndConfirmRaw(Buffer.from(b.raw, 'base64'), { blockhash: b.blockhash, lastValidBlockHeight: b.lastValidBlockHeight }); },
    async sigStatus(sig) { return statusOf(sig); },
    async blockHeight() { return heightNow(); },

    // Simple one-off payment from one of our wallets (used by the setup scripts). Fee comes out of the amount.
    async payFrom(which, { to, lamports }) {
      const from = wallets[which];
      const tx = await freshTx(from.publicKey);
      const cu = 20000;
      const send = lamports - feeLamports(1, cu);
      tx.add(...priorityIxs(cu), SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: new PublicKey(to), lamports: send }));
      tx.sign(from);
      return sendAndConfirmRaw(tx.serialize(), { blockhash: tx.recentBlockhash, lastValidBlockHeight: tx.lastValidBlockHeight });
    },

    // ---------- pump.fun ----------
    // One approval for the person launching: this single transaction creates the coin with a first buy
    // and pays the house wallet a small setup amount. The house wallet is listed as the coin's creator on
    // pump.fun, which lets the site lock the split by itself right after (lockSplit).
    //
    // Signing order (what Phantom asked for): the person's wallet signs FIRST, and only then does the site
    // add the new coin's own signature. A transaction that arrives already signed by someone else gets
    // flagged by Phantom's safety system, so the coin's signature is added after, in submitLaunchTx.
    // The launching wallet is the coin's creator AND makes the first buy, exactly like a coin made on pump.fun
    // itself. (If the creator isn't the wallet that buys first, pump.fun and trading sites like Axiom mark the
    // coin "Offchain".) The same transaction also locks the 70/30 split for good, signed by that wallet, so the
    // split is locked the instant the coin exists: there's no moment where it isn't.
    async buildLaunchTx({ wallet, name, symbol, uri, devBuyLamports, useReserved, split, dryRun, recordTable }) {
      const P = pump();
      const user = new PublicKey(wallet);
      if (useReserved && !reserved) throw userErr('The nothing coin address is not set up.');
      if (!split || !split.feeTo) throw userErr('The fee split is not set up.');
      const mintKp = useReserved ? reserved : Keypair.generate();
      const mint = mintKp.publicKey;
      const shares = [
        { address: wallets.pool.publicKey, shareBps: split.poolBps },
        { address: new PublicKey(split.feeTo), shareBps: split.houseBps }
      ];
      const splitIxs = async (m, u) => [
        await P.PUMP_SDK.createFeeSharingConfig({ creator: u, mint: m, pool: null }),
        await P.PUMP_SDK.updateFeeShares({ authority: u, mint: m, currentShareholders: [u], newShareholders: shares })
      ];
      // Always pay pump.fun's main fee account (any of its listed ones is accepted), so the accounts
      // used are the same every time and all fit in the lookup table.
      // Last instruction: the person pays back the site for this launch's own table (amount filled in below).
      const repay = (u, lamports) => SystemProgram.transfer({ fromPubkey: u, toPubkey: wallets.house.publicKey, lamports });
      const makeIxs = async (m, u, g) => [...await launchIxs(m, u, g), repay(u, 1)];
      const launchIxs = async (m, u, g) => {
        if (devBuyLamports > 0) {
          const solAmount = new BN(devBuyLamports);
          const amount = hooks.buyAmount({ global: g.global, feeConfig: g.feeConfig, solAmount });
          return [...await P.PUMP_SDK.createV2AndBuyInstructions({ global: g.global, mint: m, name, symbol, uri, creator: u, user: u, amount, solAmount, mayhemMode: false }), ...await splitIxs(m, u)];
        }
        return [await P.PUMP_SDK.createV2Instruction({ mint: m, name, symbol, uri, creator: u, user: u, mayhemMode: false }), ...await splitIxs(m, u)];
      };
      const g = devBuyLamports > 0 ? await hooks.globals() : null;
      if (g) g.global = { ...g.global, feeRecipients: [], reservedFeeRecipients: [] };
      const createIxs = await makeIxs(mint, user, g);
      const core = [...createIxs];
      const priority = priorityIxs(devBuyLamports > 0 ? 700000 : 500000);
      // Which accounts belong only to this launch: build the same launch for a different coin and person,
      // and anything that changed is per-launch. Everything else goes in the lookup table.
      const other = await makeIxs(Keypair.generate().publicKey, Keypair.generate().publicKey, g);
      const otherKeys = new Set(); other.forEach(ix => { otherKeys.add(ix.programId.toBase58()); ix.keys.forEach(k => otherKeys.add(k.pubkey.toBase58())); });
      const perLaunch = new Set([user.toBase58(), mint.toBase58()]);
      [...priority, ...core].forEach(ix => ix.keys.forEach(k => { const a = k.pubkey.toBase58(); if (!otherKeys.has(a)) perLaunch.add(a); }));
      if (devBuyLamports > 0) PUMP_BUYBACK_FEE_ACCOUNTS.forEach(a => perLaunch.delete(a));
      const needed = sharedAccounts([...priority, ...core], perLaunch);
      if (devBuyLamports > 0) for (const a of PUMP_BUYBACK_FEE_ACCOUNTS) if (!needed.includes(a)) needed.push(a);
      let table;
      try { table = await launchTable(needed); } catch (e) {
        if (out(e)) throw budgetErr(e);
        console.error('launch lookup table: ' + (e && e.message)); // the real reason, for the site's log
        const x = new Error('The site is finishing a one-time setup for launches. Try again in a minute.'); x.status = 503; x.expose = true; throw x;
      }
      // This coin's own accounts go in a small table made just for this launch (see coinTable).
      const programs = new Set([...priority, ...core].map(ix => ix.programId.toBase58()));
      const own = [...new Set([...priority, ...core].flatMap(ix => ix.keys.filter(k => !k.isSigner).map(k => k.pubkey.toBase58())))]
        .filter(a => perLaunch.has(a) && !programs.has(a) && a !== user.toBase58() && a !== mint.toBase58());
      // The person launching pays this table's deposit and the site's small network fees for it, inside
      // the same one approval, so the site wallet only lends the deposit for the few seconds before they
      // approve. When the table is closed a few minutes later, the deposit comes back to the site wallet.
      await refreshPrice(); // today's network fee price, so the repayment covers the site's fees
      const setupLamports = await setupCost(own.length);
      core[core.length - 1] = repay(user, setupLamports);
      let mine = null;
      if (!dryRun) try { mine = await coinTable(own, recordTable); } catch (e) {
        if (out(e)) throw budgetErr(e);
        console.error('coin lookup table: ' + (e && e.message));
        const busy = /insufficient|0x1\b|lamports/i.test(String(e && e.message));
        if (busy) console.error('SITE WALLET IS LOW: add a little SOL to ' + wallets.house.publicKey.toBase58());
        const x = new Error(busy ? 'Lots of launches right now. Try again in a few seconds.' : 'The launch could not be prepared. Try again in a moment.');
        x.status = 503; x.expose = true; throw x;
      }
      await refreshPrice();
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      const message = new TransactionMessage({ payerKey: user, recentBlockhash: blockhash, instructions: [...priority, ...core] }).compileToV0Message(mine ? [table, mine] : [table]);
      const vtx = new VersionedTransaction(message);
      return {
        mint: mint.toBase58(),
        tx: {
          b64: Buffer.from(vtx.serialize()).toString('base64'), // nobody has signed yet
          blockhash, lastValidBlockHeight,
          mint: mint.toBase58(),
          // kept on the server only, until the launch is sent. The reserved nothing address never goes in the database.
          mintSecret: useReserved ? null : bs58.encode(mintKp.secretKey),
          reserved: !!useReserved,
          table: table.key.toBase58(),
          coinTable: mine ? mine.key.toBase58() : null,
          setupLamports,
          core: core.map(ixToJson)
        }
      };
    },

    // The person's wallet signed. Their wallet is allowed to add its own safety checks (Phantom's
    // "Lighthouse" instructions) or change the priority fee, but everything the site asked for must be
    // there exactly as built. Then the site adds the coin's signature and sends it.
    async submitLaunchTx(entry, signedB64, signer) {
      let vtx;
      try { vtx = VersionedTransaction.deserialize(Buffer.from(signedB64, 'base64')); } catch (e) { throw userErr('The signed transaction could not be read.'); }
      if (vtx.version === 'legacy') return submitLegacy(entry, signedB64, signer);
      const user = new PublicKey(signer);
      const msg = vtx.message;
      if (!msg.staticAccountKeys[0] || !msg.staticAccountKeys[0].equals(user)) throw userErr('The transaction was changed: it is not paid by your wallet.');
      // Read every lookup table the transaction points at (ours, plus any a wallet added for its own checks),
      // so each instruction can be checked with its real accounts.
      const tables = [];
      for (const l of msg.addressTableLookups) {
        const t = await tableAccount(l.accountKey.toBase58()) || (await connection.getAddressLookupTable(l.accountKey, { commitment: 'confirmed' })).value;
        if (!t) throw userErr('The transaction points at something the site cannot check.');
        tables.push(t);
      }
      let decompiled;
      try { decompiled = TransactionMessage.decompile(msg, { addressLookupTableAccounts: tables }); } catch (e) { throw userErr('The signed transaction could not be read.'); }
      const mint = new PublicKey(entry.mint);
      const mine = [];
      for (const ix of decompiled.instructions) {
        const pid = ix.programId.toBase58();
        if (pid === COMPUTE_BUDGET_ID || pid === LIGHTHOUSE_ID) {
          if (ix.keys.some(k => k.pubkey.equals(mint) && k.isSigner)) throw userErr('The transaction was changed in a way that is not allowed.');
        } else mine.push(ixToJson(ix));
      }
      if (JSON.stringify(mine) !== JSON.stringify(entry.core)) throw userErr('The signed transaction does not match the one prepared.');
      const bytes = msg.serialize();
      const ui = msg.staticAccountKeys.findIndex(k => k.equals(user));
      const userSig = vtx.signatures[ui];
      if (!userSig || userSig.every(b => b === 0)) throw userErr('The transaction was not signed by your wallet.');
      if (!nacl.sign.detached.verify(bytes, userSig, user.toBytes())) throw userErr('Your wallet\'s signature does not match the transaction.');
      const mintKp = entry.reserved ? reserved : Keypair.fromSecretKey(bs58.decode(entry.mintSecret));
      if (!mintKp || mintKp.publicKey.toBase58() !== entry.mint) throw userErr('That launch expired. Start again.');
      vtx.sign([mintKp]); // the site signs second, as Phantom asks
      const need = msg.header.numRequiredSignatures;
      for (let i = 0; i < need; i++) {
        if (!nacl.sign.detached.verify(bytes, vtx.signatures[i], msg.staticAccountKeys[i].toBytes())) throw userErr('The transaction is missing a signature.');
      }
      let lastValid = entry.lastValidBlockHeight;
      if (msg.recentBlockhash !== entry.blockhash) { const h = await heightNow(); lastValid = (h || 0) + 150; }
      return sendAndConfirmRaw(Buffer.from(vtx.serialize()), { blockhash: msg.recentBlockhash, lastValidBlockHeight: lastValid });
    },

    // Open the coin's fee sharing and lock it: pool share to the pool wallet, the rest to the house wallet.
    // pump.fun only allows this once, so after it runs nobody (including you) can change it.
    // Safe to run again: it checks what's already done on the blockchain first.
    // feeTo: who gets the 30% (the nothing wallet). The site's wallet is the coin's creator on pump.fun,
    // which is what lets it set the split, but the money goes straight to feeTo.
    async lockSplit({ mint, poolBps, houseBps, feeTo }) {
      const { PUMP_SDK } = pump();
      const mintPk = new PublicKey(mint);
      const owner = creatorFor(mint);
      let cfg = await this.readSharingConfig(mint);
      // Coins launched since the split moved into the launch itself: the launching wallet is the creator and
      // locked the split in that same transaction. Nothing for the site to sign, only to check.
      const bcInfo = await connection.getAccountInfo(pump().bondingCurvePda(mintPk), 'confirmed');
      const bc = bcInfo ? PUMP_SDK.decodeBondingCurveNullable(bcInfo) : null;
      if (bc && !bc.creator.equals(owner.publicKey)) {
        for (let i = 0; i < 4 && !cfg; i++) { await new Promise(r => setTimeout(r, 1500)); cfg = await this.readSharingConfig(mint); }
        if (cfg && !cfg.editable) return { locked: true, already: true };
        throw new Error('the split was not locked in the launch transaction (creator ' + bc.creator.toBase58() + ')');
      }
      if (!cfg) {
        const tx = await freshTx(owner.publicKey);
        tx.add(...priorityIxs(200000), await PUMP_SDK.createFeeSharingConfig({ creator: owner.publicKey, mint: mintPk, pool: null }));
        tx.sign(owner);
        await sendAndConfirmRaw(tx.serialize(), { blockhash: tx.recentBlockhash, lastValidBlockHeight: tx.lastValidBlockHeight });
        for (let i = 0; i < 6 && !cfg; i++) { await new Promise(r => setTimeout(r, 1500)); cfg = await this.readSharingConfig(mint); }
        if (!cfg) throw new Error('Fee sharing account not visible yet');
      }
      if (!cfg.editable) return { locked: true, already: true };
      const ix = await PUMP_SDK.updateFeeShares({
        authority: owner.publicKey,
        mint: mintPk,
        currentShareholders: cfg.shareholders.map(s => new PublicKey(s.address)),
        newShareholders: [
          { address: wallets.pool.publicKey, shareBps: poolBps },
          { address: feeTo ? new PublicKey(feeTo) : owner.publicKey, shareBps: houseBps }
        ]
      });
      const tx = await freshTx(owner.publicKey);
      tx.add(...priorityIxs(250000), ix);
      tx.sign(owner);
      const sig = await sendAndConfirmRaw(tx.serialize(), { blockhash: tx.recentBlockhash, lastValidBlockHeight: tx.lastValidBlockHeight });
      return { locked: true, sig };
    },

    // Dry run: ask Solana to run a prepared launch WITHOUT sending it (no signatures needed, nothing happens,
    // no money moves). Used by the admin page to prove the exact launch works before anyone signs anything.
    async simulateLaunch(b64) {
      const vtx = VersionedTransaction.deserialize(Buffer.from(b64, 'base64'));
      const r = await connection.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' });
      const v = r.value || {};
      return { ok: !v.err, err: v.err ? JSON.stringify(v.err) : null, units: v.unitsConsumed || null, size: Buffer.from(b64, 'base64').length, logs: (v.logs || []).slice(-40) };
    },

    // Hand back a launch's own lookup table deposit once it is no longer needed: first switch it off, then
    // (about 4 minutes later, Solana's rule) close it. Returns what happened: 'off', 'closed', 'wait' or 'gone'.
    async retireTable(address) {
      const house = wallets.house, key = new PublicKey(address);
      const r = await connection.getAddressLookupTable(key, { commitment: 'confirmed' });
      if (!r || !r.value) return 'gone';
      const t = r.value;
      if (!t.state.authority || !t.state.authority.equals(house.publicKey)) return 'gone';
      const MAX = BigInt('18446744073709551615');
      const tx = await freshTx(house.publicKey);
      if (BigInt(t.state.deactivationSlot) === MAX) {
        tx.add(...priorityIxs(10000), AddressLookupTableProgram.deactivateLookupTable({ lookupTable: key, authority: house.publicKey }));
      } else {
        const slot = await connection.getSlot('confirmed');
        if (BigInt(slot) <= BigInt(t.state.deactivationSlot) + 520n) return 'wait';
        tx.add(...priorityIxs(10000), AddressLookupTableProgram.closeLookupTable({ lookupTable: key, authority: house.publicKey, recipient: house.publicKey }));
      }
      tx.sign(house);
      await sendAndConfirmRaw(tx.serialize(), { blockhash: tx.recentBlockhash, lastValidBlockHeight: tx.lastValidBlockHeight });
      return BigInt(t.state.deactivationSlot) === MAX ? 'off' : 'closed';
    },

    // The same, for many launch tables at once: one read for all of them, and one small transaction per 20
    // tables, so even thousands of launches get their deposits back within minutes.
    // Returns { address: 'off' | 'closed' | 'wait' | 'gone' }.
    async retireTables(addresses) {
      const house = wallets.house, MAX = BigInt('18446744073709551615');
      const result = {};
      const keys = addresses.map(a => new PublicKey(a));
      const infos = [];
      for (let i = 0; i < keys.length; i += 100) infos.push(...await connection.getMultipleAccountsInfo(keys.slice(i, i + 100), 'confirmed'));
      const slot = BigInt(await connection.getSlot('confirmed'));
      const ixs = [];
      keys.forEach((key, i) => {
        const a = addresses[i], info = infos[i];
        if (!info) { result[a] = 'gone'; return; }
        let st;
        try { st = AddressLookupTableAccount.deserialize(info.data); } catch (e) { result[a] = 'gone'; return; }
        if (!st.authority || !st.authority.equals(house.publicKey)) { result[a] = 'gone'; return; }
        if (BigInt(st.deactivationSlot) === MAX) {
          ixs.push([a, 'off', AddressLookupTableProgram.deactivateLookupTable({ lookupTable: key, authority: house.publicKey })]);
        } else if (slot > BigInt(st.deactivationSlot) + 520n) {
          ixs.push([a, 'closed', AddressLookupTableProgram.closeLookupTable({ lookupTable: key, authority: house.publicKey, recipient: house.publicKey })]);
        } else result[a] = 'wait';
      });
      for (let i = 0; i < ixs.length; i += 20) {
        const group = ixs.slice(i, i + 20);
        const tx = await freshTx(house.publicKey);
        tx.add(...priorityIxs(3000 + 1500 * group.length), ...group.map(g => g[2]));
        tx.sign(house);
        try {
          await sendAndConfirmRaw(tx.serialize(), { blockhash: tx.recentBlockhash, lastValidBlockHeight: tx.lastValidBlockHeight });
          group.forEach(g => { result[g[0]] = g[1]; });
        } catch (e) {
          if (out(e)) { group.forEach(g => { if (!result[g[0]]) result[g[0]] = 'wait'; }); result.__out = true; return result; }
          // One bad table shouldn't hold up the rest: try each on its own.
          for (const g of group) {
            try {
              const one = await freshTx(house.publicKey);
              one.add(...priorityIxs(4500), g[2]); one.sign(house);
              await sendAndConfirmRaw(one.serialize(), { blockhash: one.recentBlockhash, lastValidBlockHeight: one.lastValidBlockHeight });
              result[g[0]] = g[1];
            } catch (e2) { if (out(e2)) { result.__out = true; result[g[0]] = 'wait'; return result; } result[g[0]] = 'wait'; }
          }
        }
      }
      return result;
    },

    // Enough SOL in a wallet for a launch? (checked before the site lends a launch its table deposit)
    async walletLamports(address) { return connection.getBalance(new PublicKey(address), 'confirmed'); },

    async readSharingConfig(mint) {
      const { PUMP_SDK, feeSharingConfigPda } = pump();
      const info = await connection.getAccountInfo(feeSharingConfigPda(new PublicKey(mint)), 'confirmed');
      if (!info) return null;
      const cfg = PUMP_SDK.decodeSharingConfig(info);
      return {
        shareholders: cfg.shareholders.map(s => ({ address: s.address.toBase58(), shareBps: Number(s.shareBps) })),
        editable: pump().isSharingConfigEditable({ sharingConfig: cfg })
      };
    },

    // How close a pump.fun coin is to bonding, read from its bonding curve on Solana.
    //   progress: 0 to 1 (1 = bonded), from how many of the coins for sale on the curve have been bought
    //   mcapSol / targetMcapSol: its market cap now, and the market cap at which it bonds (in SOL)
    // pump.fun's starting numbers (the same for every coin) are passed in once and remembered.
    async bondingStatus(mint, start) {
      const P = pump();
      let st = start;
      if (!st) {
        const g = await onlineSdk().fetchGlobal();
        st = { vT: g.initialVirtualTokenReserves.toString(), vS: g.initialVirtualSolReserves.toString(), rT: g.initialRealTokenReserves.toString() };
      }
      const info = await connection.getAccountInfo(P.bondingCurvePda(new PublicKey(mint)), 'confirmed');
      const bc = info ? P.PUMP_SDK.decodeBondingCurveNullable(info) : null;
      if (!bc) return { found: false, start: st };
      const vT0 = Number(st.vT), vS0 = Number(st.vS), rT0 = Number(st.rT);
      const supply = Number(bc.tokenTotalSupply.toString()), vT = Number(bc.virtualTokenReserves.toString()), vS = Number(bc.virtualQuoteReserves.toString());
      const left = Number(bc.realTokenReserves.toString());
      const progress = bc.complete ? 1 : Math.max(0, Math.min(1, 1 - left / rT0));
      const vTend = vT0 - rT0, vSend = vS0 * vT0 / vTend;
      return {
        found: true, complete: !!bc.complete, progress,
        mcapSol: vT > 0 ? (vS * supply / vT) / 1e9 : 0,
        targetMcapSol: vTend > 0 ? (vSend * supply / vTend) / 1e9 : 0,
        start: st
      };
    },

    // Collect a coin's creator fees: pump.fun pays each share straight to its wallet.
    // The house wallet pays the small network fee (covered many times over by what each launch pays it back).
    async distribute(mint) {
      const mintPk = new PublicKey(mint);
      const min = await onlineSdk().getMinimumDistributableFee(mintPk, wallets.house.publicKey);
      if (!min || !min.canDistribute) return null;
      const distributable = Number(min.distributableFees.toString());
      // Only collect when the fee is small next to what's collected (at most about 5% of the 30% share),
      // so a busy network never makes collecting cost more than it's worth. Otherwise it waits and tries later.
      if (distributable < Math.max(config.minDistributeLamports, feeLamports(1, 300000) * 67)) return null;
      const { instructions } = await onlineSdk().buildDistributeCreatorFeesInstructions(mintPk);
      const before = await connection.getBalance(wallets.pool.publicKey, 'confirmed');
      const tx = await freshTx(wallets.house.publicKey);
      tx.add(...priorityIxs(300000), ...instructions);
      tx.sign(wallets.house);
      const sig = await sendAndConfirmRaw(tx.serialize(), { blockhash: tx.recentBlockhash, lastValidBlockHeight: tx.lastValidBlockHeight });
      const after = await connection.getBalance(wallets.pool.publicKey, 'confirmed');
      return { sig, poolLamports: Math.max(0, after - before), totalLamports: distributable };
    },

    LAMPORTS_PER_SOL
  };
}

module.exports = { ixToJson, COMPUTE_BUDGET_ID, LIGHTHOUSE_ID, SPLIT_SETUP_LAMPORTS, RENT_MIN_LAMPORTS, PAYOUTS_PER_TX, createChain, keypairFromSecret, feeLamports, payoutCuLimit };
