# Circuit-breaker

## Definition and Purpose

### What it is

A circuit breaker protects your system from calling a service that is failing. Think of a guard on a road: if there is an accident ahead, the guard stops traffic until the road is safe again.

### How it works

* While the other service is healthy, the breaker stays out of the way and all requests pass through. In this state, the breaker is called **Closed**.
* When the service becomes unhealthy, the breaker steps in and blocks requests for a while, so callers get an immediate failure instead of waiting. In this state, the breaker is called **Open**.

### Purpose

* Fail fast instead of waiting for timeouts
* Stop one failure from spreading to other services
* Give the failing service time to recover
* Save resources like threads and connections

## Half-Open State and Probing

### Cooldown period

The "while" the breaker stays Open is called the **cooldown period**.

### Probing

When the cooldown ends, the breaker does not send all traffic back at once. It first checks whether the service has recovered, like a guard who lets one car through to test the road before reopening it. This check is called a **probe**.

To probe, the breaker lets a single request (or a small number) through and keeps blocking the rest. In this state, the breaker is called **Half-Open**.

* If the probe **succeeds**, the service has recovered. The breaker returns to **Closed** and normal traffic resumes.
* If the probe **fails**, the service is still broken. The breaker returns to **Open** and blocks requests for another cooldown period.

This cycle repeats until a probe succeeds.

## How the Breaker Detects Failure

### Counting failures

In the **Closed** state, requests pass through and the breaker watches every response. Each **service** failure increases a **failure counter**. The breaker keeps comparing this counter with a configured **failure threshold**.

#### Which failures are counted

A failed response does not always mean the service is unhealthy. The breaker must decide whether the failure was caused by the service or by something on the caller's side. Only service failures increase the failure counter.

**Counted failures (service side)**

* HTTP 5xx responses
* Connection errors
* Timeouts

**Ignored failures (caller side)**

* Client mistakes, such as HTTP 400 or 404
* Requests cancelled by our own side

When a failed response returns, the breaker checks its cause:

* If the cause is the **service**, the failure is counted.
* If the cause is the **caller**, the breaker ignores it. The counter does not change, and no decision is taken.

This keeps the breaker from tripping because of caller mistakes while the service itself is healthy.

### Tripping

When the counter reaches or exceeds the threshold, the breaker concludes that the service is unhealthy. It trips to the **Open** state and starts the cooldown period.

### While Open

Every request that arrives during the cooldown period is blocked immediately, and the breaker stays Open until the cooldown expires.

### Recovery

When the cooldown expires, the breaker moves to **Half-Open** and sends a probe, as described in the previous section.

If the probe succeeds, the failure counter is reset. This prevents old failures from piling up and wrongly blocking future requests.

## The Probe Flag

### The problem

When the breaker moves to **Half-Open**, it lets one probe request through. While that probe is still on its way and has not returned, other requests arrive and see that the road is open. They could pass too, which defeats the purpose of testing the service with a single request.

### The solution: a probe flag

The breaker puts up a sign saying "probing in progress". This sign is a boolean flag called `halfOpenProbe`.

* When the probe is sent, the breaker sets `halfOpenProbe = true`.
* While the flag is `true`, every other incoming request is rejected immediately. Callers get a quick failure instead of waiting, which keeps the "fail fast" purpose and saves threads and connections.
* When the probe returns, with success or failure, the breaker sets `halfOpenProbe = false` and decides based on the result: success returns the breaker to **Closed**, and failure returns it to **Open** for another cooldown period.

### Scope of the flag

The flag is used only in the **Half-Open** state. In **Closed** and **Open** it plays no role, because Closed lets everything through and Open already blocks everything.