/**
 * brake-signer — sign a payment run as EIP-3009 pairs: one `transferWithAuthorization`
 * (valid only from payday) and its matching `cancelAuthorization` per line.
 *
 * The payment signature goes to the keeper; the cancel signature goes to the Brake
 * contract, which lets a monitor agent stop the line but never move funds.
 *
 * Works against FiatToken-v2-style tokens (EIP-3009 with cancelAuthorization).
 * Tested against tUSD8 on Aevum testnet (chain id 44005) only.
 */
import {
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type TypedDataDomain,
  bytesToHex,
  encodeAbiParameters,
  keccak256,
  toBytes,
  hashTypedData,
  parseSignature,
} from "viem";

export const AEVUM_TESTNET_CHAIN_ID = 44005;
export const TUSD8_ADDRESS: Address = "0x456569838f1d43009A91ebA4263147Afd7233483";

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export const CANCEL_AUTHORIZATION_TYPES = {
  CancelAuthorization: [
    { name: "authorizer", type: "address" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** Minimal EIP-3009 / FiatToken v2 ABI used by Brake. */
export const eip3009Abi = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "version", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "DOMAIN_SEPARATOR", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "authorizationState",
    stateMutability: "view",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "isBlacklisted",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "transferWithAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "cancelAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "AuthorizationUsed",
    inputs: [
      { name: "authorizer", type: "address", indexed: true },
      { name: "nonce", type: "bytes32", indexed: true },
    ],
  },
  {
    type: "event",
    name: "AuthorizationCanceled",
    inputs: [
      { name: "authorizer", type: "address", indexed: true },
      { name: "nonce", type: "bytes32", indexed: true },
    ],
  },
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const;

const EIP712_DOMAIN_TYPEHASH = keccak256(
  toBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
);

export interface TokenDomain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
}

export function toTypedDataDomain(d: TokenDomain): TypedDataDomain {
  return { name: d.name, version: d.version, chainId: d.chainId, verifyingContract: d.verifyingContract };
}

/**
 * Read name()/version() from the token, rebuild the EIP-712 domain and check it against the
 * token's own DOMAIN_SEPARATOR(). Throws if they differ (a mismatched domain would make every
 * signature silently invalid).
 */
export async function readTokenDomain(client: PublicClient, token: Address): Promise<TokenDomain> {
  const [name, version, separator, chainId] = await Promise.all([
    client.readContract({ address: token, abi: eip3009Abi, functionName: "name" }),
    client.readContract({ address: token, abi: eip3009Abi, functionName: "version" }),
    client.readContract({ address: token, abi: eip3009Abi, functionName: "DOMAIN_SEPARATOR" }),
    client.getChainId(),
  ]);
  const domain: TokenDomain = { name, version, chainId, verifyingContract: token };
  const rebuilt = domainSeparator(domain);
  if (rebuilt.toLowerCase() !== separator.toLowerCase()) {
    throw new Error(`EIP-712 domain mismatch: rebuilt ${rebuilt} != token ${separator} (name=${name} version=${version})`);
  }
  return domain;
}

/** EIP-712 domain separator for a token domain (name, version, chainId, verifyingContract). */
export function domainSeparator(d: TokenDomain): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [EIP712_DOMAIN_TYPEHASH, keccak256(toBytes(d.name)), keccak256(toBytes(d.version)), BigInt(d.chainId), d.verifyingContract],
    ),
  );
}

/** A fresh random 32-byte EIP-3009 nonce. */
export function randomNonce(): Hex {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return bytesToHex(b);
}

export interface Authorization {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}

export interface Sig {
  v: number;
  r: Hex;
  s: Hex;
  signature: Hex;
}

export interface SignedPair {
  authorization: Authorization;
  /** goes to the keeper — usable only inside (validAfter, validBefore) */
  payment: Sig;
  /** goes to the Brake contract — the agent's only power over this line */
  cancel: Sig;
  paymentDigest: Hex;
  cancelDigest: Hex;
}

function split(signature: Hex): Sig {
  const p = parseSignature(signature);
  const v = p.v !== undefined ? Number(p.v) : (p.yParity ?? 0) + 27;
  return { v, r: p.r, s: p.s, signature };
}

type SigningAccount = Account & { signTypedData: NonNullable<Account["signTypedData"]> };

function requireSigner(account: Account): SigningAccount {
  if (!account.signTypedData) throw new Error("account cannot sign typed data locally");
  return account as SigningAccount;
}

export async function signTransferAuthorization(account: Account, domain: TokenDomain, a: Authorization): Promise<Sig> {
  if (a.from.toLowerCase() !== account.address.toLowerCase()) throw new Error("authorization.from must be the signer");
  if (a.validBefore <= a.validAfter) throw new Error("validBefore must be after validAfter");
  const sig = await requireSigner(account).signTypedData({
    domain: toTypedDataDomain(domain),
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: a,
  });
  return split(sig);
}

export async function signCancelAuthorization(account: Account, domain: TokenDomain, nonce: Hex): Promise<Sig> {
  const sig = await requireSigner(account).signTypedData({
    domain: toTypedDataDomain(domain),
    types: CANCEL_AUTHORIZATION_TYPES,
    primaryType: "CancelAuthorization",
    message: { authorizer: account.address, nonce },
  });
  return split(sig);
}

export function transferDigest(domain: TokenDomain, a: Authorization): Hex {
  return hashTypedData({
    domain: toTypedDataDomain(domain),
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: a,
  });
}

export function cancelDigest(domain: TokenDomain, authorizer: Address, nonce: Hex): Hex {
  return hashTypedData({
    domain: toTypedDataDomain(domain),
    types: CANCEL_AUTHORIZATION_TYPES,
    primaryType: "CancelAuthorization",
    message: { authorizer, nonce },
  });
}

/** Sign one line: the payment and the cancellation that can stop it, over the same nonce. */
export async function signPair(
  account: Account,
  domain: TokenDomain,
  line: { to: Address; value: bigint; validAfter: bigint; validBefore: bigint; nonce?: Hex },
): Promise<SignedPair> {
  const authorization: Authorization = {
    from: account.address,
    to: line.to,
    value: line.value,
    validAfter: line.validAfter,
    validBefore: line.validBefore,
    nonce: line.nonce ?? randomNonce(),
  };
  const payment = await signTransferAuthorization(account, domain, authorization);
  const cancel = await signCancelAuthorization(account, domain, authorization.nonce);
  return {
    authorization,
    payment,
    cancel,
    paymentDigest: transferDigest(domain, authorization),
    cancelDigest: cancelDigest(domain, authorization.from, authorization.nonce),
  };
}

/** Sign a whole run: every line gets a distinct nonce and its paired cancel. */
export async function signRun(
  account: Account,
  domain: TokenDomain,
  run: { validAfter: bigint; validBefore: bigint; lines: { to: Address; value: bigint }[] },
): Promise<SignedPair[]> {
  const out: SignedPair[] = [];
  const seen = new Set<string>();
  for (const l of run.lines) {
    let nonce = randomNonce();
    while (seen.has(nonce)) nonce = randomNonce();
    seen.add(nonce);
    out.push(await signPair(account, domain, { ...l, validAfter: run.validAfter, validBefore: run.validBefore, nonce }));
  }
  return out;
}
export * from "./brake.js";
