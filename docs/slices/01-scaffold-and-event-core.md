# Slice 01: Scaffold And Event Core

This slice stands up the parallel workspace, fixed-port backend services, one worker,
the canonical Mongo-backed event model, and minimal admin replay endpoints.

The current implementation goal is to prove:

- ports bind independently
- events are persisted durably
- worker retries and dead-letters failures
- control plane can query and replay events
