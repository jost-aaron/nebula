export const CLUSTER_PROTOCOL_SUPPORT = Object.freeze({ current: 1, maximum: 1, minimum: 1 });

export const classifyClusterProtocolVersion = (version) => {
  if (!Number.isSafeInteger(version) || version < 1) return "invalid";
  if (version < CLUSTER_PROTOCOL_SUPPORT.minimum) return "too-old";
  if (version > CLUSTER_PROTOCOL_SUPPORT.maximum) return "too-new";
  return version === CLUSTER_PROTOCOL_SUPPORT.current ? "current" : "compatible";
};

export const isClusterProtocolCompatible = (version) => {
  const classification = classifyClusterProtocolVersion(version);
  return classification === "current" || classification === "compatible";
};
