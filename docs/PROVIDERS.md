# Provider Integration Contract

## Principles
The application routes by capability, not by hard-coded vendor name. A provider adapter is responsible for translating internal requests to the provider's API and normalizing the result.

## Adapter responsibilities
Each adapter should implement, where supported:
- Credential validation
- Capability/model discovery or a maintained capability manifest
- Cost estimation
- Job submission
- Job status lookup
- Cancellation
- Webhook verification
- Provider error normalization

## Capability manifest
Each model record should describe:
- Provider and model identifier
- Supported capabilities
- Accepted input types
- Output types and formats
- Duration/resolution constraints where applicable
- Async/sync behavior
- Pricing method and last verification timestamp
- Availability state and known limitations

## Selection policy
1. Check whether a local deterministic method can satisfy the request.
2. Check explicitly configured free/zero-cost models and their current availability.
3. Compare supported models against the requested capability and quality constraints.
4. Estimate cost before paid submission.
5. Require user confirmation when a paid fallback or cost threshold applies.
6. Record estimated and actual cost, including currency and source of pricing data.

A model must never be labeled free unless its current pricing and applicable limits have been verified. Free-tier availability may change.

## Normalized job lifecycle
Internal states: queued, submitted, processing, validating, completed, failed, cancelled.

Keep provider-native status separately for diagnostics. Unknown provider states must map to a safe non-success state.

## Initial integration order
1. One image provider with documented image generation and editing endpoints.
2. One video provider with documented asynchronous generation endpoints.
3. Additional providers only after contract tests and pricing review.

## Test requirements
- Valid and invalid credentials
- Successful submission
- Provider timeout
- Rate limit and quota exhaustion
- Malformed response
- Duplicate submission protection
- Status polling and webhook reconciliation
- Output download and persistence
- Cost estimation versus reported usage
