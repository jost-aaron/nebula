import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { validateClusterSignedEnvelope } from "./protocol.mjs";

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export const digestJsonBody = (body) => sha256(Buffer.from(body === undefined ? "" : JSON.stringify(body)));

export const generateClusterKeyPair = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateJwk = privateKey.export({ format: "jwk" });
  const publicJwk = publicKey.export({ format: "jwk" });
  return { privateJwk, publicKey: publicJwk.x };
};

export const canonicalEnvelopePayload = (envelope) => Buffer.from([
  `v=${envelope.protocolVersion}`,
  `node=${envelope.nodeId}`,
  `time=${envelope.timestamp}`,
  `nonce=${envelope.nonce}`,
  `method=${envelope.method}`,
  `path=${envelope.path}`,
  `body=${envelope.bodyDigest}`
].join("\n"));

export const signClusterEnvelope = (unsigned, privateJwk) => {
  const envelope = { ...unsigned, signature: "" };
  envelope.signature = sign(null, canonicalEnvelopePayload(envelope), createPrivateKey({ key: privateJwk, format: "jwk" })).toString("base64url");
  return validateClusterSignedEnvelope(envelope);
};

export const verifyClusterEnvelopeSignature = (envelope, publicKey) => {
  validateClusterSignedEnvelope(envelope);
  const key = createPublicKey({ key: { crv: "Ed25519", kty: "OKP", x: publicKey }, format: "jwk" });
  return verify(null, canonicalEnvelopePayload(envelope), key, Buffer.from(envelope.signature, "base64url"));
};
