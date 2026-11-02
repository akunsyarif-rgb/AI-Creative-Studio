import { describe, expect, it } from "vitest";
import { canTransitionJob, isTerminalJobStatus } from "./states";

describe("job state transitions", () => {
  it("allows queued jobs to be submitted or cancelled", () => {
    expect(canTransitionJob("queued", "submitted")).toBe(true);
    expect(canTransitionJob("queued", "cancelled")).toBe(true);
  });

  it("does not allow terminal jobs to become active again", () => {
    expect(canTransitionJob("completed", "processing")).toBe(false);
    expect(canTransitionJob("failed", "queued")).toBe(false);
    expect(isTerminalJobStatus("cancelled")).toBe(true);
  });

  it("requires validation before successful completion", () => {
    expect(canTransitionJob("processing", "completed")).toBe(false);
    expect(canTransitionJob("validating", "completed")).toBe(true);
  });
});