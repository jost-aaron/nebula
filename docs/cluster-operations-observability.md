# Cluster Operations Observability

Phase 5 introduces an aggregate-only cluster operations service in
`server/cluster/observability.mjs`. Cluster deployments compose it with trust,
manifest, scheduler, and delivery services. Its sanitized readiness snapshot is
available to owners and service administrators at
`/api/admin/cluster/operations`; its fixed-name metrics are appended to the
existing protected `/metrics` endpoint.

The readiness snapshot includes only fixed state counters and reason codes for
paired-node availability, manifest freshness, scheduler sessions/cooldowns,
delivery state, and bucketed clock skew. Metrics use a fixed list of names with
no labels. Neither surface includes node IDs or names, endpoints, Tailscale
identities, local item/source IDs, content paths, fingerprints, grants, tickets,
or signing keys.

Clock samples are held in a bounded in-memory ring and expose only four coarse
absolute-skew buckets. Rejected-sample audits are rate-limited, and readiness
audits are emitted only on state transitions. Both use allowlisted event types
and metadata. The service never records raw skew, request envelopes, or peer
identity.

Runtime integration injects callbacks rather than exposing internal repositories
directly:

```js
const operations = createClusterOperationsService({
  audit,
  nodesSnapshot: () => clusterTrust.listNodes(),
  manifestSnapshot: () => manifestReadinessProvider.list(),
  schedulerSnapshot: () => clusterScheduler.operationsSnapshot(),
  deliverySnapshot: () => shardDelivery.operationsSnapshot()
});
```

The shared readiness surface treats a degraded cluster as available while
preserving its bounded reason code for administrators. A hard unavailable
cluster fails readiness. Passing `operations` to `createClusterTrustService`
collects safe clock-skew diagnostics. Do not add dynamic metric labels or raw
domain records to either route.
