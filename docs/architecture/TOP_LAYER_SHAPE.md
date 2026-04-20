# Top Layer Shape

This workspace is being organized so shared behavior lives above the ports.

## Shared packages

- `shared-config`
  env loading, company config, port map, runtime defaults
- `shared-contracts`
  event types, workspace tools, contact/case/metrics shape contracts
- `shared-data`
  account seeds, company-aware static data, capability maps
- `shared-validation`
  request validation, payload guards, input rules
- `shared-errors`
  normalized internal/vendor error shapes
- `shared-policies`
  capabilities, role guards, audience rules
- `shared-normalizers`
  email/phone/company normalization
- `shared-models`
  shared Mongo model registry
- `shared-repositories`
  reusable Mongo query/write helpers
- `shared-auth`
  identity parsing, role/capability rules, auth middleware helpers
- `shared-integrations`
  thin vendor clients for Logics, SendGrid, and future external systems
- `shared-services`
  reusable domain services and cross-port orchestration helpers
- `shared-observability`
  logger, service health builders, topology visibility
- `shared-runtime`
  shared service bootstrap/runtime helpers
- `event-core`
  event model, worker lifecycle, retry/replay/dead-letter behavior

## App rule

Apps should mostly do:

- route registration
- auth enforcement
- request validation
- calling shared services
- shaping HTTP responses

Apps should avoid owning:

- vendor packet assembly
- Mongo query logic
- event lifecycle rules
- company env resolution
- cross-port service topology
