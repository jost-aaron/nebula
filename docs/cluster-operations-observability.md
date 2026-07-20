# Cluster Operations Observability

Phase 5 introduces an aggregate-only cluster operations service in
`server/cluster/observability.mjs`. It is deliberately not exposed through an
HTTP route or Settings yet; the parent integration should compose it with the
cluster trust, federation, scheduler, and delivery services.

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

Parent runtime integration should inject callbacks rather than expose internal
repositories directly:

```js
const operations = createClusterOperationsService({
  audit,
  nodesSnapshot: () => clusterTrust.listNodes(),
  manifestSnapshot: () => manifestReadinessProvider.list(),
  schedulerSnapshot: () => clusterScheduler.operationsSnapshot(),
  deliverySnapshot: () => shardDelivery.operationsSnapshot()
});
```

Pass `operations` to `createClusterTrustService` to collect safe clock-skew
diagnostics. Any future owner-only route must return the already-sanitized
snapshot and must not add dynamic labels or raw domain records.
