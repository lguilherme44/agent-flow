# Software Design Document

## Context
A booking service with no repetition support.

## Problem
Bookings cannot repeat.

## Current Behavior
One booking, one date.

## Desired Behavior
A booking may repeat weekly.

## Functional Requirements
- FR-001: A booking may repeat weekly until an end date.

## Non-Functional Requirements
- NFR-001: Generation completes within 200ms.

## Architecture
A new recurrence module beside the booking store.

## Components Affected
The booking store.

## Database Changes
None. The store is in memory.

## API Changes
One new exported function.

## Frontend Changes
None. There is no user interface.

## Domain Changes
Adds the notion of a series.

## Contracts and Interfaces
weeklyDates({ startDate, endDate }) returns an array of dates.

## Security
- SEC-001: Only the owner may cancel an occurrence.

## Observability
No logging is added.

## Migration Strategy
No migration is needed; existing bookings gain a null series id.

## Testing Strategy
Unit tests for date expansion and cancellation.

## Edge Cases
An end date before the start date is rejected.

## Risks
Date arithmetic across daylight-saving boundaries.

## Alternatives Considered
Storing a rule instead of materialised occurrences; rejected because
cancellation of a single occurrence would then need an exception list.

## Acceptance Criteria
- A weekly rule produces the expected occurrences.
