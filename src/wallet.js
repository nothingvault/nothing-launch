// Browser wallet support: Phantom, Solflare, Backpack and any wallet that injects window.solana.
// Bundled into web/dist/wallet.js by scripts/build-web.js.
import { Transaction, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

function providers() {
  const w = window;
  const list = [];
  const add = (id, name, p, url) => { if (p && !list.some(x => x.provider === p)) list.push({ id, name, provider: p, url }); };
  add('phantom', 'Phantom', w.phantom && w.phantom.solana && w.phantom.solana.isPhantom ? w.phantom.solana : null);
  // Phantom only for now. Solflare and Backpack are switched off until each has been tested.
  if (!list.length && w.solana && w.solana.connect && w.solana.isPhantom && !w.solana.isSolflare && !w.solana.isBackpack) add('solana', 'Phantom', w.solana);
  return list;
}
const INSTALL = [
  { id: 'phantom', name: 'Phantom', url: 'https://phantom.com/download' }
];

let active = null;

async function connect(id) {
  const p = providers().find(x => x.id === id) || providers()[0];
  if (!p) throw new Error('No Solana wallet found in this browser.');
  const res = await p.provider.connect();
  const pk = (res && res.publicKey) || p.provider.publicKey;
  active = { id: p.id, name: p.name, provider: p.provider, address: pk.toString() };
  try { localStorage.setItem('nothing.wallet', p.id); } catch (e) { /* ignore */ }
  return active;
}
async function signMessage(text) {
  if (!active) throw new Error('Connect a wallet first.');
  const bytes = new TextEncoder().encode(text);
  const out = await active.provider.signMessage(bytes, 'utf8');
  const sig = out && out.signature ? out.signature : out;
  return bs58.encode(Uint8Array.from(sig));
}
// Launches use Solana's newer transaction format (it fits pump.fun's launch-plus-first-buy);
// anything in the old format is still handled the old way.
function decode(b64) {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const v = VersionedTransaction.deserialize(bytes);
  return v.version === 'legacy' ? Transaction.from(bytes) : v;
}
function encode(tx) {
  const bytes = tx instanceof VersionedTransaction ? tx.serialize() : tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
async function signTransaction(b64) {
  if (!active) throw new Error('Connect a wallet first.');
  const signed = await active.provider.signTransaction(decode(b64));
  return encode(signed);
}
async function signAllTransactions(list) {
  if (!active) throw new Error('Connect a wallet first.');
  const txs = list.map(decode);
  const signed = active.provider.signAllTransactions ? await active.provider.signAllTransactions(txs) : await Promise.all(txs.map(t => active.provider.signTransaction(t)));
  return signed.map(encode);
}
async function disconnect() {
  try { if (active && active.provider.disconnect) await active.provider.disconnect(); } catch (e) { /* ignore */ }
  active = null;
  try { localStorage.removeItem('nothing.wallet'); } catch (e) { /* ignore */ }
}
function remembered() { try { return localStorage.getItem('nothing.wallet'); } catch (e) { return null; } }

window.NothingWallet = { providers, INSTALL, connect, signMessage, signTransaction, signAllTransactions, disconnect, remembered, get active() { return active; } };
